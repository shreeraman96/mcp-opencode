import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  commitPending,
  diffConfigs,
  ensureConfigDir,
  pendingPathFor,
  readPending,
  writeConfigFile,
  writePending,
} from "../src/init/write.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-router-init-write-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  return dir;
}

const VALID_JSON = JSON.stringify({
  tiers: { light: null, standard: { backend: "opencode", model: "prov/model-a" }, heavy: null },
  capabilities: {},
  fallbacks: {},
  allowCrossProviderFallback: false,
});

const INVALID_JSON = JSON.stringify({
  tiers: { light: null, standard: { backend: "opencode", model: "nomodel" }, heavy: null },
  capabilities: {},
  fallbacks: {},
  allowCrossProviderFallback: false,
});

describe("writeConfigFile", () => {
  it("writes a 0600 file atomically with the given content", () => {
    const dir = tempDir();
    const target = path.join(dir, "config.json");
    writeConfigFile(target, VALID_JSON);
    expect(readFileSync(target, "utf8")).toBe(VALID_JSON);
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
    // No stray temp file left behind.
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("overwrites an existing file via rename, never truncating in place", () => {
    const dir = tempDir();
    const target = path.join(dir, "config.json");
    writeConfigFile(target, "first");
    writeConfigFile(target, "second");
    expect(readFileSync(target, "utf8")).toBe("second");
  });
});

describe("writePending / readPending", () => {
  it("round-trips through a pending file", () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    const pendingPath = writePending(configPath, VALID_JSON);
    expect(pendingPath).toBe(pendingPathFor(configPath));
    expect(existsSync(pendingPath)).toBe(true);
    expect(readPending(configPath)).toBe(VALID_JSON);
  });

  it("readPending rejects a 0644 pending file", () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    const pendingPath = pendingPathFor(configPath);
    writeFileSync(pendingPath, VALID_JSON, { mode: 0o644 });
    chmodSync(pendingPath, 0o644);
    expect(() => readPending(configPath)).toThrow(/permissions are too broad/i);
  });

  it("readPending throws when there is no pending file", () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    expect(() => readPending(configPath)).toThrow(/no pending config/i);
  });
});

describe("ensureConfigDir", () => {
  it("creates a missing parent directory at mode 0700", () => {
    const dir = tempDir();
    const nested = path.join(dir, "nested", "config.json");
    ensureConfigDir(nested);
    const mode = statSync(path.dirname(nested)).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("refuses a group/world-writable existing parent", () => {
    const dir = tempDir();
    chmodSync(dir, 0o777);
    const configPath = path.join(dir, "config.json");
    expect(() => ensureConfigDir(configPath)).toThrow(/group- or world-writable/i);
  });
});

describe("commitPending", () => {
  it("validates and commits a valid pending config, then deletes the pending file", () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    writePending(configPath, VALID_JSON);
    const { config } = commitPending(configPath);
    expect(config.tiers.standard[0]).toMatchObject({ backend: "opencode", model: "prov/model-a" });
    expect(readFileSync(configPath, "utf8")).toBe(VALID_JSON);
    expect(existsSync(pendingPathFor(configPath))).toBe(false);
  });

  it("rolls back on an invalid pending config: live config untouched, pending left in place", () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    writeConfigFile(configPath, VALID_JSON); // pre-existing live config
    writePending(configPath, INVALID_JSON);

    expect(() => commitPending(configPath)).toThrow();

    expect(readFileSync(configPath, "utf8")).toBe(VALID_JSON); // untouched
    expect(existsSync(pendingPathFor(configPath))).toBe(true); // left in place
    expect(readFileSync(pendingPathFor(configPath), "utf8")).toBe(INVALID_JSON);
  });
});

describe("diffConfigs", () => {
  it("reports 'no changes.' for an identical config", () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    writePending(configPath, VALID_JSON);
    const { config } = commitPending(configPath);
    expect(diffConfigs(config, config)).toBe("no changes.");
  });

  it("reports a tier transition from unconfigured to configured", () => {
    const dir = tempDir();
    const configPath = path.join(dir, "config.json");
    writePending(configPath, VALID_JSON);
    const { config } = commitPending(configPath);
    const diff = diffConfigs(null, config);
    expect(diff).toContain("standard: (unconfigured) -> opencode · prov/model-a");
  });
});
