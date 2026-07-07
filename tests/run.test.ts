import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runOpencode } from "../src/run.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "tree.mjs");

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isAlive(pid);
}

function baseOpts(overrides: Partial<Parameters<typeof runOpencode>[0]> = {}) {
  return {
    model: "opencode/big-pickle",
    cwd: process.cwd(),
    agent: "build" as const,
    prompt: "irrelevant for lifecycle tests",
    timeoutSec: 3600,
    ...overrides,
  };
}

describe("runOpencode lifecycle (fake child process tree)", () => {
  it("timeout kills the whole process group, including grandchildren", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-run-"));
    const pidFile = path.join(dir, "grandchild.pid");
    try {
      const outcome = await runOpencode(
        baseOpts({
          timeoutSec: 1,
          _spawnOverride: { command: process.execPath, args: [FIXTURE, pidFile] },
        }),
      );
      expect(outcome.reason).toBe("timeout");

      const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);
      const dead = await waitUntilDead(grandchildPid);
      expect(dead).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abort (extra.signal) kills the whole process group the same way", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-run-"));
    const pidFile = path.join(dir, "grandchild.pid");
    try {
      const controller = new AbortController();
      const runPromise = runOpencode(
        baseOpts({
          timeoutSec: 3600,
          signal: controller.signal,
          _spawnOverride: { command: process.execPath, args: [FIXTURE, pidFile] },
        }),
      );

      // Give the fixture a moment to spawn its grandchild and write the pid file.
      await new Promise((r) => setTimeout(r, 500));
      controller.abort();

      const outcome = await runPromise;
      expect(outcome.reason).toBe("abort");

      const grandchildPid = Number(readFileSync(pidFile, "utf8").trim());
      const dead = await waitUntilDead(grandchildPid);
      expect(dead).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("settles exactly once even when timeout and abort both fire close together", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oc-run-"));
    const pidFile = path.join(dir, "grandchild.pid");
    try {
      const controller = new AbortController();
      // Abort immediately (synchronously available before the process even
      // finishes spawning) so it should win the single-settle race over the
      // 1s timeout.
      controller.abort();

      const outcome = await runOpencode(
        baseOpts({
          timeoutSec: 1,
          signal: controller.signal,
          _spawnOverride: { command: process.execPath, args: [FIXTURE, pidFile] },
        }),
      );

      // Exactly one reason is reported; must be one of the valid enum values,
      // and since the signal was already aborted before spawn, it should be 'abort'.
      expect(outcome.reason).toBe("abort");
      expect(["exit", "abort", "timeout", "cost-cap"]).toContain(outcome.reason);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a normal exit with exit code 0 for a quick, well-behaved fake child", async () => {
    const outcome = await runOpencode(
      baseOpts({
        timeoutSec: 30,
        _spawnOverride: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
    );
    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBe(0);
  });
});
