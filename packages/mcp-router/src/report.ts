// The reporting boundary: map the internal core ErrorCategory down to the
// coarse, non-sensitive CoarseReason surfaced to (untrusted) callers, and
// format a RouteResult into the plain-text MCP tool response. The coarse
// mapping is a SECURITY boundary -- "auth" vs "capacity" vs "transport" are
// deliberately collapsed into "unavailable" so a caller cannot probe live
// per-provider credential health from traces. The fallback/cooldown logic
// retains the real category internally; only this module reduces it.

import type { ErrorCategory } from "@mcp-coding-agents/core";
import type { CoarseReason, RouteResult } from "./types.js";

/**
 * Reduce a core `ErrorCategory` (plus caller-supplied flags) to the coarse,
 * non-sensitive reason exposed in traces and cooldown output. The `aborted`
 * and `notInstalled` flags take precedence over `category` because they
 * describe the invocation shape, not a provider-health signal.
 */
export function coarseReason(
  category: ErrorCategory | undefined,
  opts?: { aborted?: boolean; notInstalled?: boolean },
): CoarseReason {
  if (opts?.aborted === true) return "aborted";
  if (opts?.notInstalled === true) return "not-installed";
  switch (category) {
    // Collapsed on purpose: surfacing the split would leak per-provider
    // credential/capacity health to an untrusted caller.
    case "capacity":
    case "auth":
    case "transport":
      return "unavailable";
    case "timeout":
      return "timeout";
    case "empty":
      return "empty";
    case "task":
    case "model":
    case "unknown":
      return "task-failed";
    case undefined:
      return "ok";
    default:
      // Unreachable for the current ErrorCategory union; bucket any future
      // value into the opaque failure reason rather than throwing.
      return "task-failed";
  }
}

/**
 * Format a `RouteResult` as a deterministic, human-readable plain-text block
 * for the MCP tool response. Never throws on missing optional fields; the
 * assistant `text` is already redacted upstream and is passed through verbatim.
 */
export function formatRouteResult(result: RouteResult): string {
  const lines: string[] = [];

  const served = result.ok && result.servedBy ? result.servedBy : undefined;
  if (served) {
    // Advisory entries carry no backend-native model id by contract, so the
    // slot renders the literal "advisory" rather than a model path.
    const modelOrAdvisory = served.model ?? "advisory";
    lines.push(
      `served-by: ${served.name} (${served.backend} · ${served.provider}/${modelOrAdvisory})`,
    );
  } else {
    lines.push("served-by: (none)");
  }

  for (const attempt of result.trace) {
    // `provenance` is intentionally NOT surfaced: "spawn" vs "stream" vs
    // "inferred" partially re-discriminates the "unavailable" bucket this
    // module collapses (e.g. spawn => transport), so it stays internal.
    const editedTree = attempt.editedTree === undefined ? "unknown" : String(attempt.editedTree);
    lines.push(
      `attempt: ${attempt.entry} · ${attempt.reason} · ${attempt.elapsedSec.toFixed(1)}s · editedTree=${editedTree}`,
    );
  }

  if (result.crossProviderNotice) {
    lines.push(`cross-provider: ${result.crossProviderNotice}`);
  }

  // Blank line separating the trace header from the assistant payload.
  lines.push("");
  lines.push(result.text ?? "");

  return lines.join("\n");
}
