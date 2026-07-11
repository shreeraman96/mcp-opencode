import { describe, it, expect } from "vitest";
import { JsonlParser, LineSplitter, MAX_LINE_BYTES } from "../src/parse.js";

function feedAll(parser: JsonlParser, lines: string[]) {
  for (const l of lines) parser.feedLine(l);
}

describe("JsonlParser", () => {
  it("parses a happy-path fixture: step_start, text, step_finish", () => {
    const sid = "ses_abc123";
    const lines = [
      JSON.stringify({ type: "step_start", sessionID: sid, part: { type: "step-start" } }),
      JSON.stringify({
        type: "text",
        sessionID: sid,
        part: { type: "text", text: "Hello world" },
      }),
      JSON.stringify({
        type: "step_finish",
        sessionID: sid,
        part: {
          type: "step-finish",
          reason: "stop",
          tokens: { total: 100, input: 90, output: 10 },
          cost: 0.001,
        },
      }),
    ];
    const parser = new JsonlParser();
    feedAll(parser, lines);
    const result = parser.getResult();

    expect(result.sessionID).toBe(sid);
    expect(result.text).toBe("Hello world");
    expect(result.lastStepFinish?.reason).toBe("stop");
    expect(result.lastStepFinish?.cost).toBeCloseTo(0.001);
    expect(result.totalCost).toBeCloseTo(0.001);
    expect(result.errorMessages).toEqual([]);
    expect(result.malformedLines).toBe(0);
    expect(result.oversizedLines).toBe(0);
  });

  it("captures error events", () => {
    const parser = new JsonlParser();
    parser.feedLine(
      JSON.stringify({ type: "step_start", sessionID: "ses_x", part: {} }),
    );
    parser.feedLine(
      JSON.stringify({
        type: "error",
        sessionID: "ses_x",
        part: { message: "ProviderModelNotFoundError: nope" },
      }),
    );
    const result = parser.getResult();
    expect(result.errorMessages).toHaveLength(1);
    expect(result.errorMessages[0]).toContain("ProviderModelNotFoundError");
  });

  it("handles a missing step_finish gracefully (upstream may legitimately omit it)", () => {
    const parser = new JsonlParser();
    parser.feedLine(
      JSON.stringify({ type: "step_start", sessionID: "ses_y", part: {} }),
    );
    parser.feedLine(
      JSON.stringify({ type: "text", sessionID: "ses_y", part: { text: "partial answer" } }),
    );
    const result = parser.getResult();
    expect(result.text).toBe("partial answer");
    expect(result.lastStepFinish).toBeUndefined();
    expect(result.totalCost).toBe(0);
  });

  it("skips malformed lines interleaved with valid ones, counting them", () => {
    const parser = new JsonlParser();
    parser.feedLine("{not json");
    parser.feedLine(
      JSON.stringify({ type: "text", sessionID: "ses_z", part: { text: "ok " } }),
    );
    parser.feedLine("also not json {{{");
    parser.feedLine(
      JSON.stringify({ type: "text", sessionID: "ses_z", part: { text: "part2" } }),
    );
    const result = parser.getResult();
    expect(result.malformedLines).toBe(2);
    expect(result.text).toBe("ok part2");
  });

  it("counts JSON arrays and non-objects as malformed, not silently ignored", () => {
    const parser = new JsonlParser();
    parser.feedLine("[]");
    parser.feedLine("42");
    parser.feedLine("null");
    parser.feedLine(JSON.stringify({ type: "text", part: { text: "ok" } }));
    const result = parser.getResult();
    expect(result.malformedLines).toBe(3);
    expect(result.text).toBe("ok");
  });

  it("truncates text keeping head 40k + tail 10k when total exceeds 50k", () => {
    const parser = new JsonlParser();
    // Build > 50k chars across multiple text events.
    const chunkA = "A".repeat(30_000);
    const chunkB = "B".repeat(15_000);
    const chunkC = "C".repeat(10_000); // total = 55,000
    for (const [i, chunk] of [chunkA, chunkB, chunkC].entries()) {
      parser.feedLine(
        JSON.stringify({ type: "text", sessionID: "ses_big", part: { text: chunk } }),
      );
    }
    const result = parser.getResult();
    expect(result.totalTextChars).toBe(55_000);
    expect(result.text).toContain("…[truncated");
    // Head should start with 40,000 'A's and 'B's (30000 A + 10000 B = 40000 head cap)
    expect(result.text.startsWith("A".repeat(30_000) + "B".repeat(10_000))).toBe(true);
    // Tail should be the last 10,000 chars, which is all 'C's.
    expect(result.text.endsWith("C".repeat(10_000))).toBe(true);
  });

  it("skips oversized lines (>1MB) without attempting to parse them", () => {
    const parser = new JsonlParser();
    const hugeLine = "{" + "x".repeat(1_000_001) + "}";
    parser.feedLine(hugeLine);
    parser.feedLine(
      JSON.stringify({ type: "text", sessionID: "ses_ok", part: { text: "fine" } }),
    );
    const result = parser.getResult();
    expect(result.oversizedLines).toBe(1);
    expect(result.malformedLines).toBe(0);
    expect(result.text).toBe("fine");
  });

  it("fires onCostCapExceeded exactly once when accumulated cost crosses maxCostUsd", () => {
    let fired = 0;
    const parser = new JsonlParser({
      maxCostUsd: 0.05,
      onCostCapExceeded: () => {
        fired++;
      },
    });
    parser.feedLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_cost",
        part: { reason: "tool-calls", cost: 0.03 },
      }),
    );
    expect(fired).toBe(0);
    parser.feedLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_cost",
        part: { reason: "tool-calls", cost: 0.03 },
      }),
    );
    expect(fired).toBe(1);
    parser.feedLine(
      JSON.stringify({
        type: "step_finish",
        sessionID: "ses_cost",
        part: { reason: "stop", cost: 0.03 },
      }),
    );
    expect(fired).toBe(1); // does not fire again
    expect(parser.getResult().costCapExceeded).toBe(true);
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
    splitter.push("\n" + JSON.stringify({ type: "text", part: { text: "ok" } }) + "\n");
    expect(oversizedCount()).toBe(1);
    expect(lines).toEqual([JSON.stringify({ type: "text", part: { text: "ok" } })]);
  });

  it("feeds bounded lines straight into the parser", () => {
    const parser = new JsonlParser();
    const splitter = new LineSplitter(
      (line) => parser.feedLine(line),
      () => parser.noteOversizedLine(),
    );
    splitter.push(JSON.stringify({ type: "text", part: { text: "hi" } }) + "\n");
    splitter.push(`{"type":"text","part":{"text":"${"y".repeat(MAX_LINE_BYTES + 10)}`);
    splitter.push('"}}\n');
    splitter.flush();
    const result = parser.getResult();
    expect(result.text).toBe("hi");
    expect(result.oversizedLines).toBe(1);
  });
});
