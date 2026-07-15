import { closeSync, constants, fstatSync, openSync, readFileSync, statSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";

import { deriveProvider } from "./provider.js";
import { BACKEND_NAMES, CAPABILITIES, TIER_NAMES } from "./types.js";
import type { BackendName, Capability, DetectResult, Entry, RouterConfig, TierName } from "./types.js";

export const ROOTS_ENV_VAR = "MCP_ROUTER_ROOTS";

/** Per-tier candidate cap. Bounds config complexity and the in-tier fallback
 * chain length so a single tier cannot fan out unboundedly. */
export const MAX_TIER_ENTRIES = 8;

export interface LoadedConfig {
  config: RouterConfig;
  source: "file" | "auto-detect";
  path?: string;
}

const entrySchema = z
  .object({
    backend: z.enum(BACKEND_NAMES as [BackendName, ...BackendName[]]),
    provider: z.string().optional(),
    model: z.string().optional(),
    advisory: z.boolean().optional(),
    capabilities: z.array(z.enum(CAPABILITIES as [Capability, ...Capability[]])).optional(),
  })
  .strict();

// A tier slot accepts a SINGLE entry OR an array OR null, then normalizes to an
// ordered Entry[] (empty array = unconfigured). This keeps back-compat with
// existing single-object configs while enabling multi-candidate tiers.
const tierListSchema = z
  .union([entrySchema, z.array(entrySchema)])
  .nullable()
  .transform((v) => (v == null ? [] : Array.isArray(v) ? v : [v]));

const configSchema = z
  .object({
    tiers: z
      .object({ light: tierListSchema, standard: tierListSchema, heavy: tierListSchema })
      .strict(),
    capabilities: z.object({ vision: entrySchema.optional() }).strict(),
    fallbacks: z
      .object({
        light: z.enum(TIER_NAMES as [TierName, ...TierName[]]).optional(),
        standard: z.enum(TIER_NAMES as [TierName, ...TierName[]]).optional(),
        heavy: z.enum(TIER_NAMES as [TierName, ...TierName[]]).optional(),
      })
      .strict(),
    allowCrossProviderFallback: z.boolean().default(false),
  })
  .strict();

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.MCP_ROUTER_CONFIG;
  if (configured) return configured;
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "mcp-router", "config.json");
}

// Shared by the config read path AND the init/write pending-config read path
// (src/init/write.ts) so a second, drifted copy of these perms/owner/parent
// checks can never creep in for the wizard's pending file.
export function readHardenedFile(filePath: string): string | undefined {
  let fd: number;
  try {
    // Open and inspect the same descriptor before reading: this ordering closes the stat-then-open TOCTOU gap.
    fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot securely open config ${filePath}: ${(error as Error).message}`);
  }
  try {
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile()) throw new Error(`config path is not a regular file: ${filePath}`);
    if (typeof process.getuid === "function" && fileStat.uid !== process.getuid()) {
      throw new Error(`config is not owned by the current user: ${filePath}`);
    }
    if ((fileStat.mode & 0o077) !== 0) {
      throw new Error(`config permissions are too broad: ${filePath}; use chmod 600 ${filePath}`);
    }
    let parent: Stats;
    try {
      parent = statSync(path.dirname(filePath));
    } catch (error) {
      throw new Error(`cannot inspect config parent for ${filePath}: ${(error as Error).message}`);
    }
    if ((parent.mode & 0o022) !== 0) {
      throw new Error(`config parent directory is group- or world-writable: ${filePath}`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function authorize(config: RouterConfig): RouterConfig {
  // Per-tier size cap: reject an over-long list up front with the tier named.
  for (const tier of TIER_NAMES) {
    const list = config.tiers[tier];
    if (list.length > MAX_TIER_ENTRIES) {
      throw new Error(
        `tier '${tier}' accepts at most ${MAX_TIER_ENTRIES} entries; got ${list.length}`,
      );
    }
  }

  // Validate + derive provider for EVERY entry in EVERY tier list and capability
  // slot. Provider is derived from the model prefix (opencode) or fixed (grok/
  // codex); a declared mislabel must not defeat the cross-provider gate.
  const entries: Entry[] = [
    ...TIER_NAMES.flatMap((tier) => config.tiers[tier]),
    ...CAPABILITIES.flatMap((capability) =>
      config.capabilities[capability] ? [config.capabilities[capability]!] : [],
    ),
  ];
  for (const entry of entries) {
    // deriveProvider needs a model only for opencode (provider = model prefix);
    // grok/codex derive a fixed provider without one. An advisory entry may omit
    // the model, so deriving for an advisory opencode entry would wrongly reject
    // a legitimate config. Derive whenever we can; otherwise fall back to the
    // backend name so advisory entries still carry a provider for reporting.
    if (entry.model !== undefined || entry.backend !== "opencode") {
      const derived = deriveProvider(entry.backend, entry.model);
      if (entry.provider !== undefined && entry.provider !== derived) {
        throw new Error(`declared provider disagrees with model prefix for ${entry.backend}`);
      }
      entry.provider = derived;
    } else if (entry.advisory) {
      entry.provider = entry.backend;
    }
    if (!entry.advisory && !entry.model) throw new Error(`non-advisory ${entry.backend} entry must declare a model`);
  }

  // An advisory entry short-circuits the in-tier chain (the router returns a
  // hint and never spawns it), so any candidate after an advisory is
  // unreachable. Force advisory to be the LAST element of its tier list.
  for (const tier of TIER_NAMES) {
    const list = config.tiers[tier];
    const advisoryIndex = list.findIndex((e) => e.advisory === true);
    if (advisoryIndex !== -1 && advisoryIndex !== list.length - 1) {
      throw new Error(`advisory entry must be last in tier '${tier}'`);
    }
  }

  for (const capability of CAPABILITIES) {
    const entry = config.capabilities[capability];
    if (entry && !(entry.capabilities ?? []).includes(capability)) {
      throw new Error(`a '${capability}' slot whose model does not provide '${capability}'`);
    }
  }
  return config;
}

export { configSchema };

/**
 * Validate an already-parsed JSON value through the EXACT schema + authorize
 * path the server uses. This is the single validation entry point shared by
 * loadConfig (reading the live config) and the init wizard (previewing +
 * accepting a candidate config) so the two can never drift.
 */
export function validateConfigObject(raw: unknown): RouterConfig {
  return authorize(configSchema.parse(raw) as RouterConfig);
}

export async function loadConfig(opts: {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  detectors?: Partial<Record<BackendName, () => Promise<DetectResult>>>;
} = {}): Promise<LoadedConfig> {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath ?? env.MCP_ROUTER_CONFIG ?? defaultConfigPath(env);
  const content = readHardenedFile(configPath);
  if (content === undefined) {
    return {
      source: "auto-detect",
      config: { tiers: { light: [], standard: [], heavy: [] }, capabilities: {}, fallbacks: {}, allowCrossProviderFallback: false },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new Error(`invalid JSON in config ${configPath}: ${(error as Error).message}`);
  }
  return { source: "file", path: configPath, config: validateConfigObject(raw) };
}
