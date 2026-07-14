#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { validateCwd as coreValidateCwd } from "@mcp-coding-agents/core/cwd.js";
import { CwdQueue } from "@mcp-coding-agents/core/queue.js";

import { loadConfig, ROOTS_ENV_VAR } from "./config.js";
import { resolveEntries, cooldownKey } from "./tiers.js";
import { runChain, type FallbackDeps } from "./fallback.js";
import { createDeadline, attemptBudgetSec } from "./deadline.js";
import { CooldownRegistry } from "./cooldown.js";
import { computeFingerprint, settleFingerprint, fingerprintsEqual } from "./fingerprint.js";
import { formatRouteResult } from "./report.js";
import { OpencodeBackend } from "./backends/opencode.js";
import { GrokBackend } from "./backends/grok.js";
import { CodexBackend } from "./backends/codex.js";
import { crossesProvider } from "./provider.js";
import {
  TIER_NAMES,
  CAPABILITIES,
  type Backend,
  type BackendName,
  type Capability,
  type DetectResult,
  type TierName,
} from "./types.js";

// Router-wide singletons. Cooldowns and the per-cwd queue live for the process
// lifetime; config is (re)loaded per call so a user's edits and perms are
// re-checked every time rather than cached stale.
const cooldowns = new CooldownRegistry();
const queue = new CwdQueue();

// Spawnable backends live here. codex is spawnable (non-advisory entries route
// to CodexBackend); an entry may still opt into `advisory: true` to keep the
// router from spawning it and instead return a hint to use codex's own MCP.
const SPAWNABLE = {
  opencode: new OpencodeBackend(),
  grok: new GrokBackend(),
  codex: new CodexBackend(),
} as const;
type SpawnableName = keyof typeof SPAWNABLE;

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
      const { config, source, path: configPath } = loaded;
      const now = Date.now();
      const lines: string[] = [`config source: ${source}${configPath ? ` (${configPath})` : ""}`];

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
        const entry = config.capabilities[cap];
        lines.push(
          entry
            ? `  ${cap}: ${entry.backend} · ${entry.provider ?? "?"}/${entry.model ?? "?"}`
            : `  ${cap}: (unconfigured)`,
        );
      }

      lines.push("", "installed backends:");
      for (const name of Object.keys(SPAWNABLE) as SpawnableName[]) {
        const det = await detectCached(name);
        lines.push(`  ${name}: ${det.installed ? `installed${det.version ? ` (${det.version})` : ""}` : "not found"}`);
      }

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
        const target = e.advisory ? `${e.backend} (advisory)` : `${e.backend} · ${e.provider}/${e.model ?? "?"}`;
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
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("mcp-router: MCP stdio server routing coding tasks across configured model tiers");
    console.log("Usage: mcp-router");
  } else {
    main().catch((err) => {
      console.error("Fatal error starting mcp-router:", err);
      process.exit(1);
    });
  }
}
