import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { runGrok, classifyGrok, redact as grokRedact } from "@mcp-coding-agents/core/backends/grok.js";

import { deriveProvider } from "../provider.js";
import { normalizeOutcome } from "../normalize.js";
import type { Backend, Capability, DetectResult, Entry, NormalizedOutcome, RunRequest } from "../types.js";

const execFile = promisify(execFileCallback);

export class GrokBackend implements Backend {
  readonly name = "grok" as const;

  // Provider is fixed for grok; deriveProvider centralizes the rule.
  provider(_entry: Entry): string {
    return deriveProvider("grok", undefined);
  }

  capabilities(entry: Entry): Set<Capability> {
    return new Set(entry.capabilities ?? []);
  }

  async detect(): Promise<DetectResult> {
    try {
      const result = await execFile("grok", ["--version"], { timeout: 5000, encoding: "utf8" });
      return { installed: true, version: result.stdout.trim() };
    } catch {
      return { installed: false };
    }
  }

  async run(req: RunRequest): Promise<NormalizedOutcome> {
    const outcome = await runGrok({
      model: req.model,
      cwd: req.cwd,
      prompt: req.prompt,
      timeoutSec: req.timeoutSec,
      signal: req.signal,
      onHeartbeat: req.onHeartbeat,
    });
    // grok capacity/auth signals are provenance:"inferred" (free-text); the
    // router's fingerprint gate — not this classification — is what makes any
    // fallback safe, so the model-influenced errorMessages are safe to classify.
    const diagnostic = [outcome.stderrTail, ...outcome.parsed.errorMessages].join("\n");
    const classified = classifyGrok(diagnostic);
    return normalizeOutcome(
      {
        reason: outcome.reason,
        exitCode: outcome.exitCode,
        elapsedSec: outcome.elapsedSec,
        parsedText: grokRedact(outcome.parsed.text),
        errorMessages: outcome.parsed.errorMessages,
        sessionId: outcome.parsed.sessionID,
      },
      classified,
      "grok",
    );
  }
}
