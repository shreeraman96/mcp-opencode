// Per-entry cooldown registry: after a fallback-worthy failure, mark a named
// config entry temporarily unavailable with a bounded TTL. The stored state is
// only an expiry timestamp -- the failure category that armed the cooldown is
// intentionally NOT retained, so callers reading this state cannot learn
// whether a cooldown was auth vs capacity (that would leak live per-provider
// credential health to an untrusted caller). The category is used only to pick
// the TTL length at record() time and is then discarded.

import type { ErrorCategory } from "@mcp-coding-agents/core";

export interface CooldownConfig {
  capacityMs: number;
  authMs: number;
  transportMs: number;
}

// TTL choices:
// - capacity: 10 min. Rate-limit / queue-full bursts are usually transient;
//   ten minutes lets a quota window clear without stranding the entry.
// - auth: 30 min. An auth failure implies a credential/config problem a human
//   must fix, so the cooldown is long enough to avoid hammering a broken key
//   yet still self-heals once the key is rotated.
// - transport: 5 min. Connection-reset / DNS blips are the most transient;
//   five minutes covers a brief network outage without a long lockout.
export const DEFAULT_COOLDOWNS: CooldownConfig = {
  capacityMs: 10 * 60 * 1000,
  authMs: 30 * 60 * 1000,
  transportMs: 5 * 60 * 1000,
};

export class CooldownRegistry {
  // entryName -> expiry epoch ms. Bounded: entries are lazily evicted on read
  // once expired, so the Map does not grow without bound.
  private readonly entries: Map<string, number> = new Map();
  private readonly cfg: CooldownConfig;

  constructor(config?: CooldownConfig) {
    this.cfg = config ?? DEFAULT_COOLDOWNS;
  }

  record(entryName: string, category: ErrorCategory, nowMs: number): void {
    // Only the "unavailable" categories arm a cooldown; model/timeout/task/
    // empty/unknown are per-invocation failures, not entry-health signals, and
    // are ignored here.
    let ttl: number | undefined;
    if (category === "capacity") ttl = this.cfg.capacityMs;
    else if (category === "auth") ttl = this.cfg.authMs;
    else if (category === "transport") ttl = this.cfg.transportMs;
    if (ttl === undefined) return;

    const expiry = nowMs + ttl;
    const existing = this.entries.get(entryName);
    // Never shorten an active cooldown: a fresh failure on an already-cooling
    // entry must not let it back in sooner. Keep whichever expiry is later.
    if (existing !== undefined && existing >= expiry) return;
    this.entries.set(entryName, expiry);
  }

  isCooling(entryName: string, nowMs: number): boolean {
    const expiry = this.entries.get(entryName);
    if (expiry === undefined) return false;
    if (expiry <= nowMs) {
      // Lazy eviction on access keeps the Map bounded.
      this.entries.delete(entryName);
      return false;
    }
    return true;
  }

  remainingSec(entryName: string, nowMs: number): number {
    const expiry = this.entries.get(entryName);
    if (expiry === undefined) return 0;
    if (expiry <= nowMs) {
      this.entries.delete(entryName);
      return 0;
    }
    return Math.ceil((expiry - nowMs) / 1000);
  }
}
