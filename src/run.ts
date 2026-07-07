import { spawn } from "node:child_process";
import readline from "node:readline";
import { JsonlParser, RingBuffer, type ParsedResult } from "./parse.js";
import { extraPermissionArgs, redact } from "./policy.js";

export type Agent = "build" | "plan";
export type SettleReason = "exit" | "abort" | "timeout" | "cost-cap";

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

function killProcessGroup(pid: number): Promise<void> {
  return new Promise((resolveKill) => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (err: any) {
      if (err?.code !== "ESRCH") {
        // best-effort; nothing else to do
      }
    }
    const killTimer = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (err: any) {
        if (err?.code !== "ESRCH") {
          // best-effort
        }
      }
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

    const parser = new JsonlParser({
      maxCostUsd: opts.maxCostUsd,
      onCostCapExceeded: () => settle("cost-cap"),
    });

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

    timeoutTimer = setTimeout(() => settle("timeout"), opts.timeoutSec * 1000);
    timeoutTimer.unref?.();

    if (opts.signal) {
      if (opts.signal.aborted) {
        settle("abort");
      } else {
        opts.signal.addEventListener("abort", () => settle("abort"), { once: true });
      }
    }

    if (child.stdout) {
      const rl = readline.createInterface({ input: child.stdout });
      rl.on("line", (line) => parser.feedLine(line));
      rl.on("close", () => {
        stdoutClosed = true;
        maybeFinalize();
      });
    } else {
      stdoutClosed = true;
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk: Buffer) => stderrRing.push(chunk.toString("utf8")));
      child.stderr.on("close", () => {
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
      // force finalize shortly after exit rather than hang forever.
      forceFinalizeTimer = setTimeout(() => {
        stdoutClosed = true;
        stderrClosed = true;
        maybeFinalize();
      }, 3000);
      forceFinalizeTimer.unref?.();
      maybeFinalize();
    });

    child.on("error", (err) => {
      stderrRing.push(`\n[spawn error] ${String(err)}`);
      exitCode = exitCode ?? null;
      childExited = true;
      settle("exit");
      // On spawn failure (e.g. ENOENT) the stdio streams may never emit 'close';
      // force finalize shortly after rather than hang forever.
      forceFinalizeTimer = setTimeout(() => {
        stdoutClosed = true;
        stderrClosed = true;
        maybeFinalize();
      }, 3000);
      forceFinalizeTimer.unref?.();
      maybeFinalize();
    });
  });
}
