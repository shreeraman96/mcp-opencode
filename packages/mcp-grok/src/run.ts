import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

import { JsonlParser, LineSplitter, RingBuffer, STDERR_RING_CAP, type ParsedResult } from "./parse.js";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_SEC,
  MODEL_RE,
  SESSION_RE,
  boundText,
  redact,
  validateMaxTurns,
  validateTimeoutSec,
} from "./policy.js";

export type GrokRunMode = "new" | "reply";
export type SettleReason = "exit" | "abort" | "timeout";

export interface BuildArgsOptions {
  mode: GrokRunMode;
  model: string;
  cwd: string;
  sessionID: string;
  promptFile: string;
  leaderSocket: string;
  maxTurns: number;
  effort?: string;
  /**
   * Test seam. Production leaves this undefined and reads GROK_MCP_ALLOW_AUTO:
   * unset -> `--permission-mode auto`; exactly "1" -> `--always-approve`.
   */
  allowAuto?: boolean;
}

export interface RunGrokOptions {
  model: string;
  cwd: string;
  prompt: string;
  /** New sessions omit this; replies provide the original UUID. */
  sessionID?: string;
  mode?: GrokRunMode;
  effort?: string;
  maxTurns?: number;
  timeoutSec?: number;
  signal?: AbortSignal;
  onHeartbeat?: (elapsedSec: number, progress: number) => void;
  /** Test seam. Production always spawns the `grok` executable. */
  _spawnOverride?: { command: string; args?: string[]; prefixArgs?: string[] };
  /** Test-only timer seam; does not change public timeout validation. */
  _timeoutMsOverride?: number;
  /** Test-only force-finalize seam. */
  _forceFinalizeMsOverride?: number;
}

export interface RunGrokOutcome {
  reason: SettleReason;
  exitCode: number | null;
  parsed: ParsedResult;
  stderrTail: string;
  elapsedSec: number;
  /** Requested/generated ID; present even if Grok omits its end event. */
  sessionID: string;
}

// `auto` is the only non-opt-in mode that actually authorizes tool calls in a
// headless (`--prompt-file`, non-TTY) run. Grok v0.2.93 cancels the turn under
// `acceptEdits` and `dontAsk` (stopReason "Cancelled", no edits made); `auto`
// and `bypassPermissions` complete with stopReason "EndTurn". We default to the
// least-privileged of the two that works. Full bypass stays behind the explicit
// GROK_MCP_ALLOW_AUTO=1 -> `--always-approve` opt-in.
export const DEFAULT_PERMISSION_MODE = "auto" as const;
export const FORCE_FINALIZE_MS = 8_000;

export function newSessionID(): string {
  return randomUUID();
}

function validateEffort(effort: string | undefined): void {
  if (effort !== undefined && !/^[A-Za-z0-9._-]+$/.test(effort)) {
    throw new RangeError("effort must contain only letters, numbers, dots, underscores, or hyphens");
  }
}

function validateBuildArgs(opts: BuildArgsOptions): void {
  if (!MODEL_RE.test(opts.model)) {
    throw new RangeError(`invalid Grok model: ${opts.model}`);
  }
  if (!SESSION_RE.test(opts.sessionID)) {
    throw new RangeError("sessionID must be a canonical UUIDv4");
  }
  validateMaxTurns(opts.maxTurns);
  validateEffort(opts.effort);
}

/**
 * Construct Grok argv from scratch. `--prompt-file` is deliberately used by
 * itself: v0.2.93 makes it headless and rejects combining it with `--single`.
 */
export function buildArgs(opts: BuildArgsOptions): string[] {
  validateBuildArgs(opts);

  const args = [
    "--no-auto-update",
    "--cwd",
    opts.cwd,
    "--model",
    opts.model,
    "--output-format",
    "streaming-json",
    opts.mode === "reply" ? "--resume" : "--session-id",
    opts.sessionID,
    "--prompt-file",
    opts.promptFile,
  ];

  if (opts.effort !== undefined) {
    args.push("--effort", opts.effort);
  }

  // These flags are mutually exclusive. Auto approval is opt-in only.
  if (opts.allowAuto ?? process.env.GROK_MCP_ALLOW_AUTO === "1") {
    args.push("--always-approve");
  } else {
    args.push("--permission-mode", DEFAULT_PERMISSION_MODE);
  }

  args.push(
    "--max-turns",
    String(opts.maxTurns),
    "--no-memory",
    "--no-subagents",
    "--verbatim",
    "--leader-socket",
    opts.leaderSocket,
  );
  return args;
}

interface RunResources {
  directory: string;
  promptFile: string;
  leaderSocket: string;
}

async function createResources(prompt: string): Promise<RunResources> {
  const directory = await mkdtemp(path.join(tmpdir(), "mcp-grok-"));
  const promptFile = path.join(directory, "prompt.txt");
  const leaderSocket = path.join(directory, "leader.sock");
  try {
    await writeFile(promptFile, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" });
    // chmod also handles a process umask or a platform that preserves an
    // existing mode differently than expected.
    await chmod(promptFile, 0o600);
    return { directory, promptFile, leaderSocket };
  } catch (err) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

export async function cleanupResources(resources: RunResources): Promise<void> {
  await rm(resources.directory, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Signal the detached process group and, as a fallback, the direct child pid.
 * The group signal (`-pid`) reaps children that stayed in the group; the direct
 * `pid` signal covers the case where the group signal failed (EPERM) or the
 * leader re-sessioned itself. This is still best-effort: a grandchild that calls
 * setsid into its own session is unreachable by pid alone -- see the limitation
 * noted in the README security section.
 */
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

function makeParsedWithRequestedSession(parser: JsonlParser, sessionID: string): ParsedResult {
  const parsed = parser.getResult();
  return parsed.sessionID === undefined ? { ...parsed, sessionID } : parsed;
}

/**
 * Run one independent Grok CLI process with detached process-group cleanup.
 * Exit/abort/timeout use first-settlement-wins semantics; stdout and stderr
 * continue draining before the resources are removed and the promise settles.
 */
export async function runGrok(opts: RunGrokOptions): Promise<RunGrokOutcome> {
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  validateTimeoutSec(timeoutSec);
  validateMaxTurns(maxTurns);
  validateEffort(opts.effort);

  const mode = opts.mode ?? (opts.sessionID === undefined ? "new" : "reply");
  if (mode === "reply" && opts.sessionID === undefined) {
    throw new RangeError("reply mode requires a sessionID");
  }
  const sessionID = opts.sessionID ?? newSessionID();
  if (!SESSION_RE.test(sessionID)) {
    throw new RangeError("sessionID must be a canonical UUIDv4");
  }
  if (!MODEL_RE.test(opts.model)) {
    throw new RangeError(`invalid Grok model: ${opts.model}`);
  }

  const resources = await createResources(opts.prompt);
  const startTime = Date.now();

  if (opts.signal?.aborted) {
    await cleanupResources(resources);
    return {
      reason: "abort",
      exitCode: null,
      parsed: {
        sessionID,
        text: "",
        totalTextChars: 0,
        errorMessages: [],
        malformedLines: 0,
        oversizedLines: 0,
        unknownEvents: 0,
      },
      stderrTail: "",
      elapsedSec: (Date.now() - startTime) / 1000,
      sessionID,
    };
  }

  let generatedArgs: string[];
  try {
    generatedArgs = buildArgs({
      mode,
      model: opts.model,
      cwd: opts.cwd,
      sessionID,
      promptFile: resources.promptFile,
      leaderSocket: resources.leaderSocket,
      maxTurns,
      effort: opts.effort,
    });
  } catch (err) {
    await cleanupResources(resources);
    throw err;
  }
  const args =
    opts._spawnOverride?.args ?? [...(opts._spawnOverride?.prefixArgs ?? []), ...generatedArgs];
  const command = opts._spawnOverride?.command ?? "grok";

  return new Promise<RunGrokOutcome>((resolve) => {
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
            sessionID,
            text: "",
            totalTextChars: 0,
            errorMessages: [],
            malformedLines: 0,
            oversizedLines: 0,
            unknownEvents: 0,
          },
          stderrTail: redact(`[spawn error] ${String(err)}`),
          elapsedSec: (Date.now() - startTime) / 1000,
          sessionID,
        });
      });
      return;
    }

    const parser = new JsonlParser();
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

    // Hoisted so the kill-path timers can flush already-received bytes before
    // resolving, instead of dropping the last partial line/multibyte sequence.
    // StringDecoder keeps multibyte chars intact across chunk boundaries;
    // LineSplitter caps in-progress line length so a newline-less flood cannot
    // grow the heap unbounded (unlike readline).
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

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      clearTimers();
      const parsed = makeParsedWithRequestedSession(parser, sessionID);
      const finalReason = reason ?? "exit";
      const outcome: RunGrokOutcome = {
        reason: finalReason,
        exitCode,
        parsed,
        stderrTail: boundText(redact(stderrRing.toString()), STDERR_RING_CAP),
        elapsedSec: (Date.now() - startTime) / 1000,
        sessionID,
      };
      void cleanupResources(resources).finally(() => resolve(outcome));
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
          // The tree ignored the earlier group signals (or re-sessioned). Force
          // SIGKILL the direct child, stop consuming its pipes, then finalize --
          // the outcome is reported under the settle reason (timeout/abort), not
          // as a clean finish, so a still-dying tree is never labelled "success".
          try {
            child.kill("SIGKILL");
          } catch {
            // best effort
          }
          child.stdout?.destroy();
          child.stderr?.destroy();
          // Flush what we already received before tearing down the pipes.
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
      // Decode across chunk boundaries so a secret split mid-token still matches
      // redaction (a raw per-chunk toString could leave mojibake seams).
      child.stderr.on("data", (chunk: Buffer | string) =>
        stderrRing.push(typeof chunk === "string" ? chunk : stderrDecoder.write(chunk)),
      );
      child.stderr.on("close", () => {
        drainStderr();
        stderrClosed = true;
        maybeFinalize();
      });
    }

    // A closed child whose pipes have not emitted "close" yet is drained by this
    // fallback timer. Only arm it if finalize() has not already run, so a clean
    // exit with streams already closed leaves no dangling timer.
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
export { buildArgs as buildGrokArgs };
