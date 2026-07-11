#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { validateCwd, redact, classifyError, isEmptyResult, boundText, MODEL_RE, SESSION_RE } from "./policy.js";
import { runOpencode, type Agent } from "./run.js";
import { CwdQueue } from "./queue.js";
import type { ParsedResult } from "./parse.js";

const execFileP = promisify(execFile);

const queue = new CwdQueue();

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false };
}

const GIT_EXEC_OPTS = { timeout: 10_000, maxBuffer: 512 * 1024 } as const;

async function gitChangedFiles(cwd: string): Promise<string | undefined> {
  try {
    const check = await execFileP(
      "git",
      ["-C", cwd, "rev-parse", "--is-inside-work-tree"],
      GIT_EXEC_OPTS,
    );
    if (check.stdout.trim() !== "true") return undefined;
  } catch {
    return undefined; // not a git repo, or git unavailable: skip silently
  }
  try {
    const [diffStat, status] = await Promise.all([
      execFileP("git", ["-C", cwd, "diff", "--stat"], GIT_EXEC_OPTS),
      execFileP("git", ["-C", cwd, "status", "--porcelain"], GIT_EXEC_OPTS),
    ]);
    const untracked = status.stdout
      .split("\n")
      .filter((l) => l.startsWith("??"))
      .join("\n");
    const chunks = [diffStat.stdout.trim(), untracked.trim()].filter((s) => s.length > 0);
    return chunks.length > 0 ? boundText(redact(chunks.join("\n")), 12_000) : "(no changes detected)";
  } catch {
    return undefined;
  }
}

function formatTokensAndCost(parsed: ParsedResult): { tokens: string; cost: string } {
  const t = parsed.lastStepFinish?.tokens;
  const c = parsed.totalCost;
  return {
    tokens: t ? JSON.stringify(t) : "n/a",
    cost: parsed.lastStepFinish !== undefined ? `$${c.toFixed(6)}` : "n/a",
  };
}

interface CommonRunArgs {
  model: string;
  cwd: string;
  agent: Agent;
  prompt: string;
  variant?: string;
  sessionID?: string;
  timeoutSec: number;
  maxCostUsd?: number;
}

async function executeRun(
  args: CommonRunArgs,
  extra: { signal: AbortSignal; _meta?: { progressToken?: unknown }; sendNotification: (n: any) => Promise<void> },
) {
  const validation = await validateCwd(args.cwd);
  if (!validation.ok) {
    return toolError(`Invalid cwd: ${validation.error}`);
  }
  const resolvedCwd = validation.resolved!;

  const progressToken = extra._meta?.progressToken;
  const onHeartbeat = progressToken
    ? (elapsedSec: number, progress: number) => {
        void extra.sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress,
            message: `opencode running (${elapsedSec}s)`,
          },
        });
      }
    : undefined;

  return queue.run(resolvedCwd, async () => {
    const outcome = await runOpencode({
      model: args.model,
      cwd: resolvedCwd,
      agent: args.agent,
      prompt: args.prompt,
      variant: args.variant,
      sessionID: args.sessionID,
      timeoutSec: args.timeoutSec,
      maxCostUsd: args.maxCostUsd,
      signal: extra.signal,
      onHeartbeat,
    });

    const { parsed, stderrTail, reason, exitCode, elapsedSec } = outcome;
    // Assistant text can echo secrets the agent read (.env, keys); redact before
    // it ever reaches the client, on every path that returns it.
    const safeText = redact(parsed.text);
    const { tokens, cost } = formatTokensAndCost(parsed);
    const changedFiles = await gitChangedFiles(resolvedCwd);

    const header = [
      `sessionID: ${parsed.sessionID ?? "(none)"}`,
      `model: ${args.model}`,
      `agent: ${args.agent}`,
      `elapsed: ${elapsedSec.toFixed(1)}s`,
      `tokens: ${tokens}`,
      `cost: ${cost}`,
    ];
    if (changedFiles !== undefined) {
      header.push(`changed files:\n${changedFiles}`);
    }
    if (parsed.malformedLines > 0 || parsed.oversizedLines > 0) {
      header.push(
        `parser notes: ${parsed.malformedLines} malformed line(s), ${parsed.oversizedLines} oversized line(s) skipped`,
      );
    }

    if (reason === "abort") {
      return toolError(
        [`status: aborted`, ...header, `stderr tail:\n${stderrTail}`].join("\n"),
      );
    }
    if (reason === "timeout") {
      return toolError(
        [`status: timeout after ${args.timeoutSec}s`, ...header, `stderr tail:\n${stderrTail}`].join(
          "\n",
        ),
      );
    }
    if (reason === "cost-cap") {
      return toolError(
        [
          `status: cost cap exceeded (limit $${args.maxCostUsd})`,
          ...header,
          `partial output:\n${safeText}`,
          `stderr tail:\n${stderrTail}`,
        ].join("\n"),
      );
    }

    // reason === 'exit'
    if (exitCode !== 0) {
      const classified = classifyError(stderrTail, args.model);
      const message = classified ?? `opencode exited with code ${exitCode}`;
      return toolError(
        [`status: error`, message, ...header, `stderr tail:\n${stderrTail}`].join("\n"),
      );
    }

    // The cap can be crossed by a step_finish parsed after the child already
    // exited, so settle("cost-cap") loses the race to settle("exit"). The flag
    // is authoritative regardless of which reason won.
    if (parsed.costCapExceeded) {
      return toolError(
        [
          `status: cost cap exceeded (limit $${args.maxCostUsd})`,
          ...header,
          `partial output:\n${safeText}`,
          `stderr tail:\n${stderrTail}`,
        ].join("\n"),
      );
    }

    // exitCode === 0
    const hasText = safeText.trim().length > 0;
    const hasError = parsed.errorMessages.length > 0;
    // A build run can legitimately edit files and emit no final text event
    // (the known missing-step_finish upstream bug). Treat on-disk changes as a
    // success signal so productive-but-silent runs aren't reported as empty.
    const hasChanges =
      changedFiles !== undefined && changedFiles !== "(no changes detected)";
    if (isEmptyResult({ hasText, hasError, hasChanges })) {
      return toolError(
        [
          `status: error`,
          "opencode returned an empty result",
          ...header,
          `stderr tail:\n${stderrTail}`,
        ].join("\n"),
      );
    }

    const body = ["status: success", ...header];
    if (hasError) {
      body.push(`errors observed during run:\n${redact(parsed.errorMessages.join("\n"))}`);
    }
    body.push("", safeText);
    return toolSuccess(body.join("\n"));
  });
}

const server = new McpServer({ name: "mcp-opencode", version: "0.1.0" });

server.registerTool(
  "opencode_run",
  {
    title: "Run OpenCode",
    description:
      "Start a new OpenCode CLI session to delegate an implementation task, with an explicit provider/model per call.",
    inputSchema: {
      prompt: z.string().describe("The task/prompt to send to opencode."),
      model: z
        .string()
        .regex(MODEL_RE, "model must look like provider/model, e.g. opencode/big-pickle")
        .describe("provider/model, e.g. anthropic/claude-sonnet-4-5"),
      cwd: z.string().describe("Working directory for opencode; must be inside an allowed root."),
      agent: z.enum(["build", "plan"]).default("build"),
      variant: z.string().optional().describe("Model variant, e.g. reasoning effort (high/max/minimal)."),
      timeoutSec: z.number().int().min(30).max(3600).default(900),
      maxCostUsd: z
        .number()
        .finite()
        .positive()
        .optional()
        .describe("Kill the run and return partial output if exceeded."),
    },
  },
  async (input, extra) => {
    try {
      return await executeRun(
        {
          model: input.model,
          cwd: input.cwd,
          agent: input.agent as Agent,
          prompt: input.prompt,
          variant: input.variant,
          timeoutSec: input.timeoutSec,
          maxCostUsd: input.maxCostUsd,
        },
        extra,
      );
    } catch (err) {
      return toolError(`opencode_run failed unexpectedly: ${redact(String(err))}`);
    }
  },
);

server.registerTool(
  "opencode_reply",
  {
    title: "Reply in OpenCode session",
    description:
      "Continue an existing OpenCode session by sessionID. Model is required explicitly on every call (no inheritance).",
    inputSchema: {
      sessionID: z.string().regex(SESSION_RE, "sessionID must look like ses_XXXX"),
      prompt: z.string(),
      model: z.string().regex(MODEL_RE, "model must look like provider/model"),
      cwd: z.string(),
      agent: z.enum(["build", "plan"]).default("build"),
      timeoutSec: z.number().int().min(30).max(3600).default(900),
    },
  },
  async (input, extra) => {
    try {
      return await executeRun(
        {
          model: input.model,
          cwd: input.cwd,
          agent: input.agent as Agent,
          prompt: input.prompt,
          sessionID: input.sessionID,
          timeoutSec: input.timeoutSec,
        },
        extra,
      );
    } catch (err) {
      return toolError(`opencode_reply failed unexpectedly: ${redact(String(err))}`);
    }
  },
);

server.registerTool(
  "opencode_models",
  {
    title: "List OpenCode models",
    description: "List models available to the local OpenCode CLI installation.",
    inputSchema: {},
  },
  async () => {
    try {
      const { stdout, stderr } = await execFileP("opencode", ["models"], { timeout: 30_000 });
      const out = stdout.trim();
      if (out.length === 0) {
        return toolError(`opencode models returned no output.\nstderr:\n${redact(stderr.slice(-2000))}`);
      }
      return toolSuccess(boundText(redact(out), 12_000));
    } catch (err: any) {
      const stderr = redact(String(err?.stderr ?? err?.message ?? err));
      return toolError(`Failed to list models: ${stderr}`);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("mcp-opencode: MCP stdio server for the OpenCode CLI");
  console.log("Usage: mcp-opencode");
} else {
  main().catch((err) => {
    console.error("Fatal error starting mcp-opencode:", err);
    process.exit(1);
  });
}
