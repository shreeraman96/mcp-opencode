import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig, MAX_TIER_ENTRIES } from "../src/config.js";

function writeConfig(dir: string, body: unknown, mode = 0o600): string {
  const configPath = path.join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(body), { mode });
  // writeFileSync mode is masked by umask; force exact bits for permission tests.
  chmodSync(configPath, mode);
  return configPath;
}

function minimalTiers(standard: unknown) {
  return {
    tiers: {
      light: null,
      standard,
      heavy: null,
    },
    capabilities: {},
    fallbacks: {},
  };
}

describe("loadConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mcp-router-cfg-"));
    // Parent must not be group/world-writable for the hardened reader.
    chmodSync(dir, 0o700);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("missing file -> source auto-detect, all tiers empty arrays", async () => {
    const configPath = path.join(dir, "does-not-exist.json");
    const loaded = await loadConfig({ configPath });
    expect(loaded.source).toBe("auto-detect");
    expect(loaded.config.tiers).toEqual({ light: [], standard: [], heavy: [] });
    expect(loaded.path).toBeUndefined();
  });

  it("valid 0600 file loads and derives provider from model prefix", async () => {
    const configPath = writeConfig(
      dir,
      minimalTiers({ backend: "opencode", model: "prov/model-a" }),
      0o600,
    );
    const loaded = await loadConfig({ configPath });
    expect(loaded.source).toBe("file");
    expect(loaded.path).toBe(configPath);
    expect(loaded.config.tiers.standard).toHaveLength(1);
    expect(loaded.config.tiers.standard[0]).toMatchObject({
      backend: "opencode",
      model: "prov/model-a",
      provider: "prov",
    });
  });

  it("single-object tier normalizes to a one-element array", async () => {
    const configPath = writeConfig(
      dir,
      minimalTiers({ backend: "opencode", model: "prov/model-a" }),
      0o600,
    );
    const loaded = await loadConfig({ configPath });
    expect(Array.isArray(loaded.config.tiers.standard)).toBe(true);
    expect(loaded.config.tiers.standard).toHaveLength(1);
  });

  it("array-form tier list loads in order", async () => {
    const configPath = writeConfig(
      dir,
      minimalTiers([
        { backend: "opencode", model: "prov/model-a" },
        { backend: "opencode", model: "prov/model-b" },
      ]),
      0o600,
    );
    const loaded = await loadConfig({ configPath });
    expect(loaded.config.tiers.standard).toHaveLength(2);
    expect(loaded.config.tiers.standard.map((e) => e.model)).toEqual([
      "prov/model-a",
      "prov/model-b",
    ]);
  });

  it("declared provider mismatch rejects", async () => {
    const configPath = writeConfig(
      dir,
      minimalTiers({
        backend: "opencode",
        provider: "wrong",
        model: "prov/model-a",
      }),
      0o600,
    );
    await expect(loadConfig({ configPath })).rejects.toThrow(/provider/i);
  });

  it("permissions too broad (0644) rejects", async () => {
    if (typeof process.getuid !== "function") {
      // Windows / environments without posix uid checks.
      return;
    }
    const configPath = writeConfig(
      dir,
      minimalTiers({ backend: "opencode", model: "prov/model-a" }),
      0o644,
    );
    await expect(loadConfig({ configPath })).rejects.toThrow(/permissions are too broad/i);
  });

  it("capability slot lacking the declared capability rejects", async () => {
    const configPath = writeConfig(
      dir,
      {
        tiers: { light: null, standard: null, heavy: null },
        capabilities: {
          vision: { backend: "opencode", model: "prov/m" },
        },
        fallbacks: {},
      },
      0o600,
    );
    await expect(loadConfig({ configPath })).rejects.toThrow(/vision/i);
  });

  it("non-advisory entry without model rejects", async () => {
    const configPath = writeConfig(
      dir,
      minimalTiers({ backend: "opencode" }),
      0o600,
    );
    await expect(loadConfig({ configPath })).rejects.toThrow(/model/i);
  });

  it("advisory entry without model is OK", async () => {
    const configPath = writeConfig(
      dir,
      {
        tiers: {
          light: null,
          standard: null,
          heavy: { backend: "codex", advisory: true },
        },
        capabilities: {},
        fallbacks: {},
      },
      0o600,
    );
    const loaded = await loadConfig({ configPath });
    expect(loaded.source).toBe("file");
    expect(loaded.config.tiers.heavy).toHaveLength(1);
    expect(loaded.config.tiers.heavy[0]).toMatchObject({
      backend: "codex",
      advisory: true,
      provider: "openai",
    });
    expect(loaded.config.tiers.heavy[0]?.model).toBeUndefined();
  });

  it("advisory entry not last in tier list rejects", async () => {
    const configPath = writeConfig(
      dir,
      minimalTiers([
        { backend: "codex", advisory: true },
        { backend: "opencode", model: "prov/model-a" },
      ]),
      0o600,
    );
    await expect(loadConfig({ configPath })).rejects.toThrow(
      /advisory entry must be last in tier 'standard'/,
    );
  });

  it("advisory entry last in tier list is accepted", async () => {
    const configPath = writeConfig(
      dir,
      minimalTiers([
        { backend: "opencode", model: "prov/model-a" },
        { backend: "codex", advisory: true },
      ]),
      0o600,
    );
    const loaded = await loadConfig({ configPath });
    expect(loaded.config.tiers.standard).toHaveLength(2);
    expect(loaded.config.tiers.standard[1]).toMatchObject({
      backend: "codex",
      advisory: true,
    });
  });

  it(`tier list longer than MAX_TIER_ENTRIES (${MAX_TIER_ENTRIES}) rejects`, async () => {
    const entries = Array.from({ length: MAX_TIER_ENTRIES + 1 }, (_, i) => ({
      backend: "opencode" as const,
      model: `prov/model-${i}`,
    }));
    const configPath = writeConfig(dir, minimalTiers(entries), 0o600);
    await expect(loadConfig({ configPath })).rejects.toThrow(
      new RegExp(
        `tier 'standard' accepts at most ${MAX_TIER_ENTRIES} entries; got ${MAX_TIER_ENTRIES + 1}`,
      ),
    );
  });
});
