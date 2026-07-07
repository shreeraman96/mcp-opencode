import { describe, it, expect } from "vitest";
import { JsonlParser } from "../src/parse.js";

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
