// Server-computed risk set the wizard shows before writing a config. This is
// deliberately independent of any UI copy: it inspects the VALIDATED configs
// (current live config, if any, vs. the candidate) and flags anything that
// changes where prompt/repo content is sent. Pure and side-effect free — no
// spawning, no I/O — so it is trivially unit-testable and cannot itself leak
// data anywhere.

import { deriveProvider, isAggregatorProvider } from "../provider.js";
import { CAPABILITIES, TIER_NAMES } from "../types.js";
import type { Capability, Entry, RouterConfig, TierName } from "../types.js";

export interface Risk {
  code: string;
  tier?: TierName;
  message: string;
}

// Entries that reach here have already been through authorize(), which
// derives + stamps `.provider` on every entry (including the advisory
// backend-name fallback). Prefer that stamped value; fall back to a fresh
// derivation only for a config that somehow arrives unauthorized so this
// module never trusts an unverified `.provider`.
function resolveProvider(entry: Entry): string {
  return entry.provider ?? deriveProvider(entry.backend, entry.model);
}

/** The provider a slot actually SPAWNS to (undefined = unconfigured or an
 * advisory hint that never ships anything). `slot` is the entry that runs
 * first for a tier (its primary) or the single capability entry. */
function spawnProvider(entry: Entry | undefined): string | undefined {
  if (!entry || entry.advisory) return undefined;
  return resolveProvider(entry);
}

export function computeRisks(current: RouterConfig | null, next: RouterConfig): Risk[] {
  const risks: Risk[] = [];

  // 1. The cross-provider fallback gate itself flipping on: this is the
  // single opt-in that allows ANY fallback to ship data to a second provider.
  const currentFlag = current?.allowCrossProviderFallback ?? false;
  if (!currentFlag && next.allowCrossProviderFallback) {
    risks.push({
      code: "cross-provider-flag",
      message: "allowCrossProviderFallback turns ON: a fallback may now ship the prompt and repo content to a different provider than the primary.",
    });
  }

  // A destination is any slot the router spawns to: a tier's PRIMARY entry or a
  // capability slot's entry. Both change WHERE prompt + repo content go, so both
  // get the same primary-route-exfil + aggregator checks (label distinguishes
  // which slot). This closes the earlier gap where capability slots — a real
  // egress route (tiers.ts routes to config.capabilities[cap]) — were unchecked.
  const evalDestination = (
    label: string,
    currentEntry: Entry | undefined,
    nextEntry: Entry | undefined,
    tier: TierName | undefined,
  ): void => {
    const nextProvider = spawnProvider(nextEntry);
    if (nextProvider === undefined) return;
    const currentProvider = spawnProvider(currentEntry);

    if (currentProvider === undefined) {
      risks.push({ code: "primary-provider-change", tier, message: `${label} was unconfigured and now routes to '${nextProvider}'.` });
    } else if (currentProvider !== nextProvider) {
      risks.push({ code: "primary-provider-change", tier, message: `${label} provider changes: '${currentProvider}' -> '${nextProvider}'.` });
    }

    // An aggregator's downstream provider is opaque (see provider.ts) — flag it
    // every time it's a destination, independent of whether it changed.
    if (isAggregatorProvider(nextProvider)) {
      risks.push({
        code: "aggregator-primary",
        tier,
        message: `${label} '${nextEntry!.backend}' resolves to aggregator provider '${nextProvider}'; its true downstream provider is opaque.`,
      });
    }
  };

  for (const tier of TIER_NAMES) {
    const nextList = next.tiers[tier];
    const currentList = current?.tiers[tier] ?? [];
    evalDestination(`tier '${tier}' primary`, currentList[0], nextList[0], tier);

    // Any non-primary candidate in this tier's OWN chain that sits on a
    // different provider than the primary — the data that would ship to a
    // second provider the moment this tier falls back internally.
    const nextProvider = spawnProvider(nextList[0]);
    if (nextProvider !== undefined) {
      for (let i = 1; i < nextList.length; i += 1) {
        const candidate = nextList[i];
        if (candidate.advisory) continue;
        const candidateProvider = resolveProvider(candidate);
        if (candidateProvider !== nextProvider) {
          risks.push({
            code: "cross-provider-fallback",
            tier,
            message: `tier '${tier}' fallback candidate #${i + 1} (${candidate.backend} · ${candidate.model ?? "?"}) is on provider '${candidateProvider}', different from primary '${nextProvider}'.`,
          });
        }
      }
    }
  }

  // Capability slots are spawn destinations too (a `vision` request routes to
  // config.capabilities.vision) — evaluate each for the same primary-route risks.
  for (const cap of CAPABILITIES as readonly Capability[]) {
    evalDestination(`capability '${cap}'`, current?.capabilities[cap], next.capabilities[cap], undefined);
  }

  // CROSS-TIER fallback edges: a tier S whose chain is exhausted falls back to
  // tier fallbacks[S]. If that target primary is on a different provider AND the
  // cross-provider opt-in is on, S's prompt/repo can ship to that other provider
  // — a real egress path the within-tier check above cannot see.
  if (next.allowCrossProviderFallback) {
    for (const source of TIER_NAMES) {
      const target = next.fallbacks[source];
      if (!target) continue;
      const sourceProvider = spawnProvider(next.tiers[source][0]);
      const targetProvider = spawnProvider(next.tiers[target][0]);
      if (sourceProvider !== undefined && targetProvider !== undefined && sourceProvider !== targetProvider) {
        risks.push({
          code: "cross-tier-fallback",
          tier: source,
          message: `tier '${source}' falls back to tier '${target}' on a different provider ('${sourceProvider}' -> '${targetProvider}'); with cross-provider fallback enabled, '${source}' content can ship to '${targetProvider}'.`,
        });
      }
    }
  }

  return risks;
}
