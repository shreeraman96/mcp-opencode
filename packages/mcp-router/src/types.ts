// The cross-module contract for mcp-router. Every module compiles against this
// file; module-internal types stay in their own module. Nothing here hardcodes
// a backend model, provider, or path -- the router is setup-agnostic and every
// mapping is user-supplied at runtime via config.

import type { StructuredError, Provenance } from "@mcp-coding-agents/core";

/**
 * Fixed, product-owned routing vocabulary. Users NEVER invent tier names; they
 * only choose which model fills each slot. Three tiers is the market/academic
 * convergence point (see docs/phase2-plan.md). Names denote the user's declared
 * INTENT for the slot, not a model's inherent strength.
 */
export type TierName = "light" | "standard" | "heavy";
export const TIER_NAMES: readonly TierName[] = ["light", "standard", "heavy"] as const;

/**
 * Objective, discrete capability filters. v1 ships exactly one (`vision`).
 * Extensible: add a value here + a satisfying entry in config to grow the set.
 * A capability is a HARD filter -- a tier whose model lacks a required
 * capability is skipped for that call in favor of a slot that satisfies it.
 */
export type Capability = "vision";
export const CAPABILITIES: readonly Capability[] = ["vision"] as const;

/** Supported backend integrations. Extensible product feature, not a
 * user-specific assumption. `codex` is advisory-only in v1 (its own MCP). */
export type BackendName = "opencode" | "grok" | "codex";
export const BACKEND_NAMES: readonly BackendName[] = ["opencode", "grok", "codex"] as const;

/**
 * One authorized (backend, provider, model) mapping the user places into a tier
 * slot or a capability slot. `advisory` entries (codex today) are never spawned
 * by the router; it returns a hint to use that backend's own MCP server.
 */
export interface Entry {
  backend: BackendName;
  /** For opencode this is DERIVED from the model prefix and verified against any
   * declared value (a mislabel must not defeat the cross-provider gate). Grok is
   * always "xai". */
  provider?: string;
  /** Required unless `advisory`. Backend-native id, e.g. "<provider>/<model>". */
  model?: string;
  advisory?: boolean;
  /** Declared capabilities for this entry (e.g. ["vision"]). */
  capabilities?: Capability[];
}

export interface RouterConfig {
  // Each tier slot holds an ORDERED LIST of candidates tried in order (in-tier
  // fallback) before the cross-tier `fallbacks` chain continues. An empty array
  // = an unconfigured tier.
  tiers: Record<TierName, Entry[]>;
  capabilities: Partial<Record<Capability, Entry>>;
  /** Which tier an unconfigured/failed tier falls back to. */
  fallbacks: Partial<Record<TierName, TierName>>;
  /** Cross-provider fallback ships prompt + repo content to a second provider;
   * off by default, explicit opt-in. */
  allowCrossProviderFallback: boolean;
}

/** A concrete entry chosen for an attempt. `name` is the OPAQUE tier slot label
 * the caller sees (e.g. "standard"); `cooldownKey` is the CONTENT identity used
 * for cooldown/dedup, stable across config edits. The two are deliberately
 * distinct: keying cooldown on the tier name would let a list's sibling bypass a
 * cooldown on another, and putting an index in `name` would leak the user's
 * private config cardinality to an untrusted caller. */
export interface ResolvedEntry {
  /** Slot name only, e.g. "standard" or "vision". NEVER an index/position. */
  name: string;
  // Content identity for cooldown + dedup. non-advisory:
  // `${backend}|${provider}|${model}`; advisory: `advisory:${backend}`.
  cooldownKey: string;
  backend: BackendName;
  provider: string;
  model?: string;
  advisory: boolean;
}

/** Backend-agnostic result of ONE attempt, normalized from core's RunOutcome.
 * Deliberately carries NO "startedExecution" flag -- core cannot signal it
 * reliably, so eligibility uses provenance + the fingerprint gate only. */
export interface NormalizedOutcome {
  ok: boolean;
  errors: StructuredError[];
  text: string;
  sessionId?: string;
  elapsedSec: number;
  exitCode?: number | null;
}

export interface RunRequest {
  prompt: string;
  /** Already validated + realpath'd against MCP_ROUTER_ROOTS before this call. */
  cwd: string;
  model: string;
  provider: string;
  timeoutSec: number;
  signal: AbortSignal;
  onHeartbeat?: (elapsedSec: number, progress: number) => void;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
}

/** The backend adapter contract. Adapters wrap core runOpencode/runGrok +
 * classifiers; the router never re-implements spawn/parse/redact. */
export interface Backend {
  readonly name: BackendName;
  /** Derive the true provider for an entry, rejecting a declared mislabel. */
  provider(entry: Entry): string;
  /** Capabilities this entry satisfies. */
  capabilities(entry: Entry): Set<Capability>;
  /** Bounded exec, no network. Cached with a short TTL by the caller. */
  detect(): Promise<DetectResult>;
  run(req: RunRequest): Promise<NormalizedOutcome>;
}

/**
 * Coarse, non-sensitive reason surfaced to the (untrusted) caller in traces and
 * cooldown output. NEVER expose the raw core ErrorCategory here: "auth" vs
 * "capacity" leaks live per-provider credential health. The fallback logic uses
 * the real category internally; only `report.ts` maps down to this.
 */
export type CoarseReason =
  | "ok"
  | "unavailable" // capacity / auth / transport collapsed into one opaque bucket
  | "timeout"
  | "empty"
  | "task-failed"
  | "not-installed"
  | "aborted";

export interface AttemptRecord {
  entry: string;
  reason: CoarseReason;
  provenance: Provenance;
  elapsedSec: number;
  /** Whether the backend changed the git working tree. `undefined` = not
   * measurable (non-git cwd or an unreliable git read); rendered as "unknown". */
  editedTree: boolean | undefined;
}

export interface RouteResult {
  ok: boolean;
  servedBy?: ResolvedEntry;
  trace: AttemptRecord[];
  /** Set iff a fallback crossed provider boundaries (user opted in). */
  crossProviderNotice?: string;
  /** Redacted assistant text on success or terminal partial output. */
  text?: string;
}
