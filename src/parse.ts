/**
 * Streaming JSONL parser for `opencode run --format json` output.
 *
 * Never buffers the raw stream -- callers feed it line-by-line (e.g. via
 * node:readline over child.stdout) and this module maintains only bounded,
 * incremental state.
 */

const HEAD_CAP = 40_000;
const TAIL_CAP = 10_000;
const TRUNCATE_THRESHOLD = 50_000;
const MAX_LINE_BYTES = 1_000_000;
const STDERR_RING_CAP = 16 * 1024;

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
      return this.head + this.tail;
    }
    const omitted = this.total - this.head.length - this.tail.length;
    return `${this.head}\n…[truncated ${omitted} chars]…\n${this.tail}`;
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

  /** Feed a single raw line (without trailing newline) from stdout. */
  feedLine(rawLine: string): void {
    if (rawLine.length === 0) return;
    // Approximate byte length via UTF-16 code unit length; good enough for a cap.
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

    if (event && typeof event === "object") {
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
        this.errorMessages.push(String(message));
      }
      // Other event types (step_start, tool_use/tool, etc.) are intentionally ignored.
    } else {
      this.malformedLines++;
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
