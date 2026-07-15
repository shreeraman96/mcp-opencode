// The `--init` interview. All decision logic lives here, injected with IO and
// side-effecting deps, so it is testable without a real terminal or spawning
// real CLIs; index.ts's `--init` branch only owns the TTY gate + wiring a real
// readline interface to `runInitCli`. Nothing here trusts the config it
// builds — the single write, at the very end, always goes through
// validateSpec first.

import { createInterface } from "node:readline/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import { loadConfig, defaultConfigPath } from "../config.js";
import { runCheck } from "../check.js";
import { deriveProvider } from "../provider.js";
import { SPAWNABLE, type SpawnableName } from "../backends/registry.js";
import { discoverModels } from "./discovery.js";
import { computeRisks } from "./risk.js";
import { diffConfigs, ensureConfigDir, writeConfigFile } from "./write.js";
import { specToJson, validateSpec, type InitSpec } from "./spec.js";
import { BACKEND_NAMES, TIER_NAMES } from "../types.js";
import type { BackendName, DetectResult, Entry, RouterConfig, TierName } from "../types.js";

const execFileP = promisify(execFileCallback);

export interface WizardIO {
  print(line: string): void;
  error(line: string): void;
  ask(question: string): Promise<string>;
}

export interface WizardDeps {
  detect: (name: SpawnableName) => Promise<DetectResult>;
  discover: (backend: SpawnableName) => Promise<{ models: string[] } | { error: string }>;
  /** npm-global install ONLY — never a shell, never curl|sh. Returns whether it
   * succeeded so the wizard can re-probe `detect` afterward. */
  npmInstall: (pkg: string) => Promise<{ ok: boolean; message: string }>;
  loadCurrent: () => Promise<RouterConfig | null>;
  configPath: string;
  env?: NodeJS.ProcessEnv;
}

/** Best-known npm-global install per backend. Confidence varies (see the
 * per-entry comment); a backend without a confirmed package name gets
 * guidance only, never an auto-install offer, per the hardening requirement
 * that we only ever run a KNOWN npm-global install. */
const INSTALL_HINTS: Partial<Record<SpawnableName, { npmPackage?: string; hint: string }>> = {
  // Medium-high confidence: sst/opencode publishes its CLI to npm as opencode-ai.
  opencode: { npmPackage: "opencode-ai", hint: "npm install -g opencode-ai  (https://opencode.ai)" },
  // Medium confidence: OpenAI's Codex CLI publishes as @openai/codex.
  codex: { npmPackage: "@openai/codex", hint: "npm install -g @openai/codex  (https://github.com/openai/codex)" },
  // No confirmed npm-global package for the Grok Build CLI — guidance only.
  grok: { hint: "see the Grok Build CLI install docs; mcp-orchestrate does not know a safe auto-install command for it" },
};

async function defaultNpmInstall(pkg: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { stdout } = await execFileP("npm", ["i", "-g", pkg], { timeout: 120_000, maxBuffer: 1024 * 1024 });
    return { ok: true, message: stdout.trim() };
  } catch (error) {
    return { ok: false, message: (error as Error).message ?? String(error) };
  }
}

export function defaultWizardDeps(configPath?: string, env: NodeJS.ProcessEnv = process.env): WizardDeps {
  const resolvedConfigPath = configPath ?? env.MCP_ROUTER_CONFIG ?? defaultConfigPath(env);
  return {
    detect: (name) => SPAWNABLE[name].detect(),
    // Do NOT forward the ambient env: discovery treats the child's stdout as
    // hostile, so it must not hand that child ambient secrets (API keys/tokens)
    // either. discoverModels falls back to a minimal {PATH, HOME}, which is
    // enough for config-file-based auth; env-var-only auth degrades to the
    // free-text model path rather than leaking secrets.
    discover: (backend) => discoverModels(backend),
    npmInstall: defaultNpmInstall,
    loadCurrent: async () => {
      const loaded = await loadConfig({ configPath: resolvedConfigPath, env });
      return loaded.source === "file" ? loaded.config : null;
    },
    configPath: resolvedConfigPath,
    env,
  };
}

async function askYesNo(io: WizardIO, prompt: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await io.ask(`${prompt} ${suffix} `)).trim().toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

async function detectAndReport(io: WizardIO, deps: WizardDeps): Promise<Map<SpawnableName, DetectResult>> {
  const names = Object.keys(SPAWNABLE) as SpawnableName[];
  const results = new Map<SpawnableName, DetectResult>();
  io.print("detecting installed backends...");
  for (const name of names) {
    const det = await deps.detect(name);
    results.set(name, det);
    io.print(`  ${name}: ${det.installed ? `installed${det.version ? ` (${det.version})` : ""}` : "not found"}`);
  }
  return results;
}

async function offerInstall(io: WizardIO, deps: WizardDeps, backend: SpawnableName): Promise<void> {
  const hint = INSTALL_HINTS[backend];
  if (!hint) {
    io.print(`  no install guidance available for '${backend}'.`);
    return;
  }
  io.print(`  ${backend} is not installed. ${hint.hint}`);
  if (!hint.npmPackage) return;
  const run = await askYesNo(io, `  run 'npm i -g ${hint.npmPackage}' now?`, false);
  if (!run) return;
  io.print(`  running npm i -g ${hint.npmPackage}...`);
  const result = await deps.npmInstall(hint.npmPackage);
  io.print(result.ok ? "  install succeeded." : `  install failed: ${result.message}`);
}

/** Validate a free-text model id against the same rule the server enforces
 * (deriveProvider), so a typo surfaces immediately instead of at write time. */
function validateModelShape(backend: BackendName, model: string): string | undefined {
  try {
    deriveProvider(backend, model);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

async function pickModel(io: WizardIO, deps: WizardDeps, backend: BackendName): Promise<string | undefined> {
  // codex has no known discovery command (see discovery.ts); a non-advisory
  // codex entry still needs a model, so it falls straight to free text below.
  let choices: string[] = [];
  if (backend === "opencode" || backend === "grok") {
    const discovered = await deps.discover(backend as SpawnableName);
    if ("models" in discovered) {
      choices = discovered.models;
    } else {
      io.print(`  (model discovery unavailable: ${discovered.error} — enter a model id manually)`);
    }
  }
  if (choices.length > 0) {
    io.print("  discovered models (untrusted list — pick one or type your own):");
    choices.slice(0, 20).forEach((m, i) => io.print(`    ${i + 1}. ${m}`));
    if (choices.length > 20) io.print(`    ... and ${choices.length - 20} more`);
  }
  for (;;) {
    const answer = (await io.ask("  model (number from the list, a model id, or blank to skip this tier): ")).trim();
    if (answer === "") return undefined;
    const index = Number.parseInt(answer, 10);
    const model = Number.isInteger(index) && index >= 1 && index <= choices.length ? choices[index - 1] : answer;
    const error = validateModelShape(backend, model);
    if (error === undefined) return model;
    io.print(`  invalid model: ${error}`);
  }
}

async function pickBackend(io: WizardIO): Promise<BackendName | undefined> {
  const answer = (await io.ask(`  backend (${BACKEND_NAMES.join("/")}, blank to skip): `)).trim().toLowerCase();
  if (answer === "") return undefined;
  if ((BACKEND_NAMES as readonly string[]).includes(answer)) return answer as BackendName;
  io.print(`  unknown backend '${answer}'.`);
  return pickBackend(io);
}

async function buildEntry(
  io: WizardIO,
  deps: WizardDeps,
  installed: Map<SpawnableName, DetectResult>,
): Promise<Entry | undefined> {
  const backend = await pickBackend(io);
  if (!backend) return undefined;
  if (backend in SPAWNABLE && !installed.get(backend as SpawnableName)?.installed) {
    await offerInstall(io, deps, backend as SpawnableName);
  }
  const advisory = backend === "codex" ? await askYesNo(io, "  mark this codex entry advisory (never spawned; returns a hint)?", true) : false;
  if (advisory) return { backend, advisory: true };
  const model = await pickModel(io, deps, backend);
  if (!model) return undefined;
  return { backend, model };
}

async function configureTier(
  io: WizardIO,
  deps: WizardDeps,
  installed: Map<SpawnableName, DetectResult>,
  tier: TierName,
): Promise<Entry | Entry[] | null> {
  io.print(`\ntier '${tier}':`);
  const configure = await askYesNo(io, `  configure '${tier}'?`, tier !== "light");
  if (!configure) return null;

  const primary = await buildEntry(io, deps, installed);
  if (!primary) {
    io.print(`  no entry given — leaving '${tier}' unconfigured.`);
    return null;
  }

  const addFallback = !primary.advisory && (await askYesNo(io, `  add a fallback candidate to '${tier}'?`, false));
  if (!addFallback) return primary;

  const secondary = await buildEntry(io, deps, installed);
  return secondary ? [primary, secondary] : primary;
}

async function askFallbacks(io: WizardIO): Promise<InitSpec["fallbacks"]> {
  io.print("\ncross-tier fallback chain (an unconfigured/exhausted tier falls back to another):");
  const useDefault = await askYesNo(io, "  use the default chain (heavy -> standard -> light)?", true);
  return useDefault ? { heavy: "standard", standard: "light" } : {};
}

async function askCrossProvider(io: WizardIO): Promise<boolean> {
  io.print("\nallowCrossProviderFallback: when a tier falls back WITHIN its own chain to a candidate on a different");
  io.print("provider, this opt-in decides whether that's allowed — off means the prompt and repo content never leave the primary's provider.");
  return askYesNo(io, "  enable cross-provider fallback?", false);
}

export interface WizardResult {
  written: boolean;
  configPath?: string;
}

export async function runInitWizard(io: WizardIO, deps: WizardDeps): Promise<WizardResult> {
  const installed = await detectAndReport(io, deps);

  const tiers: Record<TierName, Entry | Entry[] | null> = { light: null, standard: null, heavy: null };
  for (const tier of TIER_NAMES) {
    tiers[tier] = await configureTier(io, deps, installed, tier);
  }

  const fallbacks = await askFallbacks(io);
  const allowCrossProviderFallback = await askCrossProvider(io);

  const spec: InitSpec = { tiers, capabilities: {}, fallbacks, allowCrossProviderFallback };
  const validated = validateSpec(spec);
  if (!validated.ok) {
    io.error(`\nthis config is invalid: ${validated.error}`);
    io.error("aborting without writing anything.");
    return { written: false };
  }

  const current = await deps.loadCurrent();
  io.print(`\n${diffConfigs(current, validated.config)}`);
  const risks = computeRisks(current, validated.config);
  if (risks.length > 0) {
    io.print("\nrisks:");
    for (const risk of risks) io.print(`  [${risk.code}] ${risk.message}`);
  }

  const confirmed = await askYesNo(io, `\nwrite this config to ${deps.configPath}?`, false);
  if (!confirmed) {
    io.print("aborted — nothing written.");
    return { written: false };
  }

  ensureConfigDir(deps.configPath, deps.env);
  writeConfigFile(deps.configPath, specToJson(spec));
  io.print(`wrote ${deps.configPath}`);

  const code = await runCheck({ configPath: deps.configPath, env: deps.env, detect: deps.detect, io });
  if (code !== 0) io.error("warning: --check reported a problem with the config it just wrote — see above.");

  return { written: true, configPath: deps.configPath };
}

/**
 * Thin readline glue: owns the real stdin/stdout interface and SIGINT
 * handling only. All decisions happen in runInitWizard above. index.ts's
 * `--init` branch is expected to have already verified stdin/stdout are TTYs
 * before calling this.
 */
export async function runInitCli(configPath?: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: WizardIO = {
    print: (line) => console.log(line),
    error: (line) => console.error(line),
    ask: (question) => rl.question(question),
  };
  // The temp-file + atomic-rename design in write.ts already guarantees a
  // Ctrl-C mid-write never leaves a partial config; this handler only needs
  // to close the readline interface so the terminal is left in a sane state.
  const onSigint = () => {
    io.print("\naborted — nothing written.");
    rl.close();
    process.exit(130);
  };
  process.once("SIGINT", onSigint);
  try {
    const deps = defaultWizardDeps(configPath, env);
    const result = await runInitWizard(io, deps);
    return result.written ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
    rl.close();
  }
}
