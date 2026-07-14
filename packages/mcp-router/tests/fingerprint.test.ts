import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  computeFingerprint,
  fingerprintsEqual,
} from "../src/fingerprint.js";

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

function initRepo(dir: string): void {
  git(dir, ["init"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  // Avoid "main" vs "master" variance across git versions for branch part
  git(dir, ["checkout", "-b", "main"]);
}

describe("computeFingerprint / fingerprintsEqual", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "fp-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("unborn repo (no commits) is gitTracked and reliable", async () => {
    // Fresh `git init` with no commit: `rev-parse HEAD` would exit 128, but
    // `-q --verify` keeps the HEAD dimension a reliable "no HEAD yet" so the
    // whole fingerprint stays reliable (fallback works before the first commit).
    initRepo(dir);
    const fp = await computeFingerprint(dir);
    expect(fp.gitTracked).toBe(true);
    expect(fp.reliable).toBe(true);
    expect(fingerprintsEqual(fp, await computeFingerprint(dir))).toBe(true);
  });

  it("non-git dir -> gitTracked:false", async () => {
    const fp = await computeFingerprint(dir);
    expect(fp.gitTracked).toBe(false);
    expect(fp.value).toBe("");
  });

  it("clean committed repo: two computeFingerprint calls are equal", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "init"]);

    const a = await computeFingerprint(dir);
    const b = await computeFingerprint(dir);
    expect(a.gitTracked).toBe(true);
    expect(fingerprintsEqual(a, b)).toBe(true);
  });

  it("modify a tracked file -> fingerprint changes vs clean", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "init"]);

    const clean = await computeFingerprint(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello world\n");
    const dirty = await computeFingerprint(dir);
    expect(fingerprintsEqual(clean, dirty)).toBe(false);
  });

  it("stage a change (git add) -> fingerprint changes vs unstaged", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "init"]);

    writeFileSync(path.join(dir, "a.txt"), "changed\n");
    const unstaged = await computeFingerprint(dir);
    git(dir, ["add", "a.txt"]);
    const staged = await computeFingerprint(dir);
    expect(fingerprintsEqual(unstaged, staged)).toBe(false);
  });

  it("add a new untracked file changes fingerprint; deleting it restores prior value", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "init"]);

    const before = await computeFingerprint(dir);
    const untracked = path.join(dir, "new.txt");
    writeFileSync(untracked, "untracked content\n");
    const withFile = await computeFingerprint(dir);
    expect(fingerprintsEqual(before, withFile)).toBe(false);

    unlinkSync(untracked);
    const after = await computeFingerprint(dir);
    expect(fingerprintsEqual(before, after)).toBe(true);
  });

  it("in-place same-SIZE rewrite of an untracked file changes fingerprint", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "init"]);

    const untracked = path.join(dir, "blob.bin");
    writeFileSync(untracked, "AAAA");
    const first = await computeFingerprint(dir);
    writeFileSync(untracked, "BBBB"); // same byte length, different content
    const second = await computeFingerprint(dir);
    expect(first.gitTracked).toBe(true);
    expect(fingerprintsEqual(first, second)).toBe(false);
  });

  it("editing a .gitignored file does NOT change fingerprint", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", ".gitignore", "a.txt"]);
    git(dir, ["commit", "-m", "init"]);

    const before = await computeFingerprint(dir);
    writeFileSync(path.join(dir, "ignored.txt"), "secret1\n");
    const afterCreate = await computeFingerprint(dir);
    expect(fingerprintsEqual(before, afterCreate)).toBe(true);

    writeFileSync(path.join(dir, "ignored.txt"), "secret2-different\n");
    const afterEdit = await computeFingerprint(dir);
    expect(fingerprintsEqual(before, afterEdit)).toBe(true);
  });

  it("commit that leaves status clean still changes fingerprint (HEAD moved)", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "init"]);

    const preCommitClean = await computeFingerprint(dir);
    writeFileSync(path.join(dir, "a.txt"), "v2\n");
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-m", "second"]);

    const postCommitClean = await computeFingerprint(dir);
    expect(preCommitClean.gitTracked).toBe(true);
    expect(postCommitClean.gitTracked).toBe(true);
    expect(fingerprintsEqual(preCommitClean, postCommitClean)).toBe(false);
  });

  it("tracked binary rewrite is detected", async () => {
    initRepo(dir);
    const binPath = path.join(dir, "blob.bin");
    // Include a null byte so this is clearly binary content.
    writeFileSync(binPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe]));
    git(dir, ["add", "blob.bin"]);
    git(dir, ["commit", "-m", "binary init"]);

    const before = await computeFingerprint(dir);
    // Same length, different bytes — size-only checks would miss this.
    writeFileSync(binPath, Buffer.from([0xaa, 0xbb, 0xcc, 0xdd, 0x11, 0x22]));
    const after = await computeFingerprint(dir);

    expect(before.gitTracked).toBe(true);
    expect(before.reliable).toBe(true);
    expect(after.reliable).toBe(true);
    expect(fingerprintsEqual(before, after)).toBe(false);
  });

  it("fingerprintsEqual treats unreliable as unequal", () => {
    expect(
      fingerprintsEqual(
        { gitTracked: true, reliable: false, value: "x" },
        { gitTracked: true, reliable: true, value: "x" },
      ),
    ).toBe(false);
    expect(
      fingerprintsEqual(
        { gitTracked: true, reliable: true, value: "x" },
        { gitTracked: true, reliable: true, value: "x" },
      ),
    ).toBe(true);
  });
});
