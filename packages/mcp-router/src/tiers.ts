// Tier resolution + capability filtering + fallback ordering. Pure: no I/O,
// no clock. Turns a caller's (tier, requiredCaps) request plus user config into
// an ordered list of concrete entries to attempt. Capability is a HARD filter;
// tier is the routing axis; unconfigured tiers follow the fallbacks map.

import type {
  Capability,
  Entry,
  ResolvedEntry,
  RouterConfig,
  TierName,
} from "./types.js";

/** Cap on the FINAL resolved candidate list. Bounds fallback fan-out / egress
 * amplification / deadline drain across the in-tier lists plus the cross-tier
 * chain. The head (highest-priority candidates) is kept when truncated. */
export const MAX_RESOLVED = 6;

export interface ResolveResult {
  entries: ResolvedEntry[];
  notes: string[];
}

interface Candidate {
  slot: string;
  entry: Entry;
}

export function resolveEntries(args: {
  config: RouterConfig;
  tier: TierName;
  caps: Capability[];
  isCooling: (key: string) => boolean;
}): ResolveResult {
  const { config, tier, caps, isCooling } = args;
  const notes: string[] = [];

  // --- Fallback-chain walk ---
  // Start at the requested tier and follow config.fallbacks through the chain,
  // collecting EVERY configured candidate from every visited tier, in order.
  // Within a tier, list order is the in-tier fallback order; tiers reached via
  // the cross-tier fallbacks map append after. Cycle-safe: every visited tier
  // name is tracked and a repeat stops the walk, so a misconfigured fallback
  // cycle cannot loop forever. An unconfigured (empty) tier that redirects to a
  // fresh fallback target is recorded in the trace.
  const candidates: Candidate[] = [];
  const visited = new Set<TierName>();
  let current: TierName | undefined = tier;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const list = config.tiers[current] ?? [];
    for (const entry of list) {
      candidates.push({ slot: current, entry });
    }
    const next: TierName | undefined = config.fallbacks[current];
    if (list.length === 0 && next !== undefined && !visited.has(next)) {
      notes.push(`tier '${current}' unconfigured -> fell back to '${next}'`);
    }
    current = next;
  }

  // --- Capability HARD filter ---
  // Capability is non-negotiable: a candidate whose entry lacks a requested
  // capability is dropped for this call. If every candidate is filtered out,
  // fall back to the dedicated capability slots; if one of those satisfies ALL
  // requested caps it becomes the single resolved candidate. If nothing
  // satisfies the caps, return empty so the caller can surface an error.
  let resolved: Candidate[];
  if (caps.length > 0) {
    const filtered = candidates.filter((c) => satisfiesAll(c.entry, caps));
    if (filtered.length > 0) {
      resolved = filtered;
    } else {
      const capCandidate = findCapabilityEntry(config, caps);
      if (capCandidate) {
        notes.push(
          `no tier entry satisfied capabilities [${caps.join(", ")}] -> routing switched to capability slot '${capCandidate.slot}'`,
        );
        resolved = [capCandidate];
      } else {
        return {
          entries: [],
          notes: [
            `no configured entry satisfies required capabilities [${caps.join(", ")}]`,
          ],
        };
      }
    }
  } else {
    resolved = candidates;
  }

  // --- Dedup by content identity (BEFORE cooling) ---
  // Dedup MUST precede cooling: the same model reached via an in-tier list AND
  // the cross-tier chain would otherwise be evaluated twice, and a cooldown on
  // one copy would be bypassed by the other. The key is the CONTENT identity
  // (same as cooldownKey), never the slot name. Preserve first occurrence so the
  // primary slot wins over an identical fallback.
  const seen = new Set<string>();
  const unique: Candidate[] = [];
  for (const c of resolved) {
    const key = cooldownKey(c.entry);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(c);
  }

  // --- Cooling drop (by content key) ---
  // Cooldown is keyed by content identity: an entry that recently failed is
  // skipped until its TTL elapses. The category that armed the cooldown is not
  // visible here. The note surfaces the opaque tier slot name only, and is
  // emitted at most once per slot so the count of cooling candidates in a tier
  // (the user's private config cardinality) is not leaked to the caller.
  const active: Candidate[] = [];
  const coolingNoted = new Set<string>();
  for (const c of unique) {
    if (isCooling(cooldownKey(c.entry))) {
      if (!coolingNoted.has(c.slot)) {
        notes.push(`entry '${c.slot}' cooling, skipped`);
        coolingNoted.add(c.slot);
      }
      continue;
    }
    active.push(c);
  }

  // --- Cap the resolved fan-out ---
  // Bound fallback fan-out / egress amplification / deadline drain across the
  // in-tier lists plus the cross-tier chain. Keep the head when truncated.
  const final = active.length > MAX_RESOLVED ? active.slice(0, MAX_RESOLVED) : active;
  if (active.length > MAX_RESOLVED) {
    notes.push(`resolved candidates capped at ${MAX_RESOLVED}`);
  }

  // --- Materialize ResolvedEntry records ---
  // `name` is the opaque tier slot label ONLY (never an index/position -- that
  // would leak the user's private config cardinality to an untrusted caller);
  // `cooldownKey` is the content identity. Provider is carried through verbatim
  // ("" if absent); model is optional (absent for advisory); advisory is coerced
  // to a strict boolean.
  const entries: ResolvedEntry[] = final.map((c) => ({
    name: c.slot,
    cooldownKey: cooldownKey(c.entry),
    backend: c.entry.backend,
    provider: c.entry.provider ?? "",
    model: c.entry.model,
    advisory: c.entry.advisory === true,
  }));

  return { entries, notes };
}

/** An entry satisfies capability c iff it explicitly declares it. */
function satisfiesAll(entry: Entry, caps: Capability[]): boolean {
  return caps.every((c) => entry.capabilities?.includes(c) === true);
}

/** Content identity for an entry: the cooldown + dedup key, stable across config
 * edits. Advisory entries carry no model, so they key on backend only. */
export function cooldownKey(entry: Entry): string {
  if (entry.advisory === true) return `advisory:${entry.backend}`;
  return `${entry.backend}|${entry.provider ?? ""}|${entry.model ?? ""}`;
}

/**
 * Look up config.capabilities for a single entry that satisfies ALL requested
 * caps. Iterates the requested caps in order and returns the first capability
 * slot whose entry declares every requested cap, with slotName = that
 * capability name (e.g. "vision").
 */
function findCapabilityEntry(
  config: RouterConfig,
  caps: Capability[],
): Candidate | undefined {
  for (const cap of caps) {
    const entry = config.capabilities[cap];
    if (entry && satisfiesAll(entry, caps)) {
      return { slot: cap, entry };
    }
  }
  return undefined;
}
