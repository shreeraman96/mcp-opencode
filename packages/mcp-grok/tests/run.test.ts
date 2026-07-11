import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runGrok } from "../src/run.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const treeFixture = path.join(here, "fixtures", "tree.mjs");
const captureFixture = path.join(here, "fixtures", "capture.mjs");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !alive(pid);
}

function baseOptions(overrides: Partial<Parameters<typeof runGrok>[0]> = {}) {
  return {
    model: "grok-4.5",
    cwd: process.cwd(),
    prompt: "private prompt text",
    timeoutSec: 30,
    ...overrides,
  };
}

describe("Grok runner prompt and session lifecycle", () => {
  it("uses a 0600 prompt file, keeps prompt text off argv, and cleans it up", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "grok-run-"));
    const recordFile = path.join(directory, "record.json");
    try {
      const outcome = await runGrok(
        baseOptions({
          _spawnOverride: {
            command: process.execPath,
            prefixArgs: [captureFixture, recordFile],
          },
        }),
      );
      const record = JSON.parse(readFileSync(recordFile, "utf8"));

      expect(outcome.reason).toBe("exit");
      expect(outcome.exitCode).toBe(0);
      expect(outcome.parsed.text).toBe("captured");
      expect(record.prompt).toBe("private prompt text");
      expect(record.permissions).toBe("600");
      expect(record.args).not.toContain("private prompt text");
      expect(record.args).toContain("--prompt-file");
      expect(record.args).toContain("--session-id");
      expect(record.args).not.toContain("--resume");
      expect(existsSync(record.promptFile)).toBe(false);
      expect(outcome.sessionID).toBe(record.args[record.args.indexOf("--session-id") + 1]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses --resume for a reply and returns the caller's UUID", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "grok-run-"));
    const recordFile = path.join(directory, "record.json");
    const sessionID = "11111111-1111-4111-8111-111111111111";
    try {
      const outcome = await runGrok(
        baseOptions({
          mode: "reply",
          sessionID,
          _spawnOverride: {
            command: process.execPath,
            prefixArgs: [captureFixture, recordFile],
          },
        }),
      );
      const record = JSON.parse(readFileSync(recordFile, "utf8"));
      expect(outcome.sessionID).toBe(sessionID);
      expect(record.args).toContain("--resume");
      expect(record.args).not.toContain("--session-id");
      expect(record.args[record.args.indexOf("--resume") + 1]).toBe(sessionID);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns abort immediately when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runGrok(baseOptions({ signal: controller.signal }));
    expect(outcome.reason).toBe("abort");
    expect(outcome.sessionID).toMatch(/^[0-9a-f-]{36}$/i);
  });
});

describe("Grok runner process tree lifecycle", () => {
  it("timeout kills the detached process group and grandchild", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "grok-tree-"));
    const pidFile = path.join(directory, "grandchild.pid");
    try {
      const outcome = await runGrok(
        baseOptions({
          _timeoutMsOverride: 1_000,
          _spawnOverride: { command: process.execPath, args: [treeFixture, pidFile] },
        }),
      );
      expect(outcome.reason).toBe("timeout");
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(await waitUntilDead(pid)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("abort kills the detached process group", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "grok-tree-"));
    const pidFile = path.join(directory, "grandchild.pid");
    const controller = new AbortController();
    try {
      const running = runGrok(
        baseOptions({
          signal: controller.signal,
          _spawnOverride: { command: process.execPath, args: [treeFixture, pidFile] },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      controller.abort();
      const outcome = await running;
      expect(outcome.reason).toBe("abort");
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(await waitUntilDead(pid)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("flushes a buffered newline-less line when the hard-finalize timer fires before stdout closes", async () => {
    // Child emits a JSONL text event WITHOUT a trailing newline, then ignores
    // SIGTERM and stays alive so stdout never closes on its own. The hard
    // finalize timer must drain the buffered line before resolving.
    const script =
      `process.stdout.write('{"type":"text","data":"TAILLINE"}');` +
      `process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
    const outcome = await runGrok(
      baseOptions({
        _timeoutMsOverride: 300,
        _forceFinalizeMsOverride: 300,
        _spawnOverride: { command: process.execPath, args: ["-e", script] },
      }),
    );
    expect(outcome.reason).toBe("timeout");
    expect(outcome.parsed.text).toContain("TAILLINE");
  });

  it("settles a normal child exit once", async () => {
    const outcome = await runGrok(
      baseOptions({
        _spawnOverride: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
    );
    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBe(0);
  });

  it("reports spawn ENOENT without hanging", async () => {
    const outcome = await runGrok(
      baseOptions({
        _spawnOverride: { command: "/private/tmp/mcp-grok-command-does-not-exist", args: [] },
      }),
    );
    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderrTail).toMatch(/ENOENT/);
  });
});
