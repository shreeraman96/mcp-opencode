// The wizard's config-file shape + the single validation entry point it shares
// with the server. An InitSpec is the exact JSON the wizard writes to
// config.json — nothing here re-derives providers or re-implements authorize;
// validateSpec always routes through validateConfigObject (config.ts) so a
// spec the wizard accepts is BY CONSTRUCTION a spec the server will accept.

import { validateConfigObject } from "../config.js";
import type { Capability, Entry, RouterConfig, TierName } from "../types.js";

/** Mirrors the raw JSON shape config.ts's schema accepts: a tier slot is a
 * single Entry, an ordered Entry[] (in-tier fallback chain), or null
 * (unconfigured). Serializes to config.json verbatim. */
export interface InitSpec {
  tiers: Record<TierName, Entry | Entry[] | null>;
  capabilities: Partial<Record<Capability, Entry>>;
  fallbacks: Partial<Record<TierName, TierName>>;
  allowCrossProviderFallback: boolean;
}

export function specToJson(spec: InitSpec): string {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

export type ValidateSpecResult = { ok: true; config: RouterConfig } | { ok: false; error: string };

/**
 * The single validation entry point for the wizard's preview and accept
 * steps. Wraps validateConfigObject so a malformed spec never throws past the
 * wizard's control flow — the caller always gets a message to show the user
 * or re-prompt on.
 */
export function validateSpec(spec: InitSpec): ValidateSpecResult {
  try {
    return { ok: true, config: validateConfigObject(spec) };
  } catch (error) {
    return { ok: false, error: (error as Error).message ?? String(error) };
  }
}
