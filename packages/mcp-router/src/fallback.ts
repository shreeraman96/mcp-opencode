import type {
  AttemptRecord,
  Backend,
  BackendName,
  ResolvedEntry,
  RouteResult,
} from "./types.js";
import type { Deadline } from "./deadline.js";
import { attemptBudgetSec } from "./deadline.js";
import { CooldownRegistry } from "./cooldown.js";
import type { Fingerprint } from "./fingerprint.js";
import { crossesProvider } from "./provider.js";
import { coarseReason } from "./report.js";
import type { ErrorCategory, Provenance, StructuredError } from "@mcp-coding-agents/core";

export interface FingerprintApi {
  compute(cwd: string): Promise<Fingerprint>;
  settle(
    cwd: string,
    opts: { stabilityMs: number; maxWaitMs: number },
  ): Promise<{ settled: boolean; fingerprint: Fingerprint }>;
  equal(a: Fingerprint, b: Fingerprint): boolean;
}

export interface FallbackTuning {
  reapStabilityMs: number;
  reapMaxWaitMs: number;
  cleanupReserveSec: number;
  backendMinSec: number;
  minViableNextSec: number;
}

export interface FallbackDeps {
  getBackend(name: BackendName): Backend;
  cooldowns: CooldownRegistry;
  now(): number;
  fingerprint: FingerprintApi;
  tuning: FallbackTuning;
  allowCrossProviderFallback: boolean;
}

export interface RunChainArgs {
  entries: ResolvedEntry[];
  prompt: string;
  cwd: string;
  deadline: Deadline;
  signal: AbortSignal;
  onProgress?: (msg: string) => void;
}

const CATEGORY_PRIORITY: readonly ErrorCategory[] = [
  "capacity",
  "auth",
  "transport",
  "timeout",
  "model",
  "empty",
  "task",
  "unknown",
];

function primaryCategory(errors: StructuredError[]): ErrorCategory | undefined {
  for (const category of CATEGORY_PRIORITY) {
    if (errors.some((error) => error.category === category)) return category;
  }
  return undefined;
}

function primaryProvenance(errors: StructuredError[]): Provenance | undefined {
  const category = primaryCategory(errors);
  if (category !== undefined) {
    return errors.find((error) => error.category === category)?.provenance;
  }
  return errors[0]?.provenance;
}

export async function runChain(args: RunChainArgs, deps: FallbackDeps): Promise<RouteResult> {
  const trace: AttemptRecord[] = [];
  let crossProviderNotice: string | undefined;
  let prevProvider: string | undefined;

  for (let i = 0; i < args.entries.length; i += 1) {
    const entry = args.entries[i];

    if (args.signal.aborted) {
      trace.push({ entry: entry.name, reason: "aborted", provenance: "exit", elapsedSec: 0, editedTree: false });
      break;
    }

    // Advisory tiers send no prompt/repo content to any provider (the caller
    // uses that backend's own MCP), so they are exempt from the cross-provider
    // egress gate and are resolved before it.
    if (entry.advisory === true) {
      const text =
        `Advisory tier: run this task via the '${entry.backend}' MCP server directly` +
        (entry.model ? ` (model ${entry.model})` : "");
      trace.push({ entry: entry.name, reason: "ok", provenance: "exit", elapsedSec: 0, editedTree: false });
      return { ok: true, servedBy: entry, trace, crossProviderNotice, text };
    }

    if (i > 0 && prevProvider !== undefined && crossesProvider(prevProvider, entry.provider)) {
      if (!deps.allowCrossProviderFallback) {
        crossProviderNotice =
          `fallback across providers blocked (${prevProvider} -> ${entry.provider}); set allowCrossProviderFallback to enable`;
        // Skip this blocked cross-provider candidate but keep walking: a later
        // same-provider candidate is still eligible. prevProvider is only ever
        // set after an eligible attempt, so continue is safe.
        continue;
      }
      crossProviderNotice = `fell back across providers: ${prevProvider} -> ${entry.provider}`;
    }

    const budget = attemptBudgetSec({
      remainingSec: args.deadline.remainingSec(deps.now()),
      hasNextEntry: i < args.entries.length - 1,
      backendMinSec: deps.tuning.backendMinSec,
      cleanupReserveSec: deps.tuning.cleanupReserveSec,
      minViableNextSec: deps.tuning.minViableNextSec,
    });
    if (budget === null) {
      trace.push({ entry: entry.name, reason: "timeout", provenance: "timeout", elapsedSec: 0, editedTree: false });
      break;
    }

    const fBefore = await deps.fingerprint.compute(args.cwd);
    args.onProgress?.(`attempt ${i + 1}/${args.entries.length} · ${entry.name} · ${budget}s`);

    const outcome = await deps.getBackend(entry.backend).run({
      prompt: args.prompt,
      cwd: args.cwd,
      model: entry.model ?? "",
      provider: entry.provider,
      timeoutSec: budget,
      signal: args.signal,
      onHeartbeat: undefined,
    });

    if (outcome.ok) {
      // Report whether the backend actually touched the tree instead of
      // asserting a blanket "clean". Success needs no fallback, so a single
      // post-run snapshot (no settle/quiescence proof) is enough and keeps the
      // hot path fast. Unmeasurable (non-git cwd or an unreliable git read) is
      // reported as `undefined` (surfaced as "unknown"), never a false "clean".
      let editedTree: boolean | undefined;
      if (fBefore.gitTracked && fBefore.reliable) {
        const fAfter = await deps.fingerprint.compute(args.cwd);
        editedTree = fAfter.reliable ? !deps.fingerprint.equal(fBefore, fAfter) : undefined;
      }
      trace.push({
        entry: entry.name,
        reason: "ok",
        provenance: primaryProvenance(outcome.errors) ?? "exit",
        elapsedSec: outcome.elapsedSec,
        editedTree,
      });
      return { ok: true, servedBy: entry, trace, crossProviderNotice, text: outcome.text };
    }

    const category = primaryCategory(outcome.errors);
    const provenance = primaryProvenance(outcome.errors) ?? "exit";
    const spawnFailure = outcome.errors.some((error) => error.provenance === "spawn");
    const aborted = args.signal.aborted;
    let editedTree: boolean;
    let eligible: boolean;

    /*
     * Safety gate. EVERY post-attempt fallback requires a git-tracked cwd whose
     * fingerprint is byte-identical after a proven-quiet settle window. A
     * changed OR unsettled tree, or a non-git cwd, is terminal: handing partial
     * edits to another backend could compound or overwrite work.
     *
     * "spawn" provenance is deliberately NOT a fingerprint bypass. It is not a
     * trustworthy nothing-ran proof: grok derives it by keyword-matching its
     * model-influenced output channel (see core classifyGrok), so a crafted
     * task could edit the tree and then emit "command not found: grok" to forge
     * it. A backend that genuinely never spawned leaves the tree clean, so real
     * not-installed failures still fall back on a git cwd via the gate below --
     * without trusting the forgeable signal.
     */
    if (aborted) {
      eligible = false;
      editedTree = false;
    } else if (!fBefore.gitTracked) {
      // Cannot certify cleanliness without a tracked tree.
      eligible = false;
      editedTree = false;
    } else {
      const settle = await deps.fingerprint.settle(args.cwd, {
        stabilityMs: deps.tuning.reapStabilityMs,
        maxWaitMs: deps.tuning.reapMaxWaitMs,
      });
      if (!settle.settled) {
        // An active writer cannot be safely handed to a second backend.
        eligible = false;
        editedTree = true;
      } else {
        editedTree = !deps.fingerprint.equal(fBefore, settle.fingerprint);
        eligible =
          !editedTree &&
          (category === "capacity" || category === "auth" || category === "transport");
      }
    }

    if (category === "capacity" || category === "auth" || category === "transport") {
      deps.cooldowns.record(entry.cooldownKey, category, deps.now());
    }

    trace.push({
      entry: entry.name,
      reason: coarseReason(category, { aborted, notInstalled: spawnFailure }),
      provenance,
      elapsedSec: outcome.elapsedSec,
      editedTree,
    });

    if (eligible) {
      prevProvider = entry.provider;
      continue;
    }
    return { ok: false, servedBy: undefined, trace, crossProviderNotice, text: outcome.text };
  }

  return { ok: false, trace, crossProviderNotice, text: undefined };
}
