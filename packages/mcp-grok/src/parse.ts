import { redact } from "./policy.js";

export const HEAD_CAP = 40_000;
export const TAIL_CAP = 10_000;
export const TRUNCATE_THRESHOLD = 50_000;
export const MAX_LINE_BYTES = 1_000_000;
export const STDERR_RING_CAP = 16 * 1024;
const MAX_ERROR_MESSAGES = 8;
const MAX_ERROR_CHARS = 4_000;

export interface ParsedResult {
  /** The sessionId emitted by Grok's end event, when present. */
  sessionID?: string;
  /** The stopReason emitted by Grok's end event, when present. */
  stopReason?: string;
  /** Assistant text only. Thought and tool events are never retained. */
  text: string;
  totalTextChars: number;
  errorMessages: string[];
  malformedLines: number;
  oversizedLines: number;
  unknownEvents: number;
}

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

/** Fixed-capacity ring buffer for stderr. */
export class RingBuffer {
  private buf = "";

  constructor(private readonly cap: number = STDERR_RING_CAP) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
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

function eventSessionID(event: Record<string, unknown>): string | undefined {
  const value = event.sessionId ?? event.sessionID;
  return typeof value === "string" ? value : undefined;
}

function errorText(event: Record<string, unknown>): string | undefined {
  const candidates = [event.message, event.error, event.data];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return trimTrailingHighSurrogate(candidate.slice(0, MAX_ERROR_CHARS));
    }
  }
  return undefined;
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

/**
 * Incrementally parses Grok Build CLI `--output-format streaming-json`.
 *
 * Observed v0.2.93 events are `{type:"thought",data}`,
 * `{type:"text",data}`, and `{type:"end",stopReason,sessionId,requestId}`.
 * Thought and unknown/tool events are deliberately discarded.
 */
export class StreamingJsonParser {
  private sessionID: string | undefined;
  private stopReason: string | undefined;
  private readonly textAcc = new TextAccumulator();
  private readonly errorMessages: string[] = [];
  private malformedLines = 0;
  private oversizedLines = 0;
  private unknownEvents = 0;

  /** Record a line the upstream LineSplitter dropped for exceeding the cap. */
  noteOversizedLine(): void {
    this.oversizedLines++;
  }

  feedLine(rawLine: string): void {
    if (rawLine.length === 0) return;
    // Defense in depth: LineSplitter already caps line length, but a direct
    // feedLine caller (tests) could exceed it.
    if (Buffer.byteLength(rawLine, "utf8") > MAX_LINE_BYTES) {
      this.oversizedLines++;
      return;
    }

    let event: unknown;
    try {
      event = JSON.parse(rawLine);
    } catch {
      this.malformedLines++;
      return;
    }

    if (event === null || typeof event !== "object" || Array.isArray(event)) {
      this.malformedLines++;
      return;
    }

    const record = event as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== "string") {
      this.unknownEvents++;
      return;
    }

    switch (type) {
      case "thought":
        // Never retain or echo reasoning content.
        return;
      case "text":
        if (typeof record.data === "string") {
          this.textAcc.append(record.data);
        }
        return;
      case "end": {
        const sessionID = eventSessionID(record);
        if (this.sessionID === undefined && sessionID !== undefined) {
          this.sessionID = sessionID;
        }
        if (typeof record.stopReason === "string") {
          this.stopReason = record.stopReason;
        }
        return;
      }
      case "error": {
        const message = errorText(record);
        if (message !== undefined && this.errorMessages.length < MAX_ERROR_MESSAGES) {
          this.errorMessages.push(redact(message));
        }
        return;
      }
      default:
        this.unknownEvents++;
    }
  }

  getResult(): ParsedResult {
    return {
      sessionID: this.sessionID,
      stopReason: this.stopReason,
      text: this.textAcc.toString(),
      totalTextChars: this.textAcc.totalChars,
      errorMessages: [...this.errorMessages],
      malformedLines: this.malformedLines,
      oversizedLines: this.oversizedLines,
      unknownEvents: this.unknownEvents,
    };
  }
}

/** Short alias for callers that prefer the CLI's JSONL terminology. */
export { StreamingJsonParser as JsonlParser };
