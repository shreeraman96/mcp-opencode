import { describe, it, expect } from "vitest";

import { computeRisks } from "../src/init/risk.js";
import type { Entry, RouterConfig } from "../src/types.js";

const entry = (overrides: Partial<Entry> & Pick<Entry, "backend">): Entry => ({
  provider: overrides.backend === "grok" ? "xai" : overrides.backend === "codex" ? "openai" : "prov",
  ...overrides,
});

function config(partial: {
  tiers?: Partial<RouterConfig["tiers"]>;
  capabilities?: RouterConfig["capabilities"];
  fallbacks?: RouterConfig["fallbacks"];
  allowCrossProviderFallback?: boolean;
}): RouterConfig {
  return {
    tiers: { light: [], standard: [], heavy: [], ...partial.tiers },
    capabilities: partial.capabilities ?? {},
    fallbacks: partial.fallbacks ?? {},
    allowCrossProviderFallback: partial.allowCrossProviderFallback ?? false,
  };
}

describe("computeRisks", () => {
  it("no risks for an unchanged config", () => {
    const cfg = config({
      tiers: { standard: [entry({ backend: "opencode", model: "prov/model-a", provider: "prov" })] },
    });
    expect(computeRisks(cfg, cfg)).toEqual([]);
  });

  it("no risks when current is null and next has no configured tiers", () => {
    const cfg = config({});
    expect(computeRisks(null, cfg)).toEqual([]);
  });

  it("cross-provider-flag fires false -> true", () => {
    const current = config({ allowCrossProviderFallback: false });
    const next = config({ allowCrossProviderFallback: true });
    const risks = computeRisks(current, next);
    expect(risks.some((r) => r.code === "cross-provider-flag")).toBe(true);
  });

  it("cross-provider-flag does not fire true -> true", () => {
    const current = config({ allowCrossProviderFallback: true });
    const next = config({ allowCrossProviderFallback: true });
    expect(computeRisks(current, next).some((r) => r.code === "cross-provider-flag")).toBe(false);
  });

  it("primary-provider-change fires when the primary's provider changes", () => {
    const current = config({
      tiers: { standard: [entry({ backend: "opencode", model: "provA/model-a", provider: "provA" })] },
    });
    const next = config({
      tiers: { standard: [entry({ backend: "opencode", model: "provB/model-a", provider: "provB" })] },
    });
    const risks = computeRisks(current, next);
    const risk = risks.find((r) => r.code === "primary-provider-change" && r.tier === "standard");
    expect(risk).toBeDefined();
    expect(risk!.message).toContain("provA");
    expect(risk!.message).toContain("provB");
  });

  it("primary-provider-change fires when a previously-unconfigured tier now routes to a remote provider", () => {
    const current = config({});
    const next = config({
      tiers: { heavy: [entry({ backend: "opencode", model: "prov/model-a", provider: "prov" })] },
    });
    const risks = computeRisks(current, next);
    expect(risks.some((r) => r.code === "primary-provider-change" && r.tier === "heavy")).toBe(true);
  });

  it("primary-provider-change does NOT fire when only the model changes but provider stays the same", () => {
    const current = config({
      tiers: { standard: [entry({ backend: "opencode", model: "prov/model-a", provider: "prov" })] },
    });
    const next = config({
      tiers: { standard: [entry({ backend: "opencode", model: "prov/model-b", provider: "prov" })] },
    });
    expect(computeRisks(current, next).some((r) => r.code === "primary-provider-change")).toBe(false);
  });

  it("primary-provider-change does NOT fire for an advisory primary (never spawned, no egress)", () => {
    const current = config({});
    const next = config({
      tiers: { heavy: [entry({ backend: "codex", advisory: true, provider: "codex" })] },
    });
    expect(computeRisks(current, next).some((r) => r.code === "primary-provider-change")).toBe(false);
  });

  it("aggregator-primary fires for an openrouter primary", () => {
    const current = config({});
    const next = config({
      tiers: { standard: [entry({ backend: "opencode", model: "openrouter/some-model", provider: "openrouter" })] },
    });
    const risks = computeRisks(current, next);
    expect(risks.some((r) => r.code === "aggregator-primary" && r.tier === "standard")).toBe(true);
  });

  it("aggregator-primary does NOT fire for a plain non-aggregator provider", () => {
    const current = config({});
    const next = config({
      tiers: { standard: [entry({ backend: "opencode", model: "prov/model-a", provider: "prov" })] },
    });
    expect(computeRisks(current, next).some((r) => r.code === "aggregator-primary")).toBe(false);
  });

  it("cross-provider-fallback fires for a same-tier fallback candidate on a different provider", () => {
    const cfg = config({
      tiers: {
        standard: [
          entry({ backend: "opencode", model: "provA/model-a", provider: "provA" }),
          entry({ backend: "opencode", model: "provB/model-b", provider: "provB" }),
        ],
      },
    });
    const risks = computeRisks(cfg, cfg);
    const risk = risks.find((r) => r.code === "cross-provider-fallback" && r.tier === "standard");
    expect(risk).toBeDefined();
    expect(risk!.message).toContain("provA");
    expect(risk!.message).toContain("provB");
  });

  it("cross-provider-fallback does NOT fire when every candidate in the chain shares a provider", () => {
    const cfg = config({
      tiers: {
        standard: [
          entry({ backend: "opencode", model: "prov/model-a", provider: "prov" }),
          entry({ backend: "opencode", model: "prov/model-b", provider: "prov" }),
        ],
      },
    });
    expect(computeRisks(cfg, cfg).some((r) => r.code === "cross-provider-fallback")).toBe(false);
  });

  it("cross-provider-fallback ignores a trailing advisory candidate (never spawned)", () => {
    const cfg = config({
      tiers: {
        standard: [
          entry({ backend: "opencode", model: "prov/model-a", provider: "prov" }),
          entry({ backend: "codex", advisory: true, provider: "codex" }),
        ],
      },
    });
    expect(computeRisks(cfg, cfg).some((r) => r.code === "cross-provider-fallback")).toBe(false);
  });

  it("flags a capability-slot provider change (capability slot is a spawn destination too)", () => {
    const current = config({
      capabilities: { vision: entry({ backend: "opencode", model: "provA/vis", provider: "provA", capabilities: ["vision"] }) },
    });
    const next = config({
      capabilities: { vision: entry({ backend: "opencode", model: "provB/vis", provider: "provB", capabilities: ["vision"] }) },
    });
    const risk = computeRisks(current, next).find((r) => r.code === "primary-provider-change" && r.message.includes("capability 'vision'"));
    expect(risk).toBeDefined();
    expect(risk!.message).toContain("provB");
  });

  it("flags an aggregator capability slot (opaque downstream via the vision route)", () => {
    const current = config({});
    const next = config({
      capabilities: { vision: entry({ backend: "opencode", model: "openrouter/vis", provider: "openrouter", capabilities: ["vision"] }) },
    });
    const risks = computeRisks(current, next);
    expect(risks.some((r) => r.code === "aggregator-primary" && r.message.includes("capability 'vision'"))).toBe(true);
  });

  it("cross-tier-fallback fires when a fallback edge crosses provider AND the opt-in is on", () => {
    const next = config({
      tiers: {
        heavy: [entry({ backend: "opencode", model: "provA/m", provider: "provA" })],
        standard: [entry({ backend: "opencode", model: "provB/m", provider: "provB" })],
      },
      fallbacks: { heavy: "standard" },
      allowCrossProviderFallback: true,
    });
    const risk = computeRisks(next, next).find((r) => r.code === "cross-tier-fallback" && r.tier === "heavy");
    expect(risk).toBeDefined();
    expect(risk!.message).toContain("provB");
  });

  it("cross-tier-fallback does NOT fire when the cross-provider opt-in is off", () => {
    const next = config({
      tiers: {
        heavy: [entry({ backend: "opencode", model: "provA/m", provider: "provA" })],
        standard: [entry({ backend: "opencode", model: "provB/m", provider: "provB" })],
      },
      fallbacks: { heavy: "standard" },
      allowCrossProviderFallback: false,
    });
    expect(computeRisks(next, next).some((r) => r.code === "cross-tier-fallback")).toBe(false);
  });

  it("cross-tier-fallback does NOT fire when source and target tiers share a provider", () => {
    const next = config({
      tiers: {
        heavy: [entry({ backend: "opencode", model: "prov/m1", provider: "prov" })],
        standard: [entry({ backend: "opencode", model: "prov/m2", provider: "prov" })],
      },
      fallbacks: { heavy: "standard" },
      allowCrossProviderFallback: true,
    });
    expect(computeRisks(next, next).some((r) => r.code === "cross-tier-fallback")).toBe(false);
  });
});
