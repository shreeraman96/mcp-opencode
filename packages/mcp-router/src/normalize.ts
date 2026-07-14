// The single place a backend RunOutcome becomes a NormalizedOutcome -- i.e.
// where the fallback-eligibility category is born. Both adapters call this so
// the decision cannot drift between backends (previously copy-pasted).

import type { RunReason } from "@mcp-coding-agents/core";
import type { StructuredError } from "@mcp-coding-agents/core/errors.js";
import type { NormalizedOutcome } from "./types.js";

export interface CoreRunOutcome {
  reason: RunReason; // "exit" | "abort" | "timeout" | "cost-cap"
  exitCode: number | null;
  elapsedSec: number;
  /** Already redacted assistant text. */
  parsedText: string;
  /** Non-fatal errors observed on the run's error channel. */
  errorMessages: string[];
  sessionId?: string;
}

export function normalizeOutcome(
  core: CoreRunOutcome,
  classified: StructuredError[],
  backendLabel: string,
): NormalizedOutcome {
  const errors: StructuredError[] = [...classified];
  const text = core.parsedText;
  let ok: boolean;

  if (core.reason === "exit" && core.exitCode === 0) {
    const hasText = text.trim().length > 0;
    const hasError = core.errorMessages.length > 0;
    if (!hasText && !hasError) {
      ok = false;
      errors.push({ category: "empty", provenance: "exit", message: `${backendLabel} returned an empty result` });
    } else {
      ok = true;
    }
  } else if (core.reason === "exit") {
    ok = false;
    if (errors.length === 0) {
      errors.push({ category: "task", provenance: "exit", message: `${backendLabel} exited with code ${core.exitCode}` });
    }
  } else if (core.reason === "timeout") {
    ok = false; // classify* already emits a timeout error
  } else if (core.reason === "abort") {
    ok = false; // the router detects client abort via the AbortSignal
  } else {
    ok = false;
    errors.push({ category: "task", provenance: "exit", message: "cost cap exceeded" });
  }

  return { ok, errors, text, sessionId: core.sessionId, elapsedSec: core.elapsedSec, exitCode: core.exitCode };
}
