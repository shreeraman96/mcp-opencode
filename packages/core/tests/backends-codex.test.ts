import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildArgs,
  buildCodexArgs,
  classifyCodex,
  StreamingJsonParser,
  JsonlParser,
  LineSplitter,
  RingBuffer,
  runCodex,
  redact,
  validateTimeoutSec,
  MODEL_RE,
  MAX_LINE_BYTES,
  STDERR_RING_CAP,
  MIN_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
} from "../src/backends/codex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const treeFixture = path.join(here, "fixtures", "tree.mjs");

// ---------------------------------------------------------------------------
// Verified real Codex event-shape fixtures
// ---------------------------------------------------------------------------

const NESTED_400_MESSAGE = JSON.stringify({
  type: "error",
  status: 400,
  error: {
    type: "invalid_request_error",
    message: "The 'x' model is not supported when using Codex with a ChatGPT account.",
  },
});

const EVENTS = {
  threadStarted: { type: "thread.started", thread_id: "019f-abc" },
  agentMessage: {
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "PONG" },
  },
  turnCompleted: { type: "turn.completed", usage: { input_tokens: 1 } },
  turnFailedNested400: {
    type: "turn.failed",
    error: { message: NESTED_400_MESSAGE },
  },
  errorPlain: { type: "error", message: "boom plain text" },
  itemError: {
    type: "item.completed",
    item: { id: "i", type: "error", message: "Model metadata for `x` not found." },
  },
  unknown: { type: "totally.unknown" },
} as const;

function feedAll(parser: StreamingJsonParser, lines: string[]) {
  for (const line of lines) parser.feedLine(line);
}

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

function baseRunOptions(overrides: Partial<Parameters<typeof runCodex>[0]> = {}) {
  return {
    model: "gpt-5",
    cwd: process.cwd(),
    prompt: "say pong",
    timeoutSec: 30,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildArgs / MODEL_RE
// ---------------------------------------------------------------------------

describe("Codex buildArgs / buildCodexArgs", () => {
  const base = {
    model: "gpt-5",
    cwd: "/tmp/project",
    lastMessageFile: "/tmp/mcp-codex-123/last-message.txt",
    prompt: "hello world",
  };

  it("builds exact argv order for a plain exec", () => {
    const args = buildArgs(base);
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-C",
      "/tmp/project",
      "-m",
      "gpt-5",
      "--skip-git-repo-check",
      "-o",
      "/tmp/mcp-codex-123/last-message.txt",
      "hello world",
    ]);
  });

  it("inserts -i <file> for each image BEFORE the trailing prompt", () => {
    const args = buildArgs({
      ...base,
      images: ["/tmp/a.png", "/tmp/b.png"],
    });
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "-C",
      "/tmp/project",
      "-m",
      "gpt-5",
      "--skip-git-repo-check",
      "-o",
      "/tmp/mcp-codex-123/last-message.txt",
      "-i",
      "/tmp/a.png",
      "-i",
      "/tmp/b.png",
      "hello world",
    ]);
    expect(args[args.length - 1]).toBe("hello world");
  });

  it("buildCodexArgs is an alias of buildArgs", () => {
    expect(buildCodexArgs(base)).toEqual(buildArgs(base));
  });

  it("throws RangeError for invalid models", () => {
    expect(() => buildArgs({ ...base, model: "-bad" })).toThrow(RangeError);
    expect(() => buildArgs({ ...base, model: "" })).toThrow(RangeError);
    expect(() => buildArgs({ ...base, model: "-bad" })).toThrow(/invalid Codex model/);
  });

  it("MODEL_RE accepts simple OpenAI-style IDs and rejects leading dashes / empty", () => {
    expect(MODEL_RE.test("gpt-5")).toBe(true);
    expect(MODEL_RE.test("o4-mini")).toBe(true);
    expect(MODEL_RE.test("gpt-5.1")).toBe(true);
    expect(MODEL_RE.test("-bad")).toBe(false);
    expect(MODEL_RE.test("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// StreamingJsonParser (verified real event shapes)
// ---------------------------------------------------------------------------

describe("Codex StreamingJsonParser / JsonlParser", () => {
  it("sets sessionID from thread.started", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.threadStarted));
    expect(parser.getResult().sessionID).toBe("019f-abc");
  });

  it("collects agent_message text from item.completed", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.agentMessage));
    expect(parser.getResult().text).toContain("PONG");
  });

  it("sets stopReason completed on turn.completed", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.turnCompleted));
    expect(parser.getResult().stopReason).toBe("completed");
  });

  it("parses nested JSON in turn.failed error.message (HTTP 400 + ChatGPT account)", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.turnFailedNested400));
    const result = parser.getResult();
    expect(result.stopReason).toBe("failed");
    expect(result.errorMessages).toHaveLength(1);
    expect(result.errorMessages[0]).toContain("not supported when using Codex");
    expect(result.errorMessages[0]).toContain("[HTTP 400]");
  });

  it("collects plain top-level error messages", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.errorPlain));
    expect(parser.getResult().errorMessages).toContain("boom plain text");
  });

  it("collects item type error messages from item.completed", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.itemError));
    expect(parser.getResult().errorMessages).toEqual(
      expect.arrayContaining([expect.stringContaining("Model metadata for `x` not found.")]),
    );
  });

  it("increments malformedLines on non-JSON without throwing", () => {
    const parser = new StreamingJsonParser();
    expect(() => parser.feedLine("not json{")).not.toThrow();
    expect(parser.getResult().malformedLines).toBe(1);
  });

  it("increments unknownEvents for unrecognized type", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify(EVENTS.unknown));
    expect(parser.getResult().unknownEvents).toBe(1);
  });

  it("only the FIRST thread.started sets sessionID", () => {
    const parser = new StreamingJsonParser();
    parser.feedLine(JSON.stringify({ type: "thread.started", thread_id: "first-id" }));
    parser.feedLine(JSON.stringify({ type: "thread.started", thread_id: "second-id" }));
    expect(parser.getResult().sessionID).toBe("first-id");
  });

  it("JsonlParser is an alias of StreamingJsonParser", () => {
    expect(JsonlParser).toBe(StreamingJsonParser);
  });

  it("end-to-end happy path: thread.started + agent_message + turn.completed", () => {
    const parser = new StreamingJsonParser();
    feedAll(parser, [
      JSON.stringify(EVENTS.threadStarted),
      JSON.stringify(EVENTS.agentMessage),
      JSON.stringify(EVENTS.turnCompleted),
    ]);
    const result = parser.getResult();
    expect(result.sessionID).toBe("019f-abc");
    expect(result.text).toContain("PONG");
    expect(result.stopReason).toBe("completed");
    expect(result.malformedLines).toBe(0);
    expect(result.unknownEvents).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classifyCodex
// ---------------------------------------------------------------------------

describe("Codex classifyCodex", () => {
  it("classifies spawn codex ENOENT as transport/spawn and returns early", () => {
    const result = classifyCodex("spawn codex ENOENT");
    expect(result).toEqual([
      {
        category: "transport",
        provenance: "spawn",
        message: expect.stringContaining("not found"),
      },
    ]);
    expect(result).toHaveLength(1);
  });

  it("classifies command not found: codex as transport/spawn", () => {
    const result = classifyCodex("command not found: codex");
    expect(result.some((e) => e.category === "transport" && e.provenance === "spawn")).toBe(true);
  });

  it("classifies nested ChatGPT-account 400 as auth (inferred)", () => {
    const result = classifyCodex(
      "The 'x' model is not supported when using Codex with a ChatGPT account.",
    );
    expect(result.some((e) => e.category === "auth" && e.provenance === "inferred")).toBe(true);
  });

  it("classifies rate-limit / overloaded as capacity (inferred)", () => {
    expect(
      classifyCodex("429 too many requests").some(
        (e) => e.category === "capacity" && e.provenance === "inferred",
      ),
    ).toBe(true);
    expect(
      classifyCodex("overloaded").some((e) => e.category === "capacity" && e.provenance === "inferred"),
    ).toBe(true);
  });

  it("returns [] for benign model-metadata-not-found (regression guard)", () => {
    // Must NOT match notInstalled/auth/capacity — agent tool error, not CLI missing.
    expect(classifyCodex("Model metadata for `x` not found.")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LineSplitter / RingBuffer / redact / validateTimeoutSec
// ---------------------------------------------------------------------------

describe("Codex LineSplitter", () => {
  function collect() {
    const lines: string[] = [];
    let oversized = 0;
    const splitter = new LineSplitter(
      (line) => lines.push(line),
      () => oversized++,
    );
    return { lines, splitter, oversizedCount: () => oversized };
  }

  it("reassembles lines split across chunk boundaries and strips CR", () => {
    const { lines, splitter } = collect();
    splitter.push("he");
    splitter.push("llo\r\nwor");
    splitter.push("ld\n");
    expect(lines).toEqual(["hello", "world"]);
  });

  it("emits a trailing newline-less line only on flush", () => {
    const { lines, splitter } = collect();
    splitter.push("no-newline-yet");
    expect(lines).toEqual([]);
    splitter.flush();
    expect(lines).toEqual(["no-newline-yet"]);
  });

  it("drops a newline-less flood without unbounded buffering", () => {
    const { lines, splitter, oversizedCount } = collect();
    const chunk = "x".repeat(100_000);
    for (let fed = 0; fed <= MAX_LINE_BYTES + 500_000; fed += chunk.length) {
      splitter.push(chunk);
    }
    splitter.push("\n" + JSON.stringify({ type: "text" }) + "\n");
    expect(oversizedCount()).toBe(1);
    expect(lines).toEqual([JSON.stringify({ type: "text" })]);
  });
});

describe("Codex RingBuffer", () => {
  it("retains the most recent bytes within the cap", () => {
    const ring = new RingBuffer(10);
    ring.push("abcdefghij");
    ring.push("XYZ");
    expect(ring.toString()).toBe("defghijXYZ");
    expect(ring.toString().length).toBeLessThanOrEqual(10);
  });

  it("defaults to STDERR_RING_CAP", () => {
    const ring = new RingBuffer();
    ring.push("a".repeat(STDERR_RING_CAP + 100));
    expect(ring.toString().length).toBe(STDERR_RING_CAP);
  });
});

describe("Codex redact / validateTimeoutSec", () => {
  it("redacts OpenAI sk- keys and ~/.codex session paths", () => {
    expect(redact("token sk-proj-ABCDEFGH12345678 leaked")).not.toContain("ABCDEFGH12345678");
    expect(redact("see /Users/me/.codex/sessions/abc123.json")).toContain("~/.codex/sessions/[REDACTED]");
  });

  it("validateTimeoutSec accepts the documented range and rejects out-of-range", () => {
    expect(() => validateTimeoutSec(MIN_TIMEOUT_SEC)).not.toThrow();
    expect(() => validateTimeoutSec(MAX_TIMEOUT_SEC)).not.toThrow();
    expect(() => validateTimeoutSec(MIN_TIMEOUT_SEC - 1)).toThrow(RangeError);
    expect(() => validateTimeoutSec(MAX_TIMEOUT_SEC + 1)).toThrow(RangeError);
    expect(() => validateTimeoutSec(30.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// runCodex lifecycle via _spawnOverride (mirrors mcp-grok run.test.ts)
// ---------------------------------------------------------------------------

describe("runCodex lifecycle (fake child process)", () => {
  it("happy path: JSONL stdout + exit 0 → exit/completed with sessionID and stream text fallback", async () => {
    // Fake cannot write the temp -o lastMessageFile, so text falls back to the
    // streamed agent_message (the STREAM-FALLBACK path).
    const script = [
      `const lines = [`,
      `  ${JSON.stringify(JSON.stringify(EVENTS.threadStarted))},`,
      `  ${JSON.stringify(JSON.stringify(EVENTS.agentMessage))},`,
      `  ${JSON.stringify(JSON.stringify(EVENTS.turnCompleted))},`,
      `];`,
      `for (const line of lines) process.stdout.write(line + "\\n");`,
      `process.exit(0);`,
    ].join("");

    const outcome = await runCodex(
      baseRunOptions({
        _spawnOverride: { command: process.execPath, args: ["-e", script] },
      }),
    );

    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.parsed.sessionID).toBe("019f-abc");
    expect(outcome.sessionID).toBe("019f-abc");
    expect(outcome.parsed.stopReason).toBe("completed");
    // STREAM-FALLBACK: no lastMessageFile was written by the fake.
    expect(outcome.parsed.text).toContain("PONG");
  });

  it("returns abort immediately when the request is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const outcome = await runCodex(baseRunOptions({ signal: controller.signal }));
    expect(outcome.reason).toBe("abort");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.parsed.text).toBe("");
  });

  it("timeout kills the detached process group and grandchild", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "codex-tree-"));
    const pidFile = path.join(directory, "grandchild.pid");
    try {
      const outcome = await runCodex(
        baseRunOptions({
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

  it("settles a normal child exit once", async () => {
    const outcome = await runCodex(
      baseRunOptions({
        _spawnOverride: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      }),
    );
    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBe(0);
  });

  it("reports spawn ENOENT without hanging", async () => {
    const outcome = await runCodex(
      baseRunOptions({
        _spawnOverride: { command: "/private/tmp/mcp-codex-command-does-not-exist", args: [] },
      }),
    );
    expect(outcome.reason).toBe("exit");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.stderrTail).toMatch(/ENOENT/);
  });
});
