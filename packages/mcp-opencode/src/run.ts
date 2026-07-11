import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { JsonlParser, LineSplitter, RingBuffer, type ParsedResult } from "./parse.js";
import { extraPermissionArgs, redact } from "./policy.js";

export type Agent = "build" | "plan";
export type SettleReason = "exit" | "abort" | "timeout" | "cost-cap";

const FORCE_FINALIZE_MS = 8_000;

export interface RunOpencodeOptions {
  model: string;
  cwd: string;
  agent: Agent;
  prompt: string;
  variant?: string;
  sessionID?: string;
  timeoutSec: number;
  maxCostUsd?: number;
  /** AbortSignal from the MCP request (extra.signal). */
  signal?: AbortSignal;
  /** Called roughly every 15s while the run is in flight, with elapsed seconds
   * and a strictly increasing progress counter. Only wired up by the caller
   * when a progressToken was supplied on the request. */
  onHeartbeat?: (elapsedSec: number, progress: number) => void;
  /** Test seam: override the spawned command/args instead of invoking the
   * real `opencode` binary. Not used in production. */
  _spawnOverride?: { command: string; args: string[] };
  /** Test-only timer seams; do not change public timeout validation. */
  _timeoutMsOverride?: number;
  _forceFinalizeMsOverride?: number;
}

export interface RunOpencodeOutcome {
  reason: SettleReason;
  exitCode: number | null;
  parsed: ParsedResult;
  /** Redacted tail of stderr (up to 16KB before redaction). */
  stderrTail: string;
  elapsedSec: number;
}

export function buildArgs(opts: RunOpencodeOptions): string[] {
  const args = [
    "run",
    "-m",
    opts.model,
    "--dir",
    opts.cwd,
    "--agent",
    opts.agent,
    "--format",
    "json",
    "--print-logs",
    "--log-level",
    "ERROR",
  ];
  args.push(...extraPermissionArgs(opts.agent));
  if (opts.variant) {
    args.push("--variant", opts.variant);
  }
  if (opts.sessionID) {
    args.push("-s", opts.sessionID);
  }
  args.push(opts.prompt);
  return args;
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
  return new Promise((resolveKill) => {
    signalTree(pid, "SIGTERM");
    const killTimer = setTimeout(() => {
      signalTree(pid, "SIGKILL");
      resolveKill();
    }, 5000);
    killTimer.unref?.();
  });
}

/**
 * Spawn `opencode run ...` and resolve once the child has fully exited and
 * both stdout/stderr streams have drained. Exactly one of
 * {exit, abort, timeout, cost-cap} determines the settled `reason`; whichever
 * happens first wins and later triggers are no-ops. Streams are drained to
 * completion regardless of when the reason settles, to avoid the child
 * deadlocking on a full pipe buffer.
 */
export function runOpencode(opts: RunOpencodeOptions): Promise<RunOpencodeOutcome> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    // Honor an already-aborted request without spawning the CLI at all -- a
    // spawn-then-kill would still do brief real work (provider calls, cost).
    if (opts.signal?.aborted) {
      resolve({
        reason: "abort",
        exitCode: null,
        parsed: new JsonlParser().getResult(),
        stderrTail: "",
        elapsedSec: (Date.now() - startTime) / 1000,
      });
      return;
    }

    const command = opts._spawnOverride?.command ?? "opencode";
    const args = opts._spawnOverride?.args ?? buildArgs(opts);
    const child = spawn(command, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stderrRing = new RingBuffer();
    let reason: SettleReason | undefined;
    let exitCode: number | null = null;
    let killTriggered = false;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let heartbeatCounter = 0;
    let childExited = false;
    let stdoutClosed = false;
    let stderrClosed = false;
    let finalized = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceFinalizeTimer: NodeJS.Timeout | undefined;
    let hardFinalizeTimer: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const parser = new JsonlParser({
      maxCostUsd: opts.maxCostUsd,
      onCostCapExceeded: () => settle("cost-cap"),
    });

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
    function drainStdout() {
      if (stdoutDrained) return;
      stdoutDrained = true;
      stdoutSplitter.push(stdoutDecoder.end());
      stdoutSplitter.flush();
    }
    function drainStderr() {
      if (stderrDrained) return;
      stderrDrained = true;
      stderrRing.push(stderrDecoder.end());
    }

    function clearHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    }

    function triggerKill() {
      if (killTriggered) return;
      killTriggered = true;
      if (typeof child.pid === "number") {
        void killProcessGroup(child.pid);
      }
    }

    function settle(newReason: SettleReason) {
      if (reason !== undefined) return; // first settlement wins; later events are no-ops
      reason = newReason;
      clearHeartbeat();
      if (newReason !== "exit") {
        triggerKill();
        hardFinalizeTimer = setTimeout(() => {
          // The tree ignored the earlier group signals (or re-sessioned). Force
          // SIGKILL the direct child, stop consuming its pipes, then finalize --
          // the outcome is reported under the settle reason (timeout/abort/cost-cap),
          // not as a clean finish, so a still-dying tree is never labelled "success".
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
          maybeFinalize();
        }, opts._forceFinalizeMsOverride ?? FORCE_FINALIZE_MS);
        hardFinalizeTimer.unref?.();
      }
      maybeFinalize();
    }

    function maybeFinalize() {
      if (finalized) return;
      if (reason === undefined) return;
      if (!childExited || !stdoutClosed || !stderrClosed) return;
      finalized = true;
      clearHeartbeat();
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceFinalizeTimer) clearTimeout(forceFinalizeTimer);
      if (hardFinalizeTimer) clearTimeout(hardFinalizeTimer);
      if (abortListener) opts.signal?.removeEventListener("abort", abortListener);
      const elapsedSec = (Date.now() - startTime) / 1000;
      resolve({
        reason,
        exitCode,
        parsed: parser.getResult(),
        stderrTail: redact(stderrRing.toString()),
        elapsedSec,
      });
    }

    if (opts.onHeartbeat) {
      heartbeatTimer = setInterval(() => {
        heartbeatCounter++;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        opts.onHeartbeat!(elapsed, heartbeatCounter);
      }, 15000);
      heartbeatTimer.unref?.();
    }

    timeoutTimer = setTimeout(
      () => settle("timeout"),
      opts._timeoutMsOverride ?? opts.timeoutSec * 1000,
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
    } else {
      stdoutClosed = true;
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
    } else {
      stderrClosed = true;
    }

    child.on("exit", (code) => {
      exitCode = code;
      childExited = true;
      settle("exit");
      // Safety net: if stdio streams somehow never emit 'close' (edge case),
      // force finalize shortly after exit rather than hang forever. Only armed
      // when finalize() has not already run, so a clean exit with streams
      // already closed leaves no dangling timer.
      if (!finalized) {
        forceFinalizeTimer = setTimeout(() => {
          drainStdout();
          drainStderr();
          stdoutClosed = true;
          stderrClosed = true;
          maybeFinalize();
        }, 3000);
        forceFinalizeTimer.unref?.();
      }
      maybeFinalize();
    });

    child.on("error", (err) => {
      stderrRing.push(`\n[spawn error] ${String(err)}`);
      exitCode = exitCode ?? null;
      childExited = true;
      settle("exit");
      // On spawn failure (e.g. ENOENT) the stdio streams may never emit 'close';
      // force finalize shortly after rather than hang forever. Only armed when
      // finalize() has not already run.
      if (!finalized) {
        forceFinalizeTimer = setTimeout(() => {
          drainStdout();
          drainStderr();
          stdoutClosed = true;
          stderrClosed = true;
          maybeFinalize();
        }, 3000);
        forceFinalizeTimer.unref?.();
      }
      maybeFinalize();
    });
  });
}
