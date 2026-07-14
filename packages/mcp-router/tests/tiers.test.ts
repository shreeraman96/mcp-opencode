import { describe, it, expect } from "vitest";

import { resolveEntries, cooldownKey, MAX_RESOLVED } from "../src/tiers.js";
import type { Entry, RouterConfig } from "../src/types.js";

const baseEntry = (overrides: Partial<Entry> & Pick<Entry, "backend">): Entry => ({
  model: "prov/model-a",
  provider: "prov",
  ...overrides,
});

function config(partial: {
  tiers?: Partial<RouterConfig["tiers"]>;
  capabilities?: RouterConfig["capabilities"];
  fallbacks?: RouterConfig["fallbacks"];
  allowCrossProviderFallback?: boolean;
}): RouterConfig {
  return {
    tiers: {
      light: [],
      standard: [],
      heavy: [],
      ...partial.tiers,
    },
    capabilities: partial.capabilities ?? {},
    fallbacks: partial.fallbacks ?? {},
    allowCrossProviderFallback: partial.allowCrossProviderFallback ?? false,
  };
}

describe("resolveEntries", () => {
  it("simple: configured standard tier, no caps -> one entry named standard", () => {
    const result = resolveEntries({
      config: config({
        tiers: {
          standard: [baseEntry({ backend: "opencode", model: "prov/model-a" })],
        },
      }),
      tier: "standard",
      caps: [],
      isCooling: () => false,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe("standard");
    expect(result.entries[0]!.backend).toBe("opencode");
    expect(result.entries[0]!.model).toBe("prov/model-a");
    expect(result.entries[0]!.cooldownKey).toBe("opencode|prov|prov/model-a");
  });

  it("unconfigured tier follows fallbacks with a note", () => {
    const result = resolveEntries({
      config: config({
        tiers: {
          light: [],
          standard: [baseEntry({ backend: "opencode", model: "prov/model-a" })],
        },
        fallbacks: { light: "standard" },
      }),
      tier: "light",
      caps: [],
      isCooling: () => false,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe("standard");
    expect(result.notes.some((n) => /fell back/i.test(n) && n.includes("light"))).toBe(true);
  });

  it("capability HARD filter switches to vision slot with a note", () => {
    const result = resolveEntries({
      config: config({
        tiers: {
          standard: [
            baseEntry({
              backend: "opencode",
              model: "prov/model-a",
              // no vision
            }),
          ],
        },
        capabilities: {
          vision: baseEntry({
            backend: "opencode",
            model: "prov/vision-model",
            capabilities: ["vision"],
          }),
        },
      }),
      tier: "standard",
      caps: ["vision"],
      isCooling: () => false,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe("vision");
    expect(result.notes.some((n) => /capabilit/i.test(n))).toBe(true);
  });

  it("caps required but nothing satisfies -> empty entries with explanatory note", () => {
    const result = resolveEntries({
      config: config({
        tiers: {
          standard: [baseEntry({ backend: "opencode", model: "prov/model-a" })],
        },
        capabilities: {},
      }),
      tier: "standard",
      caps: ["vision"],
      isCooling: () => false,
    });
    expect(result.entries).toEqual([]);
    expect(result.notes.length).toBeGreaterThan(0);
    expect(result.notes.some((n) => /capabilit/i.test(n))).toBe(true);
  });

  it("cooling skip: cooling content key is dropped with a note", () => {
    const standardEntry = baseEntry({ backend: "opencode", model: "prov/model-a" });
    const heavyEntry = baseEntry({ backend: "opencode", model: "prov/model-b" });
    const result = resolveEntries({
      config: config({
        tiers: {
          standard: [standardEntry],
          heavy: [heavyEntry],
        },
        fallbacks: { standard: "heavy" },
      }),
      tier: "standard",
      caps: [],
      isCooling: (key) => key === cooldownKey(standardEntry),
    });
    expect(result.entries.map((e) => e.name)).toEqual(["heavy"]);
    expect(result.notes.some((n) => n.includes("standard") && /cooling/i.test(n))).toBe(true);
  });

  it("dedup: two slots resolving to same backend|provider|model collapse to one", () => {
    const same = baseEntry({
      backend: "opencode",
      provider: "prov",
      model: "prov/model-a",
    });
    const result = resolveEntries({
      config: config({
        tiers: {
          standard: [same],
          heavy: [{ ...same }],
        },
        fallbacks: { standard: "heavy" },
      }),
      tier: "standard",
      caps: [],
      isCooling: () => false,
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.name).toBe("standard");
  });

  it("fallback cycle guard: light↔standard both empty terminates without looping", () => {
    const result = resolveEntries({
      config: config({
        tiers: {
          light: [],
          standard: [],
        },
        fallbacks: {
          light: "standard",
          standard: "light",
        },
      }),
      tier: "light",
      caps: [],
      isCooling: () => false,
    });
    expect(result.entries).toEqual([]);
  });

  // --- multi-candidate tier behavior ---

  it("in-tier list fallback: light=[A,B] resolves to [A,B] in order", () => {
    const a = baseEntry({ backend: "opencode", model: "prov/model-a" });
    const b = baseEntry({ backend: "opencode", model: "prov/model-b" });
    const result = resolveEntries({
      config: config({
        tiers: { light: [a, b] },
      }),
      tier: "light",
      caps: [],
      isCooling: () => false,
    });
    expect(result.entries.map((e) => e.model)).toEqual(["prov/model-a", "prov/model-b"]);
    expect(result.entries.every((e) => e.name === "light")).toBe(true);
    expect(result.entries.map((e) => e.cooldownKey)).toEqual([
      cooldownKey(a),
      cooldownKey(b),
    ]);
  });

  it("two-tier walk: light=[A,B], standard=[C], fallbacks light→standard resolves [A,B,C]", () => {
    const a = baseEntry({ backend: "opencode", model: "prov/model-a" });
    const b = baseEntry({ backend: "opencode", model: "prov/model-b" });
    const c = baseEntry({ backend: "opencode", model: "prov/model-c" });
    const result = resolveEntries({
      config: config({
        tiers: {
          light: [a, b],
          standard: [c],
        },
        fallbacks: { light: "standard" },
      }),
      tier: "light",
      caps: [],
      isCooling: () => false,
    });
    expect(result.entries.map((e) => e.model)).toEqual([
      "prov/model-a",
      "prov/model-b",
      "prov/model-c",
    ]);
    expect(result.entries.map((e) => e.name)).toEqual(["light", "light", "standard"]);
  });

  it("dedup-before-cooling: same content in in-tier list and chained tier collapses to one", () => {
    const same = baseEntry({
      backend: "opencode",
      provider: "prov",
      model: "prov/shared",
    });
    const other = baseEntry({ backend: "opencode", model: "prov/other" });
    const result = resolveEntries({
      config: config({
        tiers: {
          light: [same, other],
          standard: [{ ...same }],
        },
        fallbacks: { light: "standard" },
      }),
      tier: "light",
      caps: [],
      isCooling: () => false,
    });
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((e) => e.model)).toEqual(["prov/shared", "prov/other"]);
    // First occurrence wins: primary slot name, not the chained copy.
    expect(result.entries[0]!.name).toBe("light");
  });

  it("dedup-before-cooling: cooling the shared content key drops the single candidate (no bypass via duplicate)", () => {
    const same = baseEntry({
      backend: "opencode",
      provider: "prov",
      model: "prov/shared",
    });
    const result = resolveEntries({
      config: config({
        tiers: {
          light: [same],
          standard: [{ ...same }],
        },
        fallbacks: { light: "standard" },
      }),
      tier: "light",
      caps: [],
      // If dedup ran AFTER cooling, cooling only one path would leave the
      // other; cooling the content key after dedup must drop the sole copy.
      isCooling: (key) => key === cooldownKey(same),
    });
    expect(result.entries).toEqual([]);
    expect(result.notes.some((n) => /cooling/i.test(n))).toBe(true);
  });

  it("content-keyed cooling isolation: cooling A's key drops A but keeps B", () => {
    const a = baseEntry({ backend: "opencode", model: "prov/model-a" });
    const b = baseEntry({ backend: "opencode", model: "prov/model-b" });
    const result = resolveEntries({
      config: config({
        tiers: { light: [a, b] },
      }),
      tier: "light",
      caps: [],
      isCooling: (key) => key === cooldownKey(a),
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.model).toBe("prov/model-b");
    expect(result.entries[0]!.cooldownKey).toBe(cooldownKey(b));
    expect(result.notes.some((n) => n.includes("light") && /cooling/i.test(n))).toBe(true);
  });

  it("content-keyed cooling isolation: cooling a different model key leaves both", () => {
    const a = baseEntry({ backend: "opencode", model: "prov/model-a" });
    const b = baseEntry({ backend: "opencode", model: "prov/model-b" });
    const result = resolveEntries({
      config: config({
        tiers: { light: [a, b] },
      }),
      tier: "light",
      caps: [],
      isCooling: (key) => key === "opencode|prov|prov/unrelated",
    });
    expect(result.entries.map((e) => e.model)).toEqual(["prov/model-a", "prov/model-b"]);
    expect(result.notes.some((n) => /cooling/i.test(n))).toBe(false);
  });

  it(`MAX_RESOLVED cap: resolved list >${MAX_RESOLVED} is truncated to ${MAX_RESOLVED} (head kept)`, () => {
    // Build more than MAX_RESOLVED distinct candidates across in-tier + chain.
    const lightEntries = Array.from({ length: 4 }, (_, i) =>
      baseEntry({ backend: "opencode", model: `prov/light-${i}` }),
    );
    const standardEntries = Array.from({ length: 4 }, (_, i) =>
      baseEntry({ backend: "opencode", model: `prov/std-${i}` }),
    );
    const result = resolveEntries({
      config: config({
        tiers: {
          light: lightEntries,
          standard: standardEntries,
        },
        fallbacks: { light: "standard" },
      }),
      tier: "light",
      caps: [],
      isCooling: () => false,
    });
    expect(lightEntries.length + standardEntries.length).toBeGreaterThan(MAX_RESOLVED);
    expect(result.entries).toHaveLength(MAX_RESOLVED);
    // Head kept: first MAX_RESOLVED in walk order (all of light, then head of standard).
    expect(result.entries.map((e) => e.model)).toEqual([
      "prov/light-0",
      "prov/light-1",
      "prov/light-2",
      "prov/light-3",
      "prov/std-0",
      "prov/std-1",
    ]);
    expect(result.notes).toContain(`resolved candidates capped at ${MAX_RESOLVED}`);
  });
});

describe("cooldownKey", () => {
  it("non-advisory: backend|provider|model", () => {
    expect(
      cooldownKey({
        backend: "opencode",
        provider: "prov",
        model: "prov/model-a",
      }),
    ).toBe("opencode|prov|prov/model-a");
  });

  it("advisory: advisory:backend", () => {
    expect(
      cooldownKey({
        backend: "codex",
        advisory: true,
      }),
    ).toBe("advisory:codex");
  });
});
