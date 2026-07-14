import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { runOpencode, classifyOpencode, redact } from "@mcp-coding-agents/core/backends/opencode.js";

import { deriveProvider } from "../provider.js";
import { normalizeOutcome } from "../normalize.js";
import type { Backend, Capability, DetectResult, Entry, NormalizedOutcome, RunRequest } from "../types.js";

const execFile = promisify(execFileCallback);

export class OpencodeBackend implements Backend {
  readonly name = "opencode" as const;

  provider(entry: Entry): string {
    return deriveProvider("opencode", entry.model);
  }

  capabilities(entry: Entry): Set<Capability> {
    return new Set(entry.capabilities ?? []);
  }

  async detect(): Promise<DetectResult> {
    try {
      const result = await execFile("opencode", ["--version"], { timeout: 5000, encoding: "utf8" });
      return { installed: true, version: result.stdout.trim() };
    } catch {
      return { installed: false };
    }
  }

  async run(req: RunRequest): Promise<NormalizedOutcome> {
    const outcome = await runOpencode({
      model: req.model,
      cwd: req.cwd,
      agent: "build",
      prompt: req.prompt,
      timeoutSec: req.timeoutSec,
      signal: req.signal,
      onHeartbeat: req.onHeartbeat,
    });
    const classified = classifyOpencode({
      reason: outcome.reason,
      stderrTail: outcome.stderrTail,
      parsed: outcome.parsed,
    });
    return normalizeOutcome(
      {
        reason: outcome.reason,
        exitCode: outcome.exitCode,
        elapsedSec: outcome.elapsedSec,
        parsedText: redact(outcome.parsed.text),
        errorMessages: outcome.parsed.errorMessages,
        sessionId: outcome.parsed.sessionID,
      },
      classified,
      "opencode",
    );
  }
}
