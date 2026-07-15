#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { validateCwd as coreValidateCwd } from "@mcp-coding-agents/core/cwd.js";
import { CwdQueue } from "@mcp-coding-agents/core/queue.js";

import { loadConfig, defaultConfigPath, validateConfigObject, configSchema, ROOTS_ENV_VAR } from "./config.js";
import { resolveEntries, cooldownKey } from "./tiers.js";
import { runChain, type FallbackDeps } from "./fallback.js";
import { createDeadline, attemptBudgetSec } from "./deadline.js";
import { CooldownRegistry } from "./cooldown.js";
import { computeFingerprint, settleFingerprint, fingerprintsEqual } from "./fingerprint.js";
import { formatRouteResult } from "./report.js";
import { SPAWNABLE, type SpawnableName } from "./backends/registry.js";
import { runCheck } from "./check.js";
import { crossesProvider } from "./provider.js";
import { runInitCli } from "./init/wizard.js";
import { computeRisks } from "./init/risk.js";
import { diffConfigs, commitPending, readPending, writePending } from "./init/write.js";
import { validateSpec, specToJson, type InitSpec } from "./init/spec.js";
import { discoverModels } from "./init/discovery.js";
import {
  TIER_NAMES,
  CAPABILITIES,
  type Backend,
  type BackendName,
  type Capability,
  type DetectResult,
  type RouterConfig,
  type TierName,
} from "./types.js";

// Router-wide singletons. Cooldowns and the per-cwd queue live for the process
// lifetime; config is (re)loaded per call so a user's edits and perms are
// re-checked every time rather than cached stale.
const cooldowns = new CooldownRegistry();
const queue = new CwdQueue();

function getBackend(name: BackendName): Backend {
  const backend = (SPAWNABLE as Record<string, Backend | undefined>)[name];
  if (!backend) {
    throw new Error(`backend '${name}' has no spawnable adapter registered`);
  }
  return backend;
}

/**
 * Fallback tuning. `cleanupReserveSec` must exceed the WORST-CASE settle time so
 * a chained attempt's budget always leaves room to certify the tree before the
 * deadline: reapMaxWaitMs (15s) plus one in-flight git read that can run up to
 * fingerprint's GIT_TIMEOUT_MS (10s) => reserve >25s. backendMin=30s matches the
 * grok floor.
 */
const TUNING = {
  reapStabilityMs: 750,
  reapMaxWaitMs: 15_000,
  cleanupReserveSec: 30,
  backendMinSec: 30,
  minViableNextSec: 60,
} as const;

const DETECT_TTL_MS = 30_000;
const detectCache = new Map<SpawnableName, { at: number; result: DetectResult }>();

async function detectCached(name: SpawnableName): Promise<DetectResult> {
  const now = Date.now();
  const cached = detectCache.get(name);
  if (cached && now - cached.at < DETECT_TTL_MS) return cached.result;
  const result = await SPAWNABLE[name].detect();
  detectCache.set(name, { at: now, result });
  return result;
}

function validateCwd(cwd: string) {
  return coreValidateCwd(cwd, { rootsEnvVar: ROOTS_ENV_VAR, requireRootIsDirectory: false });
}

function toolError(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}
function toolSuccess(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false };
}

const server = new McpServer({ name: "mcp-router", version: "0.1.0" });

server.registerTool(
  "route",
  {
    title: "Route a coding task to a model tier",
    description:
      "Delegate a coding task to the user-configured model behind a tier (light/standard/heavy), " +
      "optionally requiring capabilities (e.g. vision). Falls back to the next configured entry ONLY " +
      "when it is provably safe (the first backend never started, or the git working tree is byte-identical " +
      "after it failed on a capacity/auth/transport error). Timeout, empty results, task failures, and any " +
      "run that edited the tree are terminal and returned as-is. Fallback is meaningful mainly for fast, clean failures.",
    inputSchema: {
      prompt: z.string().describe("The coding task to delegate."),
      cwd: z.string().describe("Working directory; must be inside an allowed root (MCP_ROUTER_ROOTS)."),
      tier: z.enum(TIER_NAMES as unknown as [TierName, ...TierName[]]).describe("Routing tier: your declared intent for the slot, not a model size."),
      caps: z
        .array(z.enum(CAPABILITIES as unknown as [Capability, ...Capability[]]))
        .optional()
        .describe("Hard capability requirements (e.g. [\"vision\"])."),
      timeoutSec: z.number().int().min(30).max(3600).default(900),
    },
  },
  async (input, extra) => {
    try {
      const validation = await validateCwd(input.cwd);
      if (!validation.ok) return toolError(`Invalid cwd: ${validation.error}`);
      const resolvedCwd = validation.resolved!;

      let config;
      try {
        ({ config } = await loadConfig());
      } catch (err) {
        return toolError(`Config error: ${String((err as Error).message ?? err)}`);
      }

      const now = () => Date.now();
      const { entries, notes } = resolveEntries({
        config,
        tier: input.tier,
        caps: input.caps ?? [],
        isCooling: (key) => cooldowns.isCooling(key, now()),
      });
      if (entries.length === 0) {
        return toolError(
          [`status: no eligible entry for tier '${input.tier}'`, ...notes].join("\n"),
        );
      }

      const progressToken = extra._meta?.progressToken;
      const onProgress = progressToken
        ? (message: string) => {
            void extra.sendNotification({
              method: "notifications/progress",
              params: { progressToken, progress: 0, message },
            });
          }
        : undefined;

      return await queue.run(resolvedCwd, async () => {
        // Deadline starts at DEQUEUE, not call receipt, so queue wait does not
        // silently eat the client's tool-call budget.
        const deadline = createDeadline(input.timeoutSec, Date.now());
        const deps: FallbackDeps = {
          getBackend,
          cooldowns,
          now,
          fingerprint: {
            compute: computeFingerprint,
            settle: settleFingerprint,
            equal: fingerprintsEqual,
          },
          tuning: TUNING,
          allowCrossProviderFallback: config.allowCrossProviderFallback,
        };
        const result = await runChain(
          { entries, prompt: input.prompt, cwd: resolvedCwd, deadline, signal: extra.signal, onProgress },
          deps,
        );
        const preamble = notes.length > 0 ? `routing notes:\n${notes.map((n) => `  - ${n}`).join("\n")}\n\n` : "";
        const body = preamble + formatRouteResult(result);
        return result.ok ? toolSuccess(body) : toolError(body);
      });
    } catch (err) {
      return toolError(`route failed unexpectedly: ${String((err as Error).message ?? err)}`);
    }
  },
);

server.registerTool(
  "list_tiers",
  {
    title: "List configured tiers and installed backends",
    description:
      "Discovery tool: show which tiers/capabilities are configured (and to which backend/provider/model), " +
      "which are cooling and for how long, and which supported CLIs are installed. Sends no prompt and probes no provider. " +
      "Call this before route() so you never dispatch into an unconfigured slot.",
    inputSchema: {},
  },
  async () => {
    try {
      const loaded = await loadConfig().catch((err) => {
        throw new Error(`Config error: ${String((err as Error).message ?? err)}`);
      });
      const { config, source } = loaded;
      const now = Date.now();
      // Report only whether the config came from a file vs auto-detect — NOT the
      // absolute path, which would leak the server's home-directory/username
      // layout to the untrusted caller. (`mcp-router --check` prints the path for
      // the operator locally; this always-on discovery surface does not.)
      const lines: string[] = [`config source: ${source}`];

      lines.push("", "tiers:");
      for (const tier of TIER_NAMES) {
        const list = config.tiers[tier];
        if (list.length === 0) {
          lines.push(`  ${tier}: (unconfigured)`);
          continue;
        }
        // Report PRESENCE + tier-level cooling only — never the candidate count.
        // Cooling is at TIER GRANULARITY: the slot is [cooling] iff EVERY
        // configured candidate is currently cooling (the tier as a whole is
        // unavailable). Per-candidate cooling would be a per-model health oracle,
        // and emitting a candidate count — even the total — would leak the user's
        // private config cardinality (the very thing this granularity protects).
        // The exact TTL is suppressed too: it encodes the cooldown category
        // (capacity 10m / auth 30m / transport 5m) the coarse report.ts mapping hides.
        const allCooling = list.every((e) => cooldowns.isCooling(cooldownKey(e), now));
        lines.push(`  ${tier}: configured${allCooling ? " [cooling]" : ""}`);
      }

      lines.push("", "capabilities:");
      for (const cap of CAPABILITIES) {
        // Presence only — same rationale as tiers above: the backend/provider/
        // model identity is private config not exposed on this discovery surface.
        // (router_dry_run is the explicit recipient-preview tool for that.)
        lines.push(`  ${cap}: ${config.capabilities[cap] ? "configured" : "(unconfigured)"}`);
      }

      lines.push("", "installed backends:");
      const backendNames = Object.keys(SPAWNABLE) as SpawnableName[];
      // Probe backends concurrently: the detections are independent, so on a cold
      // cache this is one spawn's latency instead of the sum of three.
      const detections = await Promise.all(backendNames.map((name) => detectCached(name)));
      backendNames.forEach((name, index) => {
        const det = detections[index];
        lines.push(`  ${name}: ${det.installed ? `installed${det.version ? ` (${det.version})` : ""}` : "not found"}`);
      });

      return toolSuccess(lines.join("\n"));
    } catch (err) {
      return toolError(String((err as Error).message ?? err));
    }
  },
);

server.registerTool(
  "router_dry_run",
  {
    title: "Preview routing without running",
    description:
      "Safety previewer: resolve a cwd + tier + caps into the exact ordered recipients (backend/provider/model), " +
      "the fallback authorization decisions, cross-provider crossings that would need opt-in, and the budget split — " +
      "WITHOUT sending the prompt or probing any provider.",
    inputSchema: {
      cwd: z.string(),
      tier: z.enum(TIER_NAMES as unknown as [TierName, ...TierName[]]),
      caps: z.array(z.enum(CAPABILITIES as unknown as [Capability, ...Capability[]])).optional(),
      timeoutSec: z.number().int().min(30).max(3600).default(900),
    },
  },
  async (input) => {
    try {
      const validation = await validateCwd(input.cwd);
      if (!validation.ok) return toolError(`Invalid cwd: ${validation.error}`);

      let config;
      try {
        ({ config } = await loadConfig());
      } catch (err) {
        return toolError(`Config error: ${String((err as Error).message ?? err)}`);
      }

      const now = Date.now();
      const { entries, notes } = resolveEntries({
        config,
        tier: input.tier,
        caps: input.caps ?? [],
        isCooling: (key) => cooldowns.isCooling(key, now),
      });

      const lines: string[] = [`resolved cwd: ${validation.resolved}`, `tier: ${input.tier}`, ""];
      if (notes.length > 0) lines.push("notes:", ...notes.map((n) => `  - ${n}`), "");

      if (entries.length === 0) {
        lines.push("recipients: (none — nothing configured/eligible for this request)");
        return toolSuccess(lines.join("\n"));
      }

      lines.push("recipients (in fallback order):");
      // Faithful simulation of runChain: advisory is terminal (returns before
      // the cross-provider gate and before any budget/run); a cross-provider hop
      // is blocked unless opted in (the blocked candidate is skipped, not
      // chain-killing, so later same-provider candidates remain reachable); and
      // the budget drains CUMULATIVELY across candidates (each prior attempt
      // consumes its soft-capped budget) rather than resetting to the full
      // timeout. prevProvider only advances for candidates that would actually
      // run, matching the runner.
      let prevProvider: string | undefined;
      let remaining = input.timeoutSec;
      for (let i = 0; i < entries.length; i += 1) {
        const e = entries[i];
        const target = e.advisory ? `${e.backend} (advisory)` : `${e.backend} · ${e.model ?? "?"}`;
        if (e.advisory) {
          lines.push(`  ${i + 1}. ${e.name}: ${target}  (advisory — terminal, no run)`);
          break;
        }
        let note = "";
        let blocked = false;
        if (i > 0 && prevProvider !== undefined && crossesProvider(prevProvider, e.provider)) {
          if (config.allowCrossProviderFallback) {
            note = " [crosses provider — allowed]";
          } else {
            note = " [crosses provider — BLOCKED unless allowCrossProviderFallback set]";
            blocked = true;
          }
        }
        if (blocked) {
          lines.push(`  ${i + 1}. ${e.name}: ${target}  (skipped)${note}`);
          continue;
        }
        const budget = attemptBudgetSec({
          remainingSec: remaining,
          hasNextEntry: i < entries.length - 1,
          backendMinSec: TUNING.backendMinSec,
          cleanupReserveSec: TUNING.cleanupReserveSec,
          minViableNextSec: TUNING.minViableNextSec,
        });
        const budgetLabel = budget === null ? "insufficient budget" : `~${budget}s budget`;
        lines.push(`  ${i + 1}. ${e.name}: ${target}  (${budgetLabel})${note}`);
        if (budget === null) break;
        remaining = Math.max(0, remaining - budget);
        prevProvider = e.provider;
      }
      lines.push("", `total budget: ${input.timeoutSec}s (drained cumulatively per candidate; advisory is terminal)`);
      return toolSuccess(lines.join("\n"));
    } catch (err) {
      return toolError(`router_dry_run failed unexpectedly: ${String((err as Error).message ?? err)}`);
    }
  },
);

// --- init tools: config authoring over MCP (opt-in) -------------------------
// Config is the router's trust boundary: it decides where prompts and repo
// content get sent. Authoring it on the same channel that carries untrusted
// prompt content is a deliberate SETUP mode, never on by default — the three
// tools below register ONLY when MCP_ROUTER_ALLOW_INIT=1. Even then, init_apply
// can only stage a `<config>.pending` file; it can NEVER write the live config.
// Promotion requires a human running `mcp-orchestrate --accept-pending` at a
// real terminal, where they see the diff + risks and confirm — so a
// prompt-injected tool chain can at most stage a change a person must accept.
const INIT_ENABLED = process.env.MCP_ROUTER_ALLOW_INIT === "1";

if (INIT_ENABLED) {
  // Reuse the server's own config field schemas so a spec the tool accepts is,
  // by construction, shaped like the config the server validates. capabilities
  // and fallbacks default to empty so the caller only has to send tiers.
  const specInputShape = {
    tiers: configSchema.shape.tiers,
    capabilities: configSchema.shape.capabilities.default({}),
    fallbacks: configSchema.shape.fallbacks.default({}),
    allowCrossProviderFallback: z.boolean().default(false),
  };

  const specFromInput = (input: {
    tiers: RouterConfig["tiers"];
    capabilities: RouterConfig["capabilities"];
    fallbacks: RouterConfig["fallbacks"];
    allowCrossProviderFallback: boolean;
  }): InitSpec => ({
    tiers: input.tiers,
    capabilities: input.capabilities,
    fallbacks: input.fallbacks,
    allowCrossProviderFallback: input.allowCrossProviderFallback,
  });

  // A currently-unreadable/invalid live config is the operator's problem to fix
  // (via --check); for a preview diff we treat it as "no baseline" rather than
  // failing the whole setup flow.
  const currentFileConfig = async (): Promise<RouterConfig | null> => {
    try {
      const loaded = await loadConfig();
      return loaded.source === "file" ? loaded.config : null;
    } catch {
      return null;
    }
  };

  const formatRisks = (risks: ReturnType<typeof computeRisks>): string[] => {
    if (risks.length === 0) return ["", "risks: none"];
    return ["", "risks:", ...risks.map((r) => `  [${r.code}] ${r.message}`)];
  };

  server.registerTool(
    "init_status",
    {
      title: "Setup: detected backends, available models, tier presence",
      description:
        "Setup helper (present only when MCP_ROUTER_ALLOW_INIT=1). Reports which backend CLIs are installed, " +
        "the models each installed backend advertises (best-effort and UNTRUSTED — you still confirm every choice), " +
        "and which tiers/capabilities are currently configured (presence only — no model ids, no config path). " +
        "Sends no prompt. Gather choices here, then call init_preview with a proposed config.",
      inputSchema: {},
    },
    async () => {
      try {
        const backendNames = Object.keys(SPAWNABLE) as SpawnableName[];
        const detections = await Promise.all(backendNames.map((name) => detectCached(name)));
        const lines: string[] = ["installed backends:"];
        backendNames.forEach((name, i) => {
          const det = detections[i];
          lines.push(`  ${name}: ${det.installed ? `installed${det.version ? ` (${det.version})` : ""}` : "not found"}`);
        });

        // Discover only from INSTALLED backends, concurrently. Output is treated
        // as hostile inside discoverModels; it only seeds a pick-list the user
        // still confirms, so a lying CLI cannot silently redirect a route.
        const installed = backendNames.filter((_, i) => detections[i].installed);
        const discovered = await Promise.all(installed.map((name) => discoverModels(name)));
        lines.push("", "available models (best-effort; untrusted — confirm before use):");
        installed.forEach((name, i) => {
          const res = discovered[i];
          if ("models" in res && res.models.length > 0) {
            const shown = res.models.slice(0, 30);
            lines.push(`  ${name}: ${shown.join(", ")}${res.models.length > shown.length ? ", …" : ""}`);
          } else {
            lines.push(`  ${name}: (no list available — type the model id directly)`);
          }
        });

        // Presence only, same posture as list_tiers: the current model ids are
        // private config and are revealed only inside an operator-requested
        // init_preview diff, never dumped on this discovery surface.
        const current = await currentFileConfig();
        lines.push("", "current config (presence only):");
        for (const tier of TIER_NAMES) {
          lines.push(`  ${tier}: ${(current?.tiers[tier].length ?? 0) > 0 ? "configured" : "(unconfigured)"}`);
        }
        for (const cap of CAPABILITIES) {
          lines.push(`  ${cap}: ${current?.capabilities[cap] ? "configured" : "(unconfigured)"}`);
        }

        return toolSuccess(lines.join("\n"));
      } catch (err) {
        return toolError(String((err as Error).message ?? err));
      }
    },
  );

  server.registerTool(
    "init_preview",
    {
      title: "Setup: validate a proposed config and show its diff + risks",
      description:
        "Setup helper (MCP_ROUTER_ALLOW_INIT=1 only). Validates a proposed config through the EXACT server " +
        "validation path and returns the change diff vs the live config plus a server-computed risk list " +
        "(primary-route provider changes, aggregator primaries, cross-provider fallbacks, the cross-provider flag). " +
        "Writes NOTHING. Always preview before init_apply.",
      inputSchema: specInputShape,
    },
    async (input) => {
      try {
        const validated = validateSpec(specFromInput(input));
        if (!validated.ok) return toolError(`invalid config: ${validated.error}`);
        const current = await currentFileConfig();
        const lines = [
          diffConfigs(current, validated.config),
          ...formatRisks(computeRisks(current, validated.config)),
          "",
          "valid — the server will accept this config. Call init_apply to stage it for the operator to accept.",
        ];
        return toolSuccess(lines.join("\n"));
      } catch (err) {
        return toolError(String((err as Error).message ?? err));
      }
    },
  );

  server.registerTool(
    "init_apply",
    {
      title: "Setup: stage a proposed config as pending (never writes live)",
      description:
        "Setup helper (MCP_ROUTER_ALLOW_INIT=1 only). Validates the proposed config, then stages it as a PENDING " +
        "file beside the live config. It does NOT and CANNOT make the config live. To take effect, the operator " +
        "must run `mcp-orchestrate --accept-pending` in their own terminal, review the diff + risks, and confirm. " +
        "Returns the diff + risks so you can relay them to the operator.",
      inputSchema: specInputShape,
    },
    async (input) => {
      try {
        const spec = specFromInput(input);
        const validated = validateSpec(spec);
        if (!validated.ok) return toolError(`invalid config: ${validated.error}`);
        const current = await currentFileConfig();
        const configPath = process.env.MCP_ROUTER_CONFIG ?? defaultConfigPath();
        writePending(configPath, specToJson(spec));
        const lines = [
          "staged a PENDING config — it is NOT live yet.",
          "",
          diffConfigs(current, validated.config),
          ...formatRisks(computeRisks(current, validated.config)),
          "",
          "To apply it, the operator must run this in their terminal and confirm:",
          "  mcp-orchestrate --accept-pending",
        ];
        return toolSuccess(lines.join("\n"));
      } catch (err) {
        return toolError(String((err as Error).message ?? err));
      }
    },
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

let isMainModule = false;
if (process.argv[1] !== undefined) {
  try {
    isMainModule = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    isMainModule = path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  }
}
if (isMainModule) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("mcp-orchestrate: MCP stdio server routing coding tasks across configured model tiers");
    console.log("");
    console.log("Usage:");
    console.log("  mcp-orchestrate                      start the MCP stdio server (spawned by your MCP client)");
    console.log("  mcp-orchestrate --check [path]        validate the config and report whether the server will accept it");
    console.log("  mcp-orchestrate --init                interactive setup wizard (writes the live config; requires a TTY)");
    console.log("  mcp-orchestrate --accept-pending [path]   review + commit a pending config (requires a TTY)");
    console.log("  mcp-orchestrate --help                show this help");
  } else if (argv.includes("--check")) {
    // Config doctor: validate via the real loader and exit 0 (valid) / 1 (invalid
    // or absent). An optional bare path after --check overrides the config location.
    const idx = argv.indexOf("--check");
    const next = argv[idx + 1];
    const configPath = next !== undefined && !next.startsWith("-") ? next : undefined;
    runCheck({ configPath, detect: (name) => detectCached(name) })
      .then((code) => process.exit(code))
      .catch((err) => {
        console.error("check failed:", String((err as Error).message ?? err));
        process.exit(1);
      });
  } else if (argv.includes("--init")) {
    // Full human-principal authority: --init writes the live config directly
    // (no pending/commit step) once the operator confirms. It REQUIRES a real
    // terminal — no silent defaults for a flow that decides where prompts and
    // repo content get sent.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("--init needs an interactive terminal; write config by hand or use --check");
      process.exit(2);
    } else {
      const idx = argv.indexOf("--init");
      const next = argv[idx + 1];
      const configPath = next !== undefined && !next.startsWith("-") ? next : undefined;
      runInitCli(configPath)
        .then((code) => process.exit(code))
        .catch((err) => {
          console.error("init failed:", String((err as Error).message ?? err));
          process.exit(1);
        });
    }
  } else if (argv.includes("--accept-pending")) {
    void acceptPendingCli(argv);
  } else {
    main().catch((err) => {
      console.error("Fatal error starting mcp-router:", err);
      process.exit(1);
    });
  }
}

/**
 * Review + commit a `<config>.pending` file (written by e.g. an MCP tool the
 * server exposes to an assistant) onto the live config. This is the human
 * attestation step for the MCP-staging path, so it ALWAYS requires a real
 * terminal and an explicit y/N — there is deliberately no non-interactive
 * bypass: a `--yes`/headless promotion would let a shell-capable assistant
 * that just called `init_apply` promote its own staged config unattended,
 * which is exactly the invariant this step exists to prevent. Never touches
 * the live config on a validation failure — commitPending rolls back and
 * leaves the pending file in place.
 */
async function acceptPendingCli(argv: string[]): Promise<void> {
  const idx = argv.indexOf("--accept-pending");
  const next = argv[idx + 1];
  const configPath = (next !== undefined && !next.startsWith("-") ? next : undefined) ?? defaultConfigPath();

  let pendingRaw: string;
  try {
    pendingRaw = readPending(configPath);
  } catch (err) {
    const message = String((err as Error).message ?? err);
    if (message.includes("no pending config at")) {
      console.log("no pending config to accept");
    } else {
      // A real hardening failure (bad perms/owner/parent) — distinct from "none exists".
      console.error(`pending config unreadable: ${message}`);
    }
    process.exit(1);
    return;
  }

  let next_: RouterConfig;
  try {
    next_ = validateConfigObject(JSON.parse(pendingRaw));
  } catch (err) {
    console.error(`pending config is invalid: ${String((err as Error).message ?? err)}`);
    console.error("live config and pending file left untouched.");
    process.exit(1);
    return;
  }

  const current = await loadConfig({ configPath }).then(
    (loaded) => (loaded.source === "file" ? loaded.config : null),
    () => null,
  );
  console.log(diffConfigs(current, next_));
  const risks = computeRisks(current, next_);
  if (risks.length > 0) {
    console.log("\nrisks:");
    for (const risk of risks) console.log(`  [${risk.code}] ${risk.message}`);
  }

  // Always require a human at a real terminal — no non-interactive bypass (see
  // the function docstring for why). A headless/piped invocation is refused.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("--accept-pending requires an interactive terminal to review and confirm; run it yourself at a TTY.");
    process.exit(2);
    return;
  }
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`accept this pending config for ${configPath}? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    console.log("aborted — pending config left untouched.");
    process.exit(1);
    return;
  }

  try {
    commitPending(configPath);
  } catch (err) {
    console.error(`commit failed: ${String((err as Error).message ?? err)}`);
    console.error("live config and pending file left untouched.");
    process.exit(1);
    return;
  }
  console.log(`accepted pending config -> ${configPath}`);
  const code = await runCheck({ configPath, detect: (name) => detectCached(name) });
  process.exit(code);
}
