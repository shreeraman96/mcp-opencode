/**
 * Codex CLI backend: argv construction, process lifecycle, streaming JSONL
 * parsing, and error classification. Mirrors backends/grok.ts by design -- each
 * backend re-implements its own line splitting / JSONL parsing / process
 * lifecycle (the event interpretation differs but the byte-cap / truncation
 * infra is identical); the modules intentionally duplicate rather than share.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

import { createRedactor, boundText } from "../text.js";
import type { StructuredError } from "../errors.js";
import type { RunReason } from "../types.js";

export const DEFAULT_TIMEOUT_SEC = 900;
export const MIN_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 3600;

/** Codex model IDs are simple OpenAI names (e.g. "gpt-5", "o4-mini"). */
export const MODEL_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:+@/-]*[A-Za-z0-9])?$/;

/**
 * Redact credentials and sensitive local paths before returning diagnostics.
 * The secret-shaped patterns cover the generic credential forms any CLI passes
 * through, plus OpenAI `sk-`/`sk-proj-` keys (codex's provider); path folding
 * targets ~/.codex/.
 */
const CODEX_REDACTION_PATTERNS: RegExp[] = [
  // PEM private-key blocks (RSA/EC/OPENSSH/etc.) -- redact the whole block.
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
  /\b(?:sk|sk-proj)-[A-Za-z0-9_-]{8,}\b/g,
  // AWS access key IDs (AKIA/ASIA/AGPA/...) and GitHub tokens.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{12,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(Authorization\s*:\s*(?:Basic|Bearer)\s+)[^\s,;]+/gi,
  /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret)=)[^&\s]+/gi,
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi,
];

export const redact = createRedactor({
  patterns: CODEX_REDACTION_PATTERNS,
  pathRedactors: [
    {
      pattern: /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.codex\/sessions\/[^\s"')]+/g,
      replacement: "~/.codex/sessions/[REDACTED]",
    },
    {
      pattern: /(?:~|\/Users\/[^/\s]+|\/home\/[^/\s]+)\/\.codex\/(?!sessions\/)[^\s"')]+/g,
      replacement: "~/.codex/[REDACTED]",
    },
  ],
});

export function validateTimeoutSec(timeoutSec: number): void {
  if (!Number.isInteger(timeoutSec) || timeoutSec < MIN_TIMEOUT_SEC || timeoutSec > MAX_TIMEOUT_SEC) {
    throw new RangeError(`timeoutSec must be an integer from ${MIN_TIMEOUT_SEC} to ${MAX_TIMEOUT_SEC}`);
  }
}

/**
 * Structured classification (router-facing), restricted to the error-event
 * channel (stdout `type:"error"` / `turn.failed` message text + stderr tail).
 * Codex's only error surface is free text (often a JSON-encoded provider error
 * string), so this is keyword matching with provenance "inferred" -- never a
 * sole fallback trigger for the router.
 */
export function classifyCodex(diagnostic: string): StructuredError[] {
  const result: StructuredError[] = [];

  // Only a spawn-level ENOENT means the `codex` binary is missing. A bare
  // ENOENT in the diagnostic is usually a file the agent's own tooling could
  // not open, which must not be reported as "CLI not found".
  if (/spawn\s+codex\s+ENOENT|\bcommand not found:\s*codex\b|codex(?: cli)?[^\n]*not found/i.test(diagnostic)) {
    result.push({
      category: "transport",
      provenance: "spawn",
      message: "Codex CLI not found on PATH.",
    });
    return result;
  }

  if (
    /not supported when using Codex with a ChatGPT account|invalid_request_error|not logged in|unauthoriz|\b401\b|\b403\b|\b400\b|credential|api key/i.test(
      diagnostic,
    )
  ) {
    result.push({
      category: "auth",
      provenance: "inferred",
      message: "Codex authentication is unavailable.",
    });
  }

  if (/rate.?limit|too many requests|\b429\b|\b529\b|quota|usage limit|overloaded|capacity/i.test(diagnostic)) {
    result.push({
      category: "capacity",
      provenance: "inferred",
      message: "Possible capacity/rate-limit failure (advisory; Codex has no structured signal today).",
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Streaming JSONL parser
// ---------------------------------------------------------------------------

export const HEAD_CAP = 40_000;
export const TAIL_CAP = 10_000;
export const TRUNCATE_THRESHOLD = 50_000;
export const MAX_LINE_BYTES = 1_000_000;
export const STDERR_RING_CAP = 16 * 1024;
const MAX_ERROR_MESSAGES = 8;
const MAX_ERROR_CHARS = 4_000;

export interface ParsedResult {
  sessionID?: string;
  stopReason?: string;
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
      return this.head + this.tail;
    }
    const head = trimTrailingHighSurrogate(this.head);
    const tail = trimLeadingLowSurrogate(this.tail);
    const omitted = this.total - head.length - tail.length;
    return `${head}\n…[truncated ${omitted} chars]…\n${tail}`;
  }
}

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

function trimTrailingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

function trimLeadingLowSurrogate(text: string): string {
  if (text.length === 0) return text;
  const first = text.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? text.slice(1) : text;
}

/**
 * Extract the raw message string from a fatal/error event record. Codex emits
 * the human text either directly as `message` (top-level `type:"error"` and
 * `item.completed` item type `error`) or nested as `error.message`
 * (`turn.failed`); both shapes are covered.
 */
function fatalMessageText(record: Record<string, unknown>): string | undefined {
  const message = record.message;
  if (typeof message === "string" && message.length > 0) {
    return trimTrailingHighSurrogate(message.slice(0, MAX_ERROR_CHARS));
  }
  const error = record.error;
  if (typeof error === "string" && error.length > 0) {
    return trimTrailingHighSurrogate(error.slice(0, MAX_ERROR_CHARS));
  }
  if (error !== null && typeof error === "object" && !Array.isArray(error)) {
    const inner = (error as Record<string, unknown>).message;
    if (typeof inner === "string" && inner.length > 0) {
      return trimTrailingHighSurrogate(inner.slice(0, MAX_ERROR_CHARS));
    }
  }
  return undefined;
}

/**
 * Codex's fatal `message` is often a JSON-encoded string such as
 * `{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"..."}}`.
 * Best-effort parse it and surface `.error.message` + `.status`; if it is not
 * JSON, return the raw string verbatim.
 */
function extractErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const errorObj = record.error;
      let message: string | undefined;
      if (errorObj !== null && typeof errorObj === "object" && !Array.isArray(errorObj)) {
        const msg = (errorObj as Record<string, unknown>).message;
        if (typeof msg === "string") message = msg;
      }
      const status = record.status;
      if (message !== undefined) {
        return typeof status === "number" ? `${message} [HTTP ${status}]` : message;
      }
    }
  } catch {
    // not a JSON-encoded string; fall through to the raw text
  }
  return raw;
}

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
      this.dropping = true;
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
 * Incrementally parses Codex CLI `codex exec --json` JSONL events.
 *
 * Observed events (top-level `type`): `thread.started` (sessionID =
 * `thread_id`), `turn.started`, `item.started`, `item.completed` (item type
 * `agent_message` / `file_change` / `command_execution` / `error`),
 * `turn.completed` (success terminal), `turn.failed` (fatal terminal), and
 * top-level `error` (fatal). All `error` / `turn.failed` / item-error messages
 * are collected into `errorMessages`.
 *
 * The agent's AUTHORITATIVE final text is the `-o` lastMessageFile read after
 * the process exits (see runCodex); streamed `agent_message` text is kept only
 * as a fallback for runs that never write the file (kill / abort / timeout).
 */
export class StreamingJsonParser {
  private sessionID: string | undefined;
  private stopReason: string | undefined;
  private readonly textAcc = new TextAccumulator();
  private readonly errorMessages: string[] = [];
  private malformedLines = 0;
  private oversizedLines = 0;
  private unknownEvents = 0;

  noteOversizedLine(): void {
    this.oversizedLines++;
  }

  feedLine(rawLine: string): void {
    if (rawLine.length === 0) return;
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
      case "thread.started": {
        const threadID = record.thread_id;
        if (this.sessionID === undefined && typeof threadID === "string") {
          this.sessionID = threadID;
        }
        return;
      }
      case "turn.started":
        return;
      case "item.started":
        return;
      case "item.completed": {
        const item = record.item;
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          this.handleItem(item as Record<string, unknown>);
        }
        return;
      }
      case "turn.completed": {
        this.stopReason = "completed";
        return;
      }
      case "turn.failed": {
        this.stopReason = "failed";
        const text = fatalMessageText(record);
        if (text !== undefined) this.addErrorMessage(text);
        return;
      }
      case "error": {
        const text = fatalMessageText(record);
        if (text !== undefined) this.addErrorMessage(text);
        return;
      }
      default:
        this.unknownEvents++;
    }
  }

  private handleItem(item: Record<string, unknown>): void {
    switch (item.type) {
      case "agent_message":
        if (typeof item.text === "string") {
          this.textAcc.append(item.text);
        }
        return;
      case "error": {
        const text = fatalMessageText(item);
        if (text !== undefined) this.addErrorMessage(text);
        return;
      }
      case "file_change":
        return;
      case "command_execution":
        return;
      default:
        return;
    }
  }

  private addErrorMessage(raw: string): void {
    if (this.errorMessages.length >= MAX_ERROR_MESSAGES) return;
    if (raw.length === 0) return;
    const extracted = extractErrorMessage(raw);
    const sliced = trimTrailingHighSurrogate(extracted.slice(0, MAX_ERROR_CHARS));
    this.errorMessages.push(redact(sliced));
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

// ---------------------------------------------------------------------------
// Process lifecycle
// ---------------------------------------------------------------------------

export type SettleReason = Exclude<RunReason, "cost-cap">;

export interface BuildArgsOptions {
  model: string;
  cwd: string;
  lastMessageFile: string;
  prompt: string;
  images?: string[];
}

export interface RunCodexOptions {
  model: string;
  cwd: string;
  prompt: string;
  timeoutSec?: number;
  signal?: AbortSignal;
  onHeartbeat?: (elapsedSec: number, progress: number) => void;
  images?: string[];
  _spawnOverride?: { command: string; args?: string[]; prefixArgs?: string[] };
  _timeoutMsOverride?: number;
  _forceFinalizeMsOverride?: number;
}

export interface RunCodexOutcome {
  reason: SettleReason;
  exitCode: number | null;
  parsed: ParsedResult;
  stderrTail: string;
  elapsedSec: number;
  /** Codex session (thread) id observed from `thread.started`, if any. Unlike
   * grok there is no pre-generated id: codex owns the thread. */
  sessionID?: string;
}

export const FORCE_FINALIZE_MS = 8_000;

function validateBuildArgs(opts: BuildArgsOptions): void {
  if (!MODEL_RE.test(opts.model)) {
    throw new RangeError(`invalid Codex model: ${opts.model}`);
  }
}

/**
 * Build the argv for `codex exec --json --sandbox workspace-write -C <cwd>
 * -m <model> --skip-git-repo-check -o <lastMessageFile> <prompt>`, with an
 * optional `-i <file>` per attached image. The prompt is the trailing
 * positional argument.
 */
export function buildArgs(opts: BuildArgsOptions): string[] {
  validateBuildArgs(opts);

  const args = [
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-C",
    opts.cwd,
    "-m",
    opts.model,
    "--skip-git-repo-check",
    "-o",
    opts.lastMessageFile,
  ];

  if (opts.images) {
    for (const image of opts.images) {
      args.push("-i", image);
    }
  }

  args.push(opts.prompt);
  return args;
}

interface RunResources {
  directory: string;
  lastMessageFile: string;
}

async function createResources(): Promise<RunResources> {
  const directory = await mkdtemp(path.join(tmpdir(), "mcp-codex-"));
  const lastMessageFile = path.join(directory, "last-message.txt");
  return { directory, lastMessageFile };
}

export async function cleanupResources(resources: RunResources): Promise<void> {
  await rm(resources.directory, { recursive: true, force: true }).catch(() => undefined);
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, signal);
    } catch (err: any) {
      if (err?.code !== "ESRCH") {
        // Best effort; finalization still has a force timer.
      }
    }
  }
}

function killProcessGroup(pid: number): Promise<void> {
  return new Promise((resolve) => {
    signalTree(pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      signalTree(pid, "SIGKILL");
      resolve();
    }, 5_000);
    killTimer.unref?.();
  });
}

/**
 * Run one independent `codex exec` process with detached process-group
 * cleanup. Exit/abort/timeout use first-settlement-wins semantics; stdout and
 * stderr continue draining before the `-o` lastMessageFile is read and the
 * temp resources are removed and the promise settles. The lastMessageFile is
 * the AUTHORITATIVE final text; streamed agent_message text is a fallback.
 */
export async function runCodex(opts: RunCodexOptions): Promise<RunCodexOutcome> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  validateTimeoutSec(timeoutSec);

  if (!MODEL_RE.test(opts.model)) {
    throw new RangeError(`invalid Codex model: ${opts.model}`);
  }

  const resources = await createResources();
  const startTime = Date.now();

  if (opts.signal?.aborted) {
    await cleanupResources(resources);
    return {
      reason: "abort",
      exitCode: null,
      parsed: {
        text: "",
        totalTextChars: 0,
        errorMessages: [],
        malformedLines: 0,
        oversizedLines: 0,
        unknownEvents: 0,
      },
      stderrTail: "",
      elapsedSec: (Date.now() - startTime) / 1000,
    };
  }

  let generatedArgs: string[];
  try {
    generatedArgs = buildArgs({
      model: opts.model,
      cwd: opts.cwd,
      lastMessageFile: resources.lastMessageFile,
      prompt: opts.prompt,
      images: opts.images,
    });
  } catch (err) {
    await cleanupResources(resources);
    throw err;
  }
  const args =
    opts._spawnOverride?.args ?? [...(opts._spawnOverride?.prefixArgs ?? []), ...generatedArgs];
  const command = opts._spawnOverride?.command ?? "codex";

  return new Promise<RunCodexOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      void cleanupResources(resources).finally(() => {
        resolve({
          reason: "exit",
          exitCode: null,
          parsed: {
            text: "",
            totalTextChars: 0,
            errorMessages: [],
            malformedLines: 0,
            oversizedLines: 0,
            unknownEvents: 0,
          },
          stderrTail: redact(`[spawn error] ${String(err)}`),
          elapsedSec: (Date.now() - startTime) / 1000,
        });
      });
      return;
    }

    const parser = new StreamingJsonParser();
    const stderrRing = new RingBuffer(STDERR_RING_CAP);
    let reason: SettleReason | undefined;
    let exitCode: number | null = null;
    let childExited = false;
    let stdoutClosed = !child.stdout;
    let stderrClosed = !child.stderr;
    let killTriggered = false;
    let finalized = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceFinalizeTimer: NodeJS.Timeout | undefined;
    let hardFinalizeTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    let heartbeatCounter = 0;

    const stdoutDecoder = new StringDecoder("utf8");
    const stdoutSplitter = new LineSplitter(
      (line) => parser.feedLine(line),
      () => parser.noteOversizedLine(),
    );
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutDrained = false;
    let stderrDrained = false;
    const drainStdout = () => {
      if (stdoutDrained) return;
      stdoutDrained = true;
      stdoutSplitter.push(stdoutDecoder.end());
      stdoutSplitter.flush();
    };
    const drainStderr = () => {
      if (stderrDrained) return;
      stderrDrained = true;
      stderrRing.push(stderrDecoder.end());
    };

    const clearTimers = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceFinalizeTimer) clearTimeout(forceFinalizeTimer);
      if (hardFinalizeTimer) clearTimeout(hardFinalizeTimer);
      if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
      heartbeatTimer = undefined;
      timeoutTimer = undefined;
      forceFinalizeTimer = undefined;
      hardFinalizeTimer = undefined;
    };

    const triggerKill = () => {
      if (killTriggered || typeof child.pid !== "number") return;
      killTriggered = true;
      void killProcessGroup(child.pid);
    };

    // Declared before `finalize` so the reference is initialized before any
    // call site runs (finalize is invoked from settle / maybeFinalize below).
    const finalizeBody = async (finalReason: SettleReason): Promise<void> => {
      let fileText: string | undefined;
      try {
        fileText = await readFile(resources.lastMessageFile, "utf8");
      } catch {
        // lastMessageFile absent/empty (kill / abort / timeout, or codex wrote
        // nothing before failing); fall back to streamed agent_message text.
      }
      let parsed = parser.getResult();
      if (fileText !== undefined && fileText.trim().length > 0) {
        parsed = { ...parsed, text: fileText, totalTextChars: fileText.length };
      }
      const outcome: RunCodexOutcome = {
        reason: finalReason,
        exitCode,
        parsed,
        stderrTail: boundText(redact(stderrRing.toString()), STDERR_RING_CAP),
        elapsedSec: (Date.now() - startTime) / 1000,
        sessionID: parsed.sessionID,
      };
      void cleanupResources(resources).finally(() => resolve(outcome));
    };

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      clearTimers();
      void finalizeBody(reason ?? "exit");
    };

    const maybeFinalize = () => {
      if (childExited && stdoutClosed && stderrClosed) finalize();
    };

    const settle = (next: SettleReason) => {
      if (reason !== undefined) return;
      reason = next;
      if (next !== "exit") {
        triggerKill();
        hardFinalizeTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          drainStdout();
          drainStderr();
          childExited = true;
          stdoutClosed = true;
          stderrClosed = true;
          finalize();
        }, opts._forceFinalizeMsOverride ?? FORCE_FINALIZE_MS);
        hardFinalizeTimer.unref?.();
      }
      maybeFinalize();
    };

    if (opts.onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        heartbeatCounter++;
        opts.onHeartbeat?.(Math.round((Date.now() - startTime) / 1000), heartbeatCounter);
      }, 15_000);
      heartbeatTimer.unref?.();
    }

    timeoutTimer = setTimeout(
      () => settle("timeout"),
      opts._timeoutMsOverride ?? timeoutSec * 1000,
    );
    timeoutTimer.unref?.();

    if (opts.signal) {
      abortListener = () => settle("abort");
      opts.signal.addEventListener("abort", abortListener, { once: true });
    }

    if (child.stdout) {
      child.stdout.on("data", (chunk: Buffer | string) => {
        stdoutSplitter.push(typeof chunk === "string" ? chunk : stdoutDecoder.write(chunk));
      });
      child.stdout.on("close", () => {
        drainStdout();
        stdoutClosed = true;
        maybeFinalize();
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer | string) =>
        stderrRing.push(typeof chunk === "string" ? chunk : stderrDecoder.write(chunk)),
      );
      child.stderr.on("close", () => {
        drainStderr();
        stderrClosed = true;
        maybeFinalize();
      });
    }

    const armExitDrainTimer = () => {
      if (finalized) return;
      forceFinalizeTimer = setTimeout(() => {
        drainStdout();
        drainStderr();
        stdoutClosed = true;
        stderrClosed = true;
        maybeFinalize();
      }, 3_000);
      forceFinalizeTimer.unref?.();
    };

    child.on("exit", (code) => {
      exitCode = code;
      childExited = true;
      settle("exit");
      armExitDrainTimer();
      maybeFinalize();
    });

    child.on("error", (err) => {
      stderrRing.push(`\n[spawn error] ${String(err)}`);
      childExited = true;
      settle("exit");
      armExitDrainTimer();
      maybeFinalize();
    });
  });
}

/** Alias with an explicit name for callers/tests. */
export { buildArgs as buildCodexArgs };
