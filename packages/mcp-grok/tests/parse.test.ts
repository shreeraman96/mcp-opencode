import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { JsonlParser, LineSplitter, MAX_LINE_BYTES } from "../src/parse.js";

const fixture = fileURLToPath(new URL("./fixtures/streaming-json.jsonl", import.meta.url));

function feedAll(parser: JsonlParser, lines: string[]) {
  for (const line of lines) parser.feedLine(line);
}

describe("Grok streaming-json parser", () => {
  it("parses the sanitized real v0.2.93 framing and ignores reasoning", () => {
    const parser = new JsonlParser();
    feedAll(parser, readFileSync(fixture, "utf8").trimEnd().split("\n"));
    const result = parser.getResult();

    expect(result.text).toBe("READY");
    expect(result.sessionID).toBe("11111111-1111-4111-8111-111111111111");
    expect(result.stopReason).toBe("EndTurn");
    expect(result.totalTextChars).toBe(5);
    expect(result.text).not.toContain("reasoning");
    expect(result.malformedLines).toBe(0);
    expect(result.unknownEvents).toBe(0);
  });

  it("retains assistant text but never thought or tool payload content", () => {
    const parser = new JsonlParser();
    parser.feedLine(JSON.stringify({ type: "thought", data: "DO NOT RETAIN THIS" }));
    parser.feedLine(JSON.stringify({ type: "tool_use", data: { secret: "payload" } }));
    parser.feedLine(JSON.stringify({ type: "text", data: "answer" }));
    const result = parser.getResult();

    expect(result.text).toBe("answer");
    expect(result.text).not.toContain("DO NOT");
    expect(result.text).not.toContain("payload");
    expect(result.unknownEvents).toBe(1);
  });

  it("counts malformed and unknown events without stopping later parsing", () => {
    const parser = new JsonlParser();
    feedAll(parser, [
      "not json",
      JSON.stringify({ type: "future_event", data: "ignored" }),
      JSON.stringify({ type: "text", data: "ok" }),
      JSON.stringify({ type: "end", stopReason: "EndTurn" }),
    ]);
    const result = parser.getResult();

    expect(result.malformedLines).toBe(1);
    expect(result.unknownEvents).toBe(1);
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("EndTurn");
  });

  it("skips an oversized JSONL line", () => {
    const parser = new JsonlParser();
    parser.feedLine(`{"type":"text","data":"${"x".repeat(1_000_001)}"}`);
    parser.feedLine(JSON.stringify({ type: "text", data: "fine" }));
    const result = parser.getResult();

    expect(result.oversizedLines).toBe(1);
    expect(result.text).toBe("fine");
  });

  it("keeps head and tail when assistant output exceeds the cap", () => {
    const parser = new JsonlParser();
    parser.feedLine(JSON.stringify({ type: "text", data: "A".repeat(30_000) }));
    parser.feedLine(JSON.stringify({ type: "text", data: "B".repeat(15_000) }));
    parser.feedLine(JSON.stringify({ type: "text", data: "C".repeat(10_000) }));
    const result = parser.getResult();

    expect(result.totalTextChars).toBe(55_000);
    expect(result.text).toContain("…[truncated");
    expect(result.text.startsWith("A".repeat(30_000) + "B".repeat(10_000))).toBe(true);
    expect(result.text.endsWith("C".repeat(10_000))).toBe(true);
  });

  it("bounds and redacts error-event messages", () => {
    const parser = new JsonlParser();
    parser.feedLine(
      JSON.stringify({ type: "error", message: "xai-SECRETKEY12345678 token=topsecret" }),
    );
    const result = parser.getResult();

    expect(result.errorMessages).toHaveLength(1);
    expect(result.errorMessages[0]).not.toContain("SECRETKEY");
    expect(result.errorMessages[0]).not.toContain("topsecret");
  });
});

describe("LineSplitter (bounded line assembly)", () => {
  function collect() {
    const lines: string[] = [];
    let oversized = 0;
    const splitter = new LineSplitter(
      (line) => lines.push(line),
      () => oversized++,
    );
    return { lines, splitter, oversizedCount: () => oversized };
  }

  it("reassembles lines split across arbitrary chunk boundaries and strips CR", () => {
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

  it("drops a newline-less flood without unbounded buffering and reports it oversized", () => {
    const { lines, splitter, oversizedCount } = collect();
    // Feed well past the cap in many chunks with no newline: memory must stay
    // bounded (the splitter enters dropping mode and holds no partial).
    const chunk = "x".repeat(100_000);
    for (let fed = 0; fed <= MAX_LINE_BYTES + 500_000; fed += chunk.length) {
      splitter.push(chunk);
    }
    // A newline finally arrives, closing the oversized line; a real line follows.
    splitter.push("\n" + JSON.stringify({ type: "text", data: "ok" }) + "\n");
    expect(oversizedCount()).toBe(1);
    expect(lines).toEqual([JSON.stringify({ type: "text", data: "ok" })]);
  });

  it("feeds bounded lines straight into the parser", () => {
    const parser = new JsonlParser();
    const splitter = new LineSplitter(
      (line) => parser.feedLine(line),
      () => parser.noteOversizedLine(),
    );
    splitter.push(JSON.stringify({ type: "text", data: "hi" }) + "\n");
    splitter.push(`{"type":"text","data":"${"y".repeat(MAX_LINE_BYTES + 10)}`);
    splitter.push('"}\n');
    splitter.flush();
    const result = parser.getResult();
    expect(result.text).toBe("hi");
    expect(result.oversizedLines).toBe(1);
  });
});
