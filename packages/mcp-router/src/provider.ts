// Provider derivation + the cross-provider egress gate. This is security-relevant
// (the "don't silently ship repo content to a second provider" boundary depends
// on it), so the derivation rule is owned here, not duplicated per adapter.
// Nothing here hardcodes a user model -- it only parses the shape the user gave.

import type { BackendName } from "./types.js";

/**
 * Known meta-aggregator prefixes. Their true downstream provider is opaque
 * (an `openrouter/...` model may be served by anthropic, openai, etc., under
 * different data terms), so we treat each as ALWAYS cross-provider for the
 * egress gate rather than trusting the prefix as a real provider identity.
 */
const AGGREGATOR_PREFIXES = new Set<string>(["openrouter", "github-copilot"]);

/**
 * Derive the true provider for a (backend, model) pair. For opencode the
 * provider is the model prefix ("provider/rest"); grok is always xai; codex is
 * advisory and reported as openai. Throws on a malformed opencode model so a
 * mislabel can never silently defeat the gate.
 */
export function deriveProvider(backend: BackendName, model: string | undefined): string {
  if (backend === "grok") return "xai";
  if (backend === "codex") return "openai";
  if (!model || model.indexOf("/") <= 0) {
    throw new Error(`opencode model must look like "provider/model": got ${model ?? "(none)"}`);
  }
  return model.slice(0, model.indexOf("/"));
}

export function isAggregatorProvider(provider: string): boolean {
  return AGGREGATOR_PREFIXES.has(provider);
}

/**
 * Whether a fallback from provider `a` to provider `b` crosses a provider
 * boundary (and therefore requires `allowCrossProviderFallback`). If either
 * side is an aggregator we cannot prove the downstream is the same provider, so
 * we conservatively treat it as a crossing.
 */
export function crossesProvider(a: string, b: string): boolean {
  if (isAggregatorProvider(a) || isAggregatorProvider(b)) return true;
  return a !== b;
}
