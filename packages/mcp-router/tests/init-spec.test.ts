import { describe, it, expect } from "vitest";

import { specToJson, validateSpec, type InitSpec } from "../src/init/spec.js";
import { validateConfigObject } from "../src/config.js";

const VALID: InitSpec = {
  tiers: { light: null, standard: { backend: "opencode", model: "prov/model-a" }, heavy: null },
  capabilities: {},
  fallbacks: {},
  allowCrossProviderFallback: false,
};

describe("validateSpec", () => {
  it("accepts a good spec", () => {
    const result = validateSpec(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.tiers.standard[0]).toMatchObject({ backend: "opencode", model: "prov/model-a", provider: "prov" });
    }
  });

  it("rejects an advisory entry that is not last in its tier", () => {
    const spec: InitSpec = {
      ...VALID,
      tiers: {
        light: null,
        heavy: null,
        standard: [
          { backend: "codex", advisory: true },
          { backend: "opencode", model: "prov/model-a" },
        ],
      },
    };
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/advisory entry must be last/);
  });

  it("rejects a non-advisory entry with no model", () => {
    const spec: InitSpec = {
      ...VALID,
      tiers: { light: null, standard: { backend: "opencode" }, heavy: null },
    };
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/model/i);
  });

  it("rejects an unknown top-level key (strict schema)", () => {
    const spec = { ...VALID, unknownField: true } as unknown as InitSpec;
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it("rejects an unknown entry key (strict entry schema)", () => {
    const spec: InitSpec = {
      ...VALID,
      tiers: { light: null, standard: { backend: "opencode", model: "prov/model-a", bogus: true } as never, heavy: null },
    };
    const result = validateSpec(spec);
    expect(result.ok).toBe(false);
  });
});

describe("specToJson", () => {
  it("round-trips through validateConfigObject", () => {
    const json = specToJson(VALID);
    expect(json.endsWith("\n")).toBe(true);
    const config = validateConfigObject(JSON.parse(json));
    expect(config.tiers.standard[0]).toMatchObject({ backend: "opencode", model: "prov/model-a", provider: "prov" });
  });

  it("produces pretty (2-space indented) JSON", () => {
    const json = specToJson(VALID);
    expect(json).toContain('\n  "tiers"');
  });
});
