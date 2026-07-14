import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { settleFingerprint } from "../src/fingerprint.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killChild(child: ChildProcess | undefined): void {
  if (!child?.pid) return;
  try {
    // Detached child may be in its own process group; try group then pid.
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      process.kill(child.pid, "SIGKILL");
    } catch {
      // already dead
    }
  }
}

describe("settleFingerprint reap-race guard", () => {
  let dir: string;
  let child: ChildProcess | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fp-race-"));
    child = undefined;
  });

  afterEach(() => {
    killChild(child);
    child = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "unsettled while detached mutator writes; settled after mutator exits",
    async () => {
      git(dir, ["init"]);
      git(dir, ["config", "user.email", "test@example.com"]);
      git(dir, ["config", "user.name", "Test"]);
      git(dir, ["checkout", "-b", "main"]);
      writeFileSync(path.join(dir, "tracked.txt"), "hello\n");
      git(dir, ["add", "tracked.txt"]);
      git(dir, ["commit", "-m", "init"]);

      // Detached grandchild that keeps rewriting an untracked file so the
      // fingerprint never goes quiet during the first settle window.
      const mutatorScript = `
const fs = require("node:fs");
const path = require("node:path");
const file = path.join(process.cwd(), "mutator-untracked.txt");
const iv = setInterval(() => {
  fs.appendFileSync(file, String(Date.now()) + "\\n");
}, 100);
setTimeout(() => {
  clearInterval(iv);
  process.exit(0);
}, 1500);
`;

      child = spawn(process.execPath, ["-e", mutatorScript], {
        cwd: dir,
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      // Give the mutator a beat to start writing.
      await sleep(150);

      const whileWriting = await settleFingerprint(dir, {
        stabilityMs: 300,
        maxWaitMs: 1000,
      });
      expect(whileWriting.settled).toBe(false);

      // Wait for the mutator to exit (~1.5s) with a little headroom.
      await sleep(1800);
      killChild(child);
      child = undefined;

      const afterQuiet = await settleFingerprint(dir, {
        stabilityMs: 300,
        maxWaitMs: 3000,
      });
      expect(afterQuiet.settled).toBe(true);
      expect(afterQuiet.fingerprint.gitTracked).toBe(true);
    },
    20_000,
  );
});
