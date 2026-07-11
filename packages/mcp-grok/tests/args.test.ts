import { afterEach, describe, expect, it } from "vitest";

import { buildInspectArgs, buildModelsArgs } from "../src/index.js";
import { SESSION_RE } from "../src/policy.js";
import { buildArgs, newSessionID } from "../src/run.js";

const id = "11111111-1111-4111-8111-111111111111";
const base = {
  model: "grok-4.5",
  cwd: "/tmp/project",
  sessionID: id,
  promptFile: "/tmp/mcp-grok-123/prompt.txt",
  leaderSocket: "/tmp/mcp-grok-123/leader.sock",
  maxTurns: 8,
};
const originalAuto = process.env.GROK_MCP_ALLOW_AUTO;

afterEach(() => {
  if (originalAuto === undefined) delete process.env.GROK_MCP_ALLOW_AUTO;
  else process.env.GROK_MCP_ALLOW_AUTO = originalAuto;
});

describe("Grok argv construction", () => {
  it("builds exact new-session args without prompt text or OpenCode flags", () => {
    delete process.env.GROK_MCP_ALLOW_AUTO;
    const args = buildArgs({ ...base, mode: "new", effort: "high" });
    expect(args).toEqual([
      "--no-auto-update",
      "--cwd",
      "/tmp/project",
      "--model",
      "grok-4.5",
      "--output-format",
      "streaming-json",
      "--session-id",
      id,
      "--prompt-file",
      "/tmp/mcp-grok-123/prompt.txt",
      "--effort",
      "high",
      "--permission-mode",
      "auto",
      "--max-turns",
      "8",
      "--no-memory",
      "--no-subagents",
      "--verbatim",
      "--leader-socket",
      "/tmp/mcp-grok-123/leader.sock",
    ]);
    expect(args).not.toContain("the private prompt text");
    for (const forbidden of ["--dir", "--format", "json", "--print-logs", "--log-level", "--agent", "--variant"]) {
      expect(args).not.toContain(forbidden);
    }
    expect(args).not.toContain("-s");
    expect(args).not.toContain("-p");
  });

  it("uses --resume and never --session-id/-s for replies", () => {
    const args = buildArgs({ ...base, mode: "reply" });
    expect(args).toContain("--resume");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("-s");
    expect(args).not.toContain("-p");
  });

  it("defaults to --permission-mode auto (the only non-opt-in mode that authorizes headless edits)", () => {
    delete process.env.GROK_MCP_ALLOW_AUTO;
    const args = buildArgs({ ...base, mode: "new" });
    const i = args.indexOf("--permission-mode");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("auto");
    // acceptEdits/dontAsk cancel the turn headlessly; never regress to them.
    expect(args).not.toContain("acceptEdits");
    expect(args).not.toContain("dontAsk");
    expect(args).not.toContain("--always-approve");
  });

  it("uses always-approve only with explicit opt-in and never combines modes", () => {
    process.env.GROK_MCP_ALLOW_AUTO = "1";
    const args = buildArgs({ ...base, mode: "new" });
    expect(args).toContain("--always-approve");
    expect(args).not.toContain("--permission-mode");
  });

  it("validates IDs and generates UUIDv4 new-session IDs", () => {
    const generated = newSessionID();
    expect(SESSION_RE.test(generated)).toBe(true);
    expect(() => buildArgs({ ...base, mode: "new", sessionID: "ses_bad" })).toThrow();
  });
});

describe("Grok utility command args", () => {
  it("uses only supported models command flags", () => {
    expect(buildModelsArgs()).toEqual(["--no-auto-update", "models"]);
    expect(buildModelsArgs("/tmp/leader.sock")).toEqual([
      "--no-auto-update",
      "--leader-socket",
      "/tmp/leader.sock",
      "models",
    ]);
  });

  it("uses supported inspect JSON args without --cwd", () => {
    expect(buildInspectArgs()).toEqual(["--no-auto-update", "inspect", "--json"]);
    expect(buildInspectArgs()).not.toContain("--cwd");
  });
});
