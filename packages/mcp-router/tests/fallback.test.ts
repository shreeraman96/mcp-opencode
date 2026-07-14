import { describe, it, expect } from "vitest";

import { runChain, type FallbackDeps, type FallbackTuning, type FingerprintApi } from "../src/fallback.js";
import { CooldownRegistry } from "../src/cooldown.js";
import { createDeadline } from "../src/deadline.js";
import type { Fingerprint } from "../src/fingerprint.js";
import type {
  Backend,
  BackendName,
  Capability,
  DetectResult,
  Entry,
  NormalizedOutcome,
  ResolvedEntry,
  RunRequest,
} from "../src/types.js";
import type { ErrorCategory, Provenance } from "@mcp-coding-agents/core";

const FIXED_NOW = 1_000_000;

function defaultTuning(overrides: Partial<FallbackTuning> = {}): FallbackTuning {
  return {
    reapStabilityMs: 300,
    reapMaxWaitMs: 1000,
    cleanupReserveSec: 5,
    backendMinSec: 10,
    minViableNextSec: 20,
    ...overrides,
  };
}

function makeEntry(partial: Partial<ResolvedEntry> & Pick<ResolvedEntry, "name">): ResolvedEntry {
  const merged = {
    backend: "opencode" as BackendName,
    provider: "prov",
    model: "prov/model-a" as string | undefined,
    advisory: false,
    ...partial,
  };
  const cooldownKey =
    partial.cooldownKey ??
    (merged.advisory === true
      ? `advisory:${merged.backend}`
      : `${merged.backend}|${merged.provider}|${merged.model ?? ""}`);
  return { ...merged, cooldownKey };
}

function okOutcome(text = "success"): NormalizedOutcome {
  return { ok: true, errors: [], text, elapsedSec: 0.1 };
}

function failOutcome(
  category: ErrorCategory,
  provenance: Provenance,
  message = "x",
): NormalizedOutcome {
  return {
    ok: false,
    errors: [{ category, provenance, message }],
    text: "partial",
    elapsedSec: 0.2,
  };
}

class FakeBackend implements Backend {
  readonly name: BackendName;
  runCount = 0;
  private readonly outcomes: NormalizedOutcome[];

  constructor(name: BackendName, outcomes: NormalizedOutcome[]) {
    this.name = name;
    this.outcomes = [...outcomes];
  }

  provider(_entry: Entry): string {
    return "prov";
  }

  capabilities(_entry: Entry): Set<Capability> {
    return new Set();
  }

  async detect(): Promise<DetectResult> {
    return { installed: true };
  }

  async run(_req: RunRequest): Promise<NormalizedOutcome> {
    this.runCount += 1;
    const next = this.outcomes.shift();
    if (!next) throw new Error(`FakeBackend ${this.name}: unexpected extra run()`);
    return next;
  }
}

const CLEAN_FP: Fingerprint = { gitTracked: true, reliable: true, value: "clean" };

class FakeFingerprint implements FingerprintApi {
  computeCount = 0;
  settleCount = 0;
  equalCount = 0;

  constructor(
    private readonly impl: {
      compute?: () => Fingerprint;
      settle?: () => { settled: boolean; fingerprint: Fingerprint };
      equal?: (a: Fingerprint, b: Fingerprint) => boolean;
    } = {},
  ) {}

  async compute(_cwd: string): Promise<Fingerprint> {
    this.computeCount += 1;
    return this.impl.compute?.() ?? CLEAN_FP;
  }

  async settle(
    _cwd: string,
    _opts: { stabilityMs: number; maxWaitMs: number },
  ): Promise<{ settled: boolean; fingerprint: Fingerprint }> {
    this.settleCount += 1;
    return (
      this.impl.settle?.() ?? {
        settled: true,
        fingerprint: CLEAN_FP,
      }
    );
  }

  equal(a: Fingerprint, b: Fingerprint): boolean {
    this.equalCount += 1;
    if (this.impl.equal) return this.impl.equal(a, b);
    return (
      a.reliable &&
      b.reliable &&
      a.gitTracked === b.gitTracked &&
      a.value === b.value
    );
  }
}

function makeDeps(opts: {
  backends: Partial<Record<BackendName, FakeBackend>>;
  fingerprint?: FakeFingerprint;
  cooldowns?: CooldownRegistry;
  tuning?: Partial<FallbackTuning>;
  allowCrossProviderFallback?: boolean;
  now?: number;
}): FallbackDeps & { fingerprint: FakeFingerprint; cooldowns: CooldownRegistry } {
  const fingerprint = opts.fingerprint ?? new FakeFingerprint();
  const cooldowns = opts.cooldowns ?? new CooldownRegistry();
  const backends = opts.backends;
  return {
    getBackend(name: BackendName): Backend {
      const backend = backends[name];
      if (!backend) throw new Error(`no fake backend for ${name}`);
      return backend;
    },
    cooldowns,
    now: () => opts.now ?? FIXED_NOW,
    fingerprint,
    tuning: defaultTuning(opts.tuning),
    allowCrossProviderFallback: opts.allowCrossProviderFallback ?? false,
  };
}

async function run(
  entries: ResolvedEntry[],
  deps: FallbackDeps,
  deadlineTotalSec = 900,
): Promise<Awaited<ReturnType<typeof runChain>>> {
  return runChain(
    {
      entries,
      prompt: "do the thing",
      cwd: "/tmp/fake-cwd",
      deadline: createDeadline(deadlineTotalSec, FIXED_NOW),
      signal: new AbortController().signal,
    },
    deps,
  );
}

describe("runChain eligibility matrix", () => {
  it("1. first entry ok -> servedBy entry1, second never runs", async () => {
    const b1 = new FakeBackend("opencode", [okOutcome("done")]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    const entry2 = makeEntry({ name: "heavy", backend: "grok", provider: "xai", model: "xai/m" });
    const deps = makeDeps({ backends: { opencode: b1, grok: b2 } });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(true);
    expect(result.servedBy?.name).toBe("standard");
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "ok",
      editedTree: false,
    });
    expect(b1.runCount).toBe(1);
    expect(b2.runCount).toBe(0);
  });

  it("1b. success MEASURES editedTree=true when the backend changed the tree (no settle)", async () => {
    const b1 = new FakeBackend("opencode", [okOutcome("did work")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    // before compute() = clean, after compute() = dirty → equal() false → editedTree true.
    const values = ["clean", "dirty"];
    const fp = new FakeFingerprint({
      compute: () => ({ gitTracked: true, reliable: true, value: values.shift() ?? "dirty" }),
    });
    const deps = makeDeps({ backends: { opencode: b1 }, fingerprint: fp });

    const result = await run([entry1], deps);

    expect(result.ok).toBe(true);
    expect(result.trace[0]).toMatchObject({ entry: "standard", reason: "ok", editedTree: true });
    expect(fp.settleCount).toBe(0); // success path never settles
    expect(fp.computeCount).toBe(2); // before + after snapshot
  });

  it("1c. success reports editedTree unknown (undefined) on a non-git cwd", async () => {
    const b1 = new FakeBackend("opencode", [okOutcome("did work")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    const fp = new FakeFingerprint({ compute: () => ({ gitTracked: false, reliable: true, value: "" }) });
    const deps = makeDeps({ backends: { opencode: b1 }, fingerprint: fp });

    const result = await run([entry1], deps);

    expect(result.ok).toBe(true);
    expect(result.trace[0].editedTree).toBeUndefined();
    expect(fp.computeCount).toBe(1); // no after-snapshot when the before is unmeasurable
  });

  it("2. spawn/transport failure falls back only through fingerprint gate (settle called, clean tree)", async () => {
    const b1 = new FakeBackend("opencode", [
      failOutcome("transport", "spawn", "x"),
    ]);
    const b2 = new FakeBackend("grok", [okOutcome("from-2")]);
    // Same provider so the cross-provider gate is not under test here.
    const entry1 = makeEntry({ name: "standard", backend: "opencode", provider: "prov" });
    const entry2 = makeEntry({
      name: "heavy",
      backend: "grok",
      provider: "prov",
      model: "prov/m",
    });
    // Spawn is no longer a fingerprint bypass: gate requires git-tracked +
    // settled + byte-identical before/after + capacity/auth/transport.
    const fp = new FakeFingerprint({
      compute: () => ({ gitTracked: true, reliable: true, value: "clean" }),
      settle: () => ({
        settled: true,
        fingerprint: { gitTracked: true, reliable: true, value: "clean" },
      }),
      equal: () => true,
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(true);
    expect(result.servedBy?.name).toBe("heavy");
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "not-installed",
      provenance: "spawn",
      editedTree: false,
    });
    expect(result.trace[1]).toMatchObject({ entry: "heavy", reason: "ok" });
    expect(fp.settleCount).toBe(1);
    expect(b1.runCount).toBe(1);
    expect(b2.runCount).toBe(1);
  });

  it("forged spawn provenance after a tree edit is TERMINAL (no fallback)", async () => {
    // A crafted task can edit the tree then emit "command not found" to forge
    // spawn provenance. That signal must NOT bypass the data-loss gate.
    const b1 = new FakeBackend("opencode", [
      failOutcome("transport", "spawn", "command not found: grok"),
    ]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode", provider: "prov" });
    const entry2 = makeEntry({
      name: "heavy",
      backend: "grok",
      provider: "prov",
      model: "prov/m",
    });
    const fp = new FakeFingerprint({
      compute: () => ({ gitTracked: true, reliable: true, value: "before" }),
      settle: () => ({
        settled: true,
        fingerprint: { gitTracked: true, reliable: true, value: "after-edit" },
      }),
      equal: () => false, // tree changed → editedTree
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(false);
    expect(result.servedBy).toBeUndefined();
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      editedTree: true,
    });
    expect(fp.settleCount).toBe(1);
    expect(b1.runCount).toBe(1);
    expect(b2.runCount).toBe(0);
  });

  it("spawn/transport on a NON-GIT cwd is terminal", async () => {
    const b1 = new FakeBackend("opencode", [
      failOutcome("transport", "spawn", "command not found: grok"),
    ]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode", provider: "prov" });
    const entry2 = makeEntry({
      name: "heavy",
      backend: "grok",
      provider: "prov",
      model: "prov/m",
    });
    const fp = new FakeFingerprint({
      compute: () => ({ gitTracked: false, reliable: true, value: "" }),
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(false);
    expect(result.servedBy).toBeUndefined();
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "not-installed",
      provenance: "spawn",
      editedTree: false,
    });
    expect(fp.settleCount).toBe(0);
    expect(b1.runCount).toBe(1);
    expect(b2.runCount).toBe(0);
  });

  it("3. capacity + clean settled tree falls back; entry1 enters cooldown", async () => {
    const b1 = new FakeBackend("opencode", [failOutcome("capacity", "stream")]);
    const b2 = new FakeBackend("grok", [okOutcome("from-2")]);
    // Same provider so the cross-provider gate is not under test here.
    const entry1 = makeEntry({ name: "standard", backend: "opencode", provider: "prov" });
    const entry2 = makeEntry({
      name: "heavy",
      backend: "grok",
      provider: "prov",
      model: "prov/m",
    });
    const fp = new FakeFingerprint({
      equal: () => true,
      settle: () => ({ settled: true, fingerprint: { gitTracked: true, reliable: true, value: "clean" } }),
    });
    const cooldowns = new CooldownRegistry();
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
      cooldowns,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(true);
    expect(result.servedBy?.name).toBe("heavy");
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "unavailable",
      editedTree: false,
    });
    expect(fp.settleCount).toBe(1);
    // Cooldown is keyed by content identity, not the tier slot name.
    expect(cooldowns.isCooling(entry1.cooldownKey, FIXED_NOW)).toBe(true);
    expect(cooldowns.isCooling("standard", FIXED_NOW)).toBe(false);
    expect(b2.runCount).toBe(1);
  });

  it("4. capacity + fingerprint.equal false (tree changed) is terminal", async () => {
    const b1 = new FakeBackend("opencode", [failOutcome("capacity", "stream")]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    const entry2 = makeEntry({ name: "heavy", backend: "grok", provider: "xai", model: "xai/m" });
    const fp = new FakeFingerprint({
      equal: () => false,
      settle: () => ({
        settled: true,
        fingerprint: { gitTracked: true, reliable: true, value: "dirty" },
      }),
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(false);
    expect(result.servedBy).toBeUndefined();
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "unavailable",
      editedTree: true,
    });
    expect(b1.runCount).toBe(1);
    expect(b2.runCount).toBe(0);
  });

  it("5. capacity + settle settled:false is terminal with editedTree true", async () => {
    const b1 = new FakeBackend("opencode", [failOutcome("capacity", "stream")]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    const entry2 = makeEntry({ name: "heavy", backend: "grok", provider: "xai", model: "xai/m" });
    const fp = new FakeFingerprint({
      settle: () => ({
        settled: false,
        fingerprint: { gitTracked: true, reliable: true, value: "moving" },
      }),
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(false);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      editedTree: true,
      reason: "unavailable",
    });
    expect(b2.runCount).toBe(0);
  });

  it("6. timeout with clean tree is terminal (not fallback-worthy)", async () => {
    const b1 = new FakeBackend("opencode", [failOutcome("timeout", "timeout")]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    const entry2 = makeEntry({ name: "heavy", backend: "grok", provider: "xai", model: "xai/m" });
    const fp = new FakeFingerprint({
      equal: () => true,
      settle: () => ({ settled: true, fingerprint: { gitTracked: true, reliable: true, value: "clean" } }),
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(false);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "timeout",
      editedTree: false,
    });
    expect(b2.runCount).toBe(0);
  });

  it("7. empty category is terminal", async () => {
    const b1 = new FakeBackend("opencode", [failOutcome("empty", "exit")]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    const entry2 = makeEntry({ name: "heavy", backend: "grok", provider: "xai", model: "xai/m" });
    const fp = new FakeFingerprint({
      equal: () => true,
      settle: () => ({ settled: true, fingerprint: { gitTracked: true, reliable: true, value: "clean" } }),
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(false);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "empty",
    });
    expect(b2.runCount).toBe(0);
  });

  it("8. non-git cwd + capacity is terminal (cannot certify clean)", async () => {
    const b1 = new FakeBackend("opencode", [failOutcome("capacity", "stream")]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    const entry2 = makeEntry({ name: "heavy", backend: "grok", provider: "xai", model: "xai/m" });
    const fp = new FakeFingerprint({
      compute: () => ({ gitTracked: false, reliable: true, value: "" }),
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(false);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "unavailable",
      editedTree: false,
    });
    expect(fp.settleCount).toBe(0);
    expect(b2.runCount).toBe(0);
  });

  it("9. cross-provider blocked when allowCrossProviderFallback=false", async () => {
    const b1 = new FakeBackend("opencode", [failOutcome("capacity", "stream")]);
    const b2 = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({
      name: "standard",
      backend: "opencode",
      provider: "A",
      model: "A/m1",
    });
    const entry2 = makeEntry({
      name: "heavy",
      backend: "grok",
      provider: "B",
      model: "B/m2",
    });
    const fp = new FakeFingerprint({
      equal: () => true,
      settle: () => ({ settled: true, fingerprint: { gitTracked: true, reliable: true, value: "clean" } }),
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
      allowCrossProviderFallback: false,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(false);
    expect(result.servedBy).toBeUndefined();
    expect(result.crossProviderNotice).toMatch(/blocked/i);
    expect(result.crossProviderNotice).toContain("A");
    expect(result.crossProviderNotice).toContain("B");
    expect(result.trace).toHaveLength(1);
    expect(b1.runCount).toBe(1);
    expect(b2.runCount).toBe(0);
  });

  it("10. cross-provider allowed when allowCrossProviderFallback=true", async () => {
    const b1 = new FakeBackend("opencode", [failOutcome("capacity", "stream")]);
    const b2 = new FakeBackend("grok", [okOutcome("from-B")]);
    const entry1 = makeEntry({
      name: "standard",
      backend: "opencode",
      provider: "A",
      model: "A/m1",
    });
    const entry2 = makeEntry({
      name: "heavy",
      backend: "grok",
      provider: "B",
      model: "B/m2",
    });
    const fp = new FakeFingerprint({
      equal: () => true,
      settle: () => ({ settled: true, fingerprint: { gitTracked: true, reliable: true, value: "clean" } }),
    });
    const deps = makeDeps({
      backends: { opencode: b1, grok: b2 },
      fingerprint: fp,
      allowCrossProviderFallback: true,
    });

    const result = await run([entry1, entry2], deps);

    expect(result.ok).toBe(true);
    expect(result.servedBy?.name).toBe("heavy");
    expect(result.crossProviderNotice).toMatch(/fell back across providers/i);
    expect(result.crossProviderNotice).toContain("A");
    expect(result.crossProviderNotice).toContain("B");
    expect(b2.runCount).toBe(1);
  });

  it("11. advisory entry returns ok with Advisory text without running backend", async () => {
    const b1 = new FakeBackend("codex", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({
      name: "heavy",
      backend: "codex",
      provider: "openai",
      model: undefined,
      advisory: true,
    });
    const deps = makeDeps({ backends: { codex: b1 } });

    const result = await run([entry1], deps);

    expect(result.ok).toBe(true);
    expect(result.servedBy?.name).toBe("heavy");
    expect(result.text).toMatch(/Advisory/i);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({ entry: "heavy", reason: "ok", editedTree: false });
    expect(b1.runCount).toBe(0);
  });

  it("12. deadline exhausted below backendMin: timeout reason, run never called", async () => {
    const b1 = new FakeBackend("opencode", [okOutcome("should-not-run")]);
    const entry1 = makeEntry({ name: "standard", backend: "opencode" });
    // remainingSec=5, cleanup=5, no next -> floor(0)=0 < backendMinSec=10 -> null
    const deps = makeDeps({
      backends: { opencode: b1 },
      tuning: { backendMinSec: 10, cleanupReserveSec: 5, minViableNextSec: 20 },
    });

    const result = await run([entry1], deps, /* deadlineTotalSec */ 5);

    expect(result.ok).toBe(false);
    expect(result.servedBy).toBeUndefined();
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      entry: "standard",
      reason: "timeout",
      provenance: "timeout",
      editedTree: false,
    });
    expect(b1.runCount).toBe(0);
  });

  it("13. cross-provider gate continues (skips) blocked candidate; later same-provider still runs", async () => {
    // A (provider X, fails eligibly) → B (provider Y, must be SKIPPED) →
    // C (provider X again, must RUN). With allowCrossProviderFallback=false,
    // continue (not break) after the blocked hop is what keeps C reachable.
    const bOpen = new FakeBackend("opencode", [
      failOutcome("capacity", "stream"),
      okOutcome("from-C"),
    ]);
    const bGrok = new FakeBackend("grok", [okOutcome("should-not-run")]);
    const entryA = makeEntry({
      name: "light",
      backend: "opencode",
      provider: "X",
      model: "X/m1",
    });
    const entryB = makeEntry({
      name: "standard",
      backend: "grok",
      provider: "Y",
      model: "Y/m2",
    });
    const entryC = makeEntry({
      name: "heavy",
      backend: "opencode",
      provider: "X",
      model: "X/m3",
    });
    const fp = new FakeFingerprint({
      equal: () => true,
      settle: () => ({
        settled: true,
        fingerprint: { gitTracked: true, reliable: true, value: "clean" },
      }),
    });
    const deps = makeDeps({
      backends: { opencode: bOpen, grok: bGrok },
      fingerprint: fp,
      allowCrossProviderFallback: false,
    });

    const result = await run([entryA, entryB, entryC], deps);

    expect(result.ok).toBe(true);
    expect(result.servedBy?.name).toBe("heavy");
    expect(result.servedBy?.model).toBe("X/m3");
    expect(result.crossProviderNotice).toMatch(/blocked/i);
    expect(result.crossProviderNotice).toContain("X");
    expect(result.crossProviderNotice).toContain("Y");
    // A ran and failed; B was skipped (cross-provider); C ran and succeeded.
    expect(bOpen.runCount).toBe(2);
    expect(bGrok.runCount).toBe(0);
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0]).toMatchObject({
      entry: "light",
      reason: "unavailable",
      editedTree: false,
    });
    expect(result.trace[1]).toMatchObject({ entry: "heavy", reason: "ok" });
  });
});

