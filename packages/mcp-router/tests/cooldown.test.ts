import { describe, it, expect } from "vitest";

import { CooldownRegistry, DEFAULT_COOLDOWNS } from "../src/cooldown.js";
import type { ErrorCategory } from "@mcp-coding-agents/core";

describe("CooldownRegistry", () => {
  it("capacity cooldown is active within TTL and inactive after expiry", () => {
    const reg = new CooldownRegistry();
    reg.record("e", "capacity", 0);
    expect(reg.isCooling("e", 5 * 60 * 1000)).toBe(true);
    expect(reg.isCooling("e", 10 * 60 * 1000 + 1)).toBe(false);
  });

  it("auth TTL is 30m and transport TTL is 5m via remainingSec", () => {
    const reg = new CooldownRegistry();
    reg.record("auth-entry", "auth", 0);
    expect(reg.remainingSec("auth-entry", 0)).toBe(30 * 60);
    expect(DEFAULT_COOLDOWNS.authMs).toBe(30 * 60 * 1000);

    reg.record("transport-entry", "transport", 0);
    expect(reg.remainingSec("transport-entry", 0)).toBe(5 * 60);
    expect(DEFAULT_COOLDOWNS.transportMs).toBe(5 * 60 * 1000);
  });

  it("non-cooldown categories are a no-op", () => {
    const reg = new CooldownRegistry();
    const noOps: ErrorCategory[] = ["task", "timeout", "empty", "model", "unknown"];
    for (const category of noOps) {
      reg.record("e", category, 0);
      expect(reg.isCooling("e", 0)).toBe(false);
      expect(reg.remainingSec("e", 0)).toBe(0);
    }
  });

  it("never shortens an active cooldown (capacity then transport)", () => {
    const reg = new CooldownRegistry();
    // capacity at t=0 -> expiry 600_000
    reg.record("e", "capacity", 0);
    // transport at t=1000 would expire at 301_000, which is sooner — must not shorten
    reg.record("e", "transport", 1000);
    // remaining still reflects the later capacity expiry
    expect(reg.remainingSec("e", 1000)).toBe(Math.ceil((600_000 - 1000) / 1000));
    expect(reg.isCooling("e", 301_000)).toBe(true);
    expect(reg.isCooling("e", 600_000)).toBe(false);
  });

  it("remainingSec returns 0 when not cooling; expired entry is evicted on access", () => {
    const reg = new CooldownRegistry();
    expect(reg.remainingSec("missing", 0)).toBe(0);

    reg.record("e", "capacity", 0);
    expect(reg.isCooling("e", 0)).toBe(true);

    // Past expiry: remainingSec returns 0 and evicts
    expect(reg.remainingSec("e", 10 * 60 * 1000)).toBe(0);
    // Evicted — not present even if we check slightly earlier wall-clock (entry gone)
    expect(reg.isCooling("e", 0)).toBe(false);

    reg.record("e2", "transport", 0);
    expect(reg.isCooling("e2", 5 * 60 * 1000)).toBe(false);
    expect(reg.remainingSec("e2", 0)).toBe(0);
  });
});
