import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateCwd, redact, isEmptyResult, MODEL_RE, SESSION_RE } from "../src/policy.js";

describe("policy: roots allowlist", () => {
  let root: string;
  let outside: string;
  const origRoots = process.env.OPENCODE_MCP_ROOTS;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "oc-root-"));
    outside = mkdtempSync(path.join(tmpdir(), "oc-outside-"));
    process.env.OPENCODE_MCP_ROOTS = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    if (origRoots === undefined) delete process.env.OPENCODE_MCP_ROOTS;
    else process.env.OPENCODE_MCP_ROOTS = origRoots;
  });

  it("allows a cwd inside the configured root", async () => {
    const inner = path.join(root, "project");
    mkdirSync(inner);
    const result = await validateCwd(inner);
    expect(result.ok).toBe(true);
  });

  it("rejects a cwd outside the configured root", async () => {
    const result = await validateCwd(outside);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/outside the allowed roots/);
  });

  it("rejects a ../ escape that resolves outside the root", async () => {
    const inner = path.join(root, "project");
    mkdirSync(inner);
    const escaped = path.join(inner, "..", "..", path.basename(outside));
    // escaped should point at `outside`'s sibling location, i.e. not inside root
    const result = await validateCwd(escaped);
    expect(result.ok).toBe(false);
  });

  it("rejects a symlink inside the root that points outside of it (realpath escape)", async () => {
    const linkPath = path.join(root, "escape-link");
    symlinkSync(outside, linkPath);
    const result = await validateCwd(linkPath);
    expect(result.ok).toBe(false);
  });

  it("allows a symlink inside the root that points to another dir inside the root", async () => {
    const real = path.join(root, "real-dir");
    mkdirSync(real);
    const linkPath = path.join(root, "link-to-real");
    symlinkSync(real, linkPath);
    const result = await validateCwd(linkPath);
    expect(result.ok).toBe(true);
  });
});

describe("policy: redaction", () => {
  it("redacts sk- style API keys", () => {
    const input = "here is a key sk-ABCDEFGH12345678 in the log";
    expect(redact(input)).toBe("here is a key [REDACTED] in the log");
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer abc123.def456-ghi789";
    expect(redact(input)).toBe("Authorization: [REDACTED]");
  });

  it("redacts key=value style secrets (api_key, token, secret, password)", () => {
    // Trailing closing quote is intentionally left outside the match (the
    // regex's value class excludes quote characters), so redaction leaves a
    // dangling quote behind -- the secret value itself is still gone.
    expect(redact('api_key: "supersecretvalue"')).toBe('[REDACTED]"');
    expect(redact("token=abcdef123456")).toBe("[REDACTED]");
    expect(redact("secret = 'xyz987'")).toBe("[REDACTED]'");
    expect(redact("password:hunter2xyz")).toBe("[REDACTED]");
  });

  it("leaves ordinary text untouched", () => {
    const input = "This is a normal log line with no secrets in it.";
    expect(redact(input)).toBe(input);
  });
});

describe("policy: isEmptyResult", () => {
  it("is empty only when there is no text, no error, and no changes", () => {
    expect(isEmptyResult({ hasText: false, hasError: false, hasChanges: false })).toBe(true);
  });

  it("is not empty when files changed but no text was emitted (silent build run)", () => {
    expect(isEmptyResult({ hasText: false, hasError: false, hasChanges: true })).toBe(false);
  });

  it("is not empty when there is text", () => {
    expect(isEmptyResult({ hasText: true, hasError: false, hasChanges: false })).toBe(false);
  });

  it("is not empty when an error event was observed", () => {
    expect(isEmptyResult({ hasText: false, hasError: true, hasChanges: false })).toBe(false);
  });
});

describe("policy: MODEL_RE", () => {
  it("accepts simple provider/model ids", () => {
    expect(MODEL_RE.test("opencode/big-pickle")).toBe(true);
    expect(MODEL_RE.test("anthropic/claude-sonnet-4-5")).toBe(true);
  });

  it("accepts multi-slash model paths (Fireworks GLM 5.2 and router variants)", () => {
    expect(MODEL_RE.test("fireworks-ai/accounts/fireworks/models/glm-5p2")).toBe(true);
    expect(MODEL_RE.test("fireworks-ai/accounts/fireworks/routers/glm-5p2-fast")).toBe(true);
  });

  it("rejects ids with no provider separator or with spaces", () => {
    expect(MODEL_RE.test("glm-5p2")).toBe(false);
    expect(MODEL_RE.test("provider/model with space")).toBe(false);
  });
});

describe("policy: SESSION_RE", () => {
  it("accepts ses_ ids and rejects others", () => {
    expect(SESSION_RE.test("ses_0c9b724fcffegDhmv9ex0gumat")).toBe(true);
    expect(SESSION_RE.test("nope")).toBe(false);
  });
});
