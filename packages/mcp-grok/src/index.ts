#!/usr/bin/env node
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_SEC,
  MAX_TURNS,
  MODEL_RE,
  SESSION_RE,
  boundText,
  classifyError,
  isEmptyResult,
  redact,
  validateCwd,
} from "./policy.js";
import { CwdQueue } from "./queue.js";
import { runGrok, type GrokRunMode } from "./run.js";

const execFileP = promisify(execFile);
const queue = new CwdQueue();
const CLI_OUTPUT_CAP = 12_000;

function toolError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false };
}

export function buildModelsArgs(leaderSocket?: string): string[] {
  return leaderSocket
    ? ["--no-auto-update", "--leader-socket", leaderSocket, "models"]
    : ["--no-auto-update", "models"];
}

/** `inspect` rejects --cwd; the child cwd carries the requested directory. */
export function buildInspectArgs(): string[] {
  return ["--no-auto-update", "inspect", "--json"];
}

function execDiagnostic(err: any): string {
  return [err?.stderr, err?.stdout, err?.message, String(err)]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join("\n");
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
    return undefined;
  }

  try {
    const [diffStat, status] = await Promise.all([
      execFileP("git", ["-C", cwd, "diff", "--stat"], GIT_EXEC_OPTS),
      execFileP("git", ["-C", cwd, "status", "--porcelain"], GIT_EXEC_OPTS),
    ]);
    const untracked = status.stdout
      .split("\n")
      .filter((line) => line.startsWith("??"))
      .join("\n");
    const chunks = [diffStat.stdout.trim(), untracked.trim()].filter((value) => value.length > 0);
    return chunks.length > 0 ? boundText(redact(chunks.join("\n")), CLI_OUTPUT_CAP) : "(no changes detected)";
  } catch {
    return undefined;
  }
}

async function listModels(): Promise<ReturnType<typeof toolSuccess> | ReturnType<typeof toolError>> {
  let tempDirectory: string | undefined;
  try {
    tempDirectory = await mkdtemp(path.join(tmpdir(), "mcp-grok-models-"));
    const leaderSocket = path.join(tempDirectory, "leader.sock");
    const { stdout, stderr } = await execFileP("grok", buildModelsArgs(leaderSocket), {
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    const output = boundText(redact(stdout.trim()), CLI_OUTPUT_CAP);
    if (output.length === 0) {
      return toolError(`grok models returned no output.\nstderr:\n${boundText(redact(stderr), CLI_OUTPUT_CAP)}`);
    }
    return toolSuccess(output);
  } catch (err: any) {
    const diagnostic = execDiagnostic(err);
    const classified = classifyError(diagnostic, "(unspecified)");
    return toolError(
      `Failed to list Grok models: ${classified ?? boundText(redact(diagnostic), CLI_OUTPUT_CAP)}`,
    );
  } finally {
    if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function inspectGrok(
  cwd: string,
): Promise<ReturnType<typeof toolSuccess> | ReturnType<typeof toolError>> {
  const validation = await validateCwd(cwd);
  if (!validation.ok) return toolError(`Invalid cwd: ${validation.error}`);

  try {
    const { stdout, stderr } = await execFileP("grok", buildInspectArgs(), {
      cwd: validation.resolved,
      timeout: 30_000,
      maxBuffer: 256 * 1024,
    });
    const output = boundText(redact(stdout.trim()), CLI_OUTPUT_CAP);
    if (output.length === 0) {
      return toolError(`grok inspect returned no output.\nstderr:\n${boundText(redact(stderr), CLI_OUTPUT_CAP)}`);
    }
    return toolSuccess(output);
  } catch (err: any) {
    const diagnostic = execDiagnostic(err);
    const classified = classifyError(diagnostic, "(inspect)");
    return toolError(
      `Failed to inspect Grok configuration: ${classified ?? boundText(redact(diagnostic), CLI_OUTPUT_CAP)}`,
    );
  }
}

interface CommonRunArgs {
  model: string;
  cwd: string;
  prompt: string;
  sessionID?: string;
  mode: GrokRunMode;
  effort?: string;
  maxTurns: number;
  timeoutSec: number;
}

async function executeRun(
  args: CommonRunArgs,
  extra: {
    signal: AbortSignal;
    _meta?: { progressToken?: unknown };
    sendNotification: (notification: any) => Promise<void>;
  },
) {
  const validation = await validateCwd(args.cwd);
  if (!validation.ok) return toolError(`Invalid cwd: ${validation.error}`);
  const resolvedCwd = validation.resolved!;

  const progressToken = extra._meta?.progressToken;
  const onHeartbeat =
    progressToken === undefined
      ? undefined
      : (elapsedSec: number, progress: number) => {
          void extra
            .sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress,
                message: `grok running (${elapsedSec}s)`,
              },
            })
            .catch(() => undefined);
        };

  return queue.run(resolvedCwd, async () => {
    const outcome = await runGrok({
      model: args.model,
      cwd: resolvedCwd,
      prompt: args.prompt,
      sessionID: args.sessionID,
      mode: args.mode,
      effort: args.effort,
      maxTurns: args.maxTurns,
      timeoutSec: args.timeoutSec,
      signal: extra.signal,
      onHeartbeat,
    });

    const changedFiles = await gitChangedFiles(resolvedCwd);
    const header = [
      `sessionID: ${outcome.sessionID}`,
      `model: ${args.model}`,
      `mode: ${args.mode}`,
      `elapsed: ${outcome.elapsedSec.toFixed(1)}s`,
      `stopReason: ${outcome.parsed.stopReason ?? "n/a"}`,
    ];
    if (changedFiles !== undefined) header.push(`changed files:\n${changedFiles}`);
    if (
      outcome.parsed.malformedLines > 0 ||
      outcome.parsed.oversizedLines > 0 ||
      outcome.parsed.unknownEvents > 0
    ) {
      header.push(
        `parser notes: ${outcome.parsed.malformedLines} malformed line(s), ${outcome.parsed.oversizedLines} oversized line(s), ${outcome.parsed.unknownEvents} unknown event(s) skipped`,
      );
    }

    if (outcome.reason === "abort") {
      return toolError(["status: aborted", ...header, `stderr tail:\n${outcome.stderrTail}`].join("\n"));
    }
    if (outcome.reason === "timeout") {
      return toolError(
        [`status: timeout after ${args.timeoutSec}s`, ...header, `stderr tail:\n${outcome.stderrTail}`].join(
          "\n",
        ),
      );
    }

    const observedErrors = outcome.parsed.errorMessages.map(redact).join("\n");
    if (outcome.exitCode !== 0) {
      const diagnostic = `${observedErrors}\n${outcome.stderrTail}`;
      const classified = classifyError(diagnostic, args.model);
      const message = classified ?? `grok exited with code ${outcome.exitCode ?? "unknown"}`;
      return toolError(
        [
          "status: error",
          message,
          ...header,
          observedErrors.length > 0 ? `errors observed during run:\n${observedErrors}` : undefined,
          `stderr tail:\n${outcome.stderrTail}`,
        ]
          .filter((part): part is string => part !== undefined)
          .join("\n"),
      );
    }

    const safeText = redact(outcome.parsed.text);
    const hasText = safeText.trim().length > 0;
    const hasError = observedErrors.length > 0;
    const hasChanges = changedFiles !== undefined && changedFiles !== "(no changes detected)";
    if (isEmptyResult({ hasText, hasError, hasChanges })) {
      return toolError(
        [
          "status: error",
          "grok returned an empty result",
          ...header,
          `stderr tail:\n${outcome.stderrTail}`,
        ].join("\n"),
      );
    }

    const body = ["status: success", ...header];
    if (hasError) body.push(`errors observed during run:\n${observedErrors}`);
    body.push("", safeText || "(no assistant text; on-disk changes detected)");
    return toolSuccess(body.join("\n"));
  });
}

const server = new McpServer({ name: "mcp-grok", version: "0.1.0" });

server.registerTool(
  "grok_run",
  {
    title: "Run Grok",
    description:
      "Start a new Grok Build CLI session with an explicit model and working directory. The generated UUID is returned for grok_reply.",
    inputSchema: {
      prompt: z.string().describe("The task/prompt to send to Grok."),
      cwd: z.string().describe("Working directory for Grok; must be inside an allowed root."),
      model: z
        .string()
        .regex(MODEL_RE, "model must be a simple Grok model ID such as grok-4.5"),
      effort: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      maxTurns: z.number().int().min(1).max(MAX_TURNS).default(DEFAULT_MAX_TURNS),
      timeoutSec: z.number().int().min(30).max(3600).default(DEFAULT_TIMEOUT_SEC),
    },
  },
  async (input, extra) => {
    try {
      return await executeRun(
        {
          model: input.model,
          cwd: input.cwd,
          prompt: input.prompt,
          mode: "new",
          effort: input.effort,
          maxTurns: input.maxTurns,
          timeoutSec: input.timeoutSec,
        },
        extra,
      );
    } catch (err) {
      return toolError(`grok_run failed unexpectedly: ${redact(String(err))}`);
    }
  },
);

server.registerTool(
  "grok_reply",
  {
    title: "Reply in Grok session",
    description:
      "Continue an existing Grok Build CLI session. The caller must provide the same cwd used for the original session.",
    inputSchema: {
      sessionID: z.string().regex(SESSION_RE, "sessionID must be a canonical UUIDv4"),
      prompt: z.string().describe("The follow-up task/prompt to send to Grok."),
      cwd: z.string().describe("The same working directory used by the original Grok session."),
      model: z.string().regex(MODEL_RE, "model must be a simple Grok model ID"),
      effort: z.string().regex(/^[A-Za-z0-9._-]+$/).optional(),
      maxTurns: z.number().int().min(1).max(MAX_TURNS).default(DEFAULT_MAX_TURNS),
      timeoutSec: z.number().int().min(30).max(3600).default(DEFAULT_TIMEOUT_SEC),
    },
  },
  async (input, extra) => {
    try {
      return await executeRun(
        {
          sessionID: input.sessionID,
          model: input.model,
          cwd: input.cwd,
          prompt: input.prompt,
          mode: "reply",
          effort: input.effort,
          maxTurns: input.maxTurns,
          timeoutSec: input.timeoutSec,
        },
        extra,
      );
    } catch (err) {
      return toolError(`grok_reply failed unexpectedly: ${redact(String(err))}`);
    }
  },
);

server.registerTool(
  "grok_models",
  {
    title: "List Grok models",
    description: "List models available to the local Grok Build CLI installation.",
    inputSchema: {},
  },
  async () => listModels(),
);

server.registerTool(
  "grok_inspect",
  {
    title: "Inspect Grok configuration",
    description: "Show the configuration Grok discovers for an allowed working directory.",
    inputSchema: {
      cwd: z.string().describe("Working directory to inspect; must be inside an allowed root."),
    },
  },
  async (input) => inspectGrok(input.cwd),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

let isMainModule = false;
if (process.argv[1] !== undefined) {
  try {
    isMainModule = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isMainModule = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}
if (isMainModule) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("mcp-grok: MCP stdio server for the Grok Build CLI");
    console.log("Usage: mcp-grok");
  } else {
    main().catch((err) => {
      console.error("Fatal error starting mcp-grok:", redact(String(err)));
      process.exit(1);
    });
  }
}
