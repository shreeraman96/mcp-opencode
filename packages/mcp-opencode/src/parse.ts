/**
 * Streaming JSONL parser for `opencode run --format json` output.
 *
 * Never buffers the raw stream -- callers feed it line-by-line (e.g. via
 * node:readline over child.stdout) and this module maintains only bounded,
 * incremental state.
 */

import { redact } from "./policy.js";

const HEAD_CAP = 40_000;
const TAIL_CAP = 10_000;
const TRUNCATE_THRESHOLD = 50_000;
export const MAX_LINE_BYTES = 1_000_000;
const STDERR_RING_CAP = 16 * 1024;
const MAX_ERROR_MESSAGES = 8;
const MAX_ERROR_CHARS = 4_000;

export interface StepFinishInfo {
  reason?: string;
  tokens?: unknown;
  cost?: number;
}

export interface ParsedResult {
  sessionID?: string;
  text: string;
  totalTextChars: number;
  lastStepFinish?: StepFinishInfo;
  totalCost: number;
  errorMessages: string[];
  malformedLines: number;
  oversizedLines: number;
  costCapExceeded: boolean;
}

/** Accumulates text keeping only head(40k) + tail(10k) once total exceeds 50k. */
class TextAccumulator {
  private head = "";
  private tail = "";
  private total = 0;
  private headFull = false;

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.total += chunk.length;
    if (!this.headFull) {
      const room = HEAD_CAP - this.head.length;
      if (chunk.length <= room) {
        this.head += chunk;
        return;
      }
      this.head += chunk.slice(0, room);
      this.headFull = true;
      this.tail += chunk.slice(room);
    } else {
      this.tail += chunk;
    }
    if (this.tail.length > TAIL_CAP) {
      this.tail = this.tail.slice(this.tail.length - TAIL_CAP);
    }
  }

  get totalChars(): number {
    return this.total;
  }

  toString(): string {
    if (this.total <= TRUNCATE_THRESHOLD) {
      // head+tail are contiguous slices of the same stream, so a surrogate pair
      // split across the boundary rejoins here; no trimming needed.
      return this.head + this.tail;
    }
    // The truncation marker separates head from tail, so trim any half-pair left
    // dangling at either cut to avoid emitting a lone surrogate.
    const head = trimTrailingHighSurrogate(this.head);
    const tail = trimLeadingLowSurrogate(this.tail);
    const omitted = this.total - head.length - tail.length;
    return `${head}\n…[truncated ${omitted} chars]…\n${tail}`;
  }
}

/** Fixed-capacity ring buffer for stderr; keeps only the last N bytes/chars. */
export class RingBuffer {
  private buf = "";
  constructor(private readonly cap: number = STDERR_RING_CAP) {}

  push(chunk: string): void {
    this.buf += chunk;
    if (this.buf.length > this.cap) {
      this.buf = this.buf.slice(this.buf.length - this.cap);
    }
  }

  toString(): string {
    return this.buf;
  }
}

/** Trim a lone trailing high surrogate so a slice never emits half a pair. */
function trimTrailingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

/** Trim a lone leading low surrogate (the other half dropped elsewhere). */
function trimLeadingLowSurrogate(text: string): string {
  if (text.length === 0) return text;
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

/**
 * Assembles complete lines from arbitrary decoded chunks while enforcing a hard
 * byte ceiling *during* accumulation -- unlike node:readline, which buffers a
 * newline-less line to unbounded heap before any consumer sees it. Once the
 * in-progress line crosses `maxLineBytes` with no newline, its bytes are dropped
 * and everything up to the next newline is discarded; the line is reported as
 * oversized. Peak memory is therefore ~maxLineBytes + one chunk.
 */
export class LineSplitter {
  private partial = "";
  private partialBytes = 0;
  private dropping = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOversized: () => void,
    private readonly maxLineBytes: number = MAX_LINE_BYTES,
  ) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl === -1) {
        this.buffer(chunk.slice(start));
        return;
      }
      let segment = chunk.slice(start, nl);
      if (segment.endsWith("\r")) segment = segment.slice(0, -1);
      if (this.dropping) {
        this.onOversized();
        this.reset();
      } else {
        this.onLine(this.partial + segment);
        this.reset();
      }
      start = nl + 1;
    }
  }

  /** Emit any trailing bytes with no final newline (e.g. child killed mid-line). */
  flush(): void {
    if (this.dropping) {
      this.onOversized();
      this.reset();
      return;
    }
    if (this.partial.length > 0) {
      this.onLine(this.partial);
      this.reset();
    }
  }

  private buffer(rest: string): void {
    if (this.dropping || rest.length === 0) return;
    const bytes = Buffer.byteLength(rest, "utf8");
    if (this.partialBytes + bytes > this.maxLineBytes) {
      this.dropping = true; // over cap with no newline yet; discard until next \n
      this.partial = "";
      this.partialBytes = 0;
      return;
    }
    this.partial += rest;
    this.partialBytes += bytes;
  }

  private reset(): void {
    this.partial = "";
    this.partialBytes = 0;
    this.dropping = false;
  }
}

export interface JsonlParserOptions {
  maxCostUsd?: number;
  /** Invoked exactly once, the first time accumulated cost exceeds maxCostUsd. */
  onCostCapExceeded?: () => void;
}

export class JsonlParser {
  private sessionID: string | undefined;
  private readonly textAcc = new TextAccumulator();
  private lastStepFinish: StepFinishInfo | undefined;
  private totalCost = 0;
  private readonly errorMessages: string[] = [];
  private malformedLines = 0;
  private oversizedLines = 0;
  private costCapExceeded = false;
  private costCapFired = false;

  constructor(private readonly opts: JsonlParserOptions = {}) {}

  /** Record a line the upstream LineSplitter dropped for exceeding the cap. */
  noteOversizedLine(): void {
    this.oversizedLines++;
  }

  /** Feed a single raw line (without trailing newline) from stdout. */
  feedLine(rawLine: string): void {
    if (rawLine.length === 0) return;
    // Defense in depth: LineSplitter already caps line length, but a direct
    // feedLine caller (tests) could exceed it.
    if (Buffer.byteLength(rawLine, "utf8") > MAX_LINE_BYTES) {
      this.oversizedLines++;
      return;
    }

    let event: any;
    try {
      event = JSON.parse(rawLine);
    } catch {
      this.malformedLines++;
      return;
    }

    // Arrays are typeof "object" but are not valid events; reject them (and
    // null) as malformed rather than silently ignoring protocol drift.
    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      this.malformedLines++;
      return;
    }

    {
      if (this.sessionID === undefined && typeof event.sessionID === "string") {
        this.sessionID = event.sessionID;
      }

      const type = event.type;
      const part = event.part;

      if (type === "text" && part && typeof part.text === "string") {
        this.textAcc.append(part.text);
      } else if (type === "step_finish" && part) {
        this.lastStepFinish = {
          reason: part.reason,
          tokens: part.tokens,
          cost: typeof part.cost === "number" ? part.cost : undefined,
        };
        if (typeof part.cost === "number") {
          this.totalCost += part.cost;
        }
        if (
          !this.costCapFired &&
          this.opts.maxCostUsd !== undefined &&
          this.totalCost > this.opts.maxCostUsd
        ) {
          this.costCapFired = true;
          this.costCapExceeded = true;
          this.opts.onCostCapExceeded?.();
        }
      } else if (type === "error") {
        const message =
          (part && (part.message || part.error)) ||
          event.message ||
          event.error ||
          JSON.stringify(event);
        if (this.errorMessages.length < MAX_ERROR_MESSAGES) {
          this.errorMessages.push(redact(String(message).slice(0, MAX_ERROR_CHARS)));
        }
      }
      // Other event types (step_start, tool_use/tool, etc.) are intentionally ignored.
    }
  }

  getResult(): ParsedResult {
    return {
      sessionID: this.sessionID,
      text: this.textAcc.toString(),
      totalTextChars: this.textAcc.totalChars,
      lastStepFinish: this.lastStepFinish,
      totalCost: this.totalCost,
      errorMessages: this.errorMessages,
      malformedLines: this.malformedLines,
      oversizedLines: this.oversizedLines,
      costCapExceeded: this.costCapExceeded,
    };
  }
}
