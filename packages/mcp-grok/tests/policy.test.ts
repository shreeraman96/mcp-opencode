import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_SEC,
  MODEL_RE,
  SESSION_RE,
  classifyError,
  isEmptyResult,
  redact,
  validateCwd,
  validateMaxTurns,
  validateTimeoutSec,
} from "../src/policy.js";

describe("Grok policy: roots", () => {
  let root: string;
  let outside: string;
  const originalRoots = process.env.GROK_MCP_ROOTS;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "grok-root-"));
    outside = mkdtempSync(path.join(tmpdir(), "grok-outside-"));
    process.env.GROK_MCP_ROOTS = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (originalRoots === undefined) delete process.env.GROK_MCP_ROOTS;
    else process.env.GROK_MCP_ROOTS = originalRoots;
  });

  it("allows a real directory inside a configured root", async () => {
    const inner = path.join(root, "project");
    mkdirSync(inner);
    expect((await validateCwd(inner)).ok).toBe(true);
  });

  it("rejects outside paths and symlink escapes", async () => {
    const link = path.join(root, "escape-link");
    symlinkSync(outside, link);
    expect((await validateCwd(outside)).ok).toBe(false);
    expect((await validateCwd(link)).ok).toBe(false);
  });

  it("allows a symlink that resolves back inside the root", async () => {
    const real = path.join(root, "real");
    mkdirSync(real);
    symlinkSync(real, path.join(root, "link"));
    expect((await validateCwd(path.join(root, "link"))).ok).toBe(true);
  });
});

describe("Grok policy: IDs and models", () => {
  it("accepts simple and namespaced model IDs but rejects unsafe strings", () => {
    expect(MODEL_RE.test("grok-4.5")).toBe(true);
    expect(MODEL_RE.test("grok-composer-2.5-fast")).toBe(true);
    expect(MODEL_RE.test("org/models/grok@latest")).toBe(true);
    expect(MODEL_RE.test("grok 4.5")).toBe(false);
    expect(MODEL_RE.test("--always-approve")).toBe(false);
    expect(MODEL_RE.test("")).toBe(false);
  });

  it("accepts canonical UUIDv4 session IDs and rejects OpenCode IDs", () => {
    expect(SESSION_RE.test("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(SESSION_RE.test("ses_abc123")).toBe(false);
    expect(SESSION_RE.test("11111111-1111-5111-8111-111111111111")).toBe(false);
  });
});

describe("Grok policy: redaction and classification", () => {
  it("strips ANSI and redacts xAI, bearer, and assignment-shaped secrets", () => {
    const input = "\u001b[31mAuthorization: Bearer abc.def\u001b[0m xai-SECRETKEY12345678 token=topsecret";
    const output = redact(input);
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("abc.def");
    expect(output).not.toContain("SECRETKEY");
    expect(output).not.toContain("topsecret");
  });

  it("redacts Grok session paths under the home directory", () => {
    const output = redact("/Users/tester/.grok/sessions/project/uuid/updates.jsonl");
    expect(output).toContain("~/.grok/sessions/[REDACTED]");
    expect(output).not.toContain("updates.jsonl");
  });

  it("redacts AWS keys, GitHub tokens, and PEM private-key blocks", () => {
    expect(redact("key AKIAIOSFODNN7EXAMPLE here")).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(redact("ghp_0123456789abcdefghijABCDEFghij0123")).not.toContain("ghp_0123456789");
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nMIIBhogus+key/data==\n-----END OPENSSH PRIVATE KEY-----";
    const out = redact(pem);
    expect(out).not.toContain("hogus+key");
    expect(out).toContain("[REDACTED]");
  });

  it("classifies exact observed auth and actionable CLI failures", () => {
    expect(classifyError("No auth credentials for cli-chat-proxy", "grok-4.5")).toMatch(/authentication/);
    expect(classifyError("error sending request for url (https://auth.x.ai/.well-known/openid-configuration)", "grok-4.5")).toMatch(/authentication/);
    expect(classifyError("spawn grok ENOENT", "grok-4.5")).toMatch(/not found/);
    expect(classifyError("model not found", "grok-4.5")).toMatch(/grok-4\.5/);
  });

  it("does not misreport a file-level ENOENT as a missing CLI", () => {
    const diag = "Error: ENOENT: no such file or directory, open '/project/missing.ts'";
    expect(classifyError(diag, "grok-4.5")).toBeUndefined();
  });
});

describe("Grok policy: result and bounds", () => {
  it("uses conservative defaults and validates explicit bounds", () => {
    expect(DEFAULT_TIMEOUT_SEC).toBe(900);
    expect(DEFAULT_MAX_TURNS).toBeGreaterThan(1);
    expect(() => validateTimeoutSec(29)).toThrow();
    expect(() => validateTimeoutSec(3601)).toThrow();
    expect(() => validateTimeoutSec(30)).not.toThrow();
    expect(() => validateMaxTurns(0)).toThrow();
    expect(() => validateMaxTurns(101)).toThrow();
    expect(() => validateMaxTurns(8)).not.toThrow();
  });

  it("treats silent-but-changed runs as non-empty", () => {
    expect(isEmptyResult({ hasText: false, hasError: false, hasChanges: false })).toBe(true);
    expect(isEmptyResult({ hasText: false, hasError: false, hasChanges: true })).toBe(false);
    expect(isEmptyResult({ hasText: true, hasError: false, hasChanges: false })).toBe(false);
  });
});
