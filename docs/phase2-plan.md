# Phase 2 plan — `mcp-router` (tier/capability dispatch + graceful fallback)

*Draft 2026-07-12. Reframed 2026-07-13 to fold in the tier + capability routing
model (see "Routing model" below). Builds on the merged Phase 1 core. The
fallback/safety half implements the twice-reviewed design in
`docs/routing-research.md` (LOCKED PLAN). NOT YET adversarially reviewed at the
implementation-plan level — that pass comes next.*

## Build gate (unresolved — read before implementing)

`routing-research.md` gates this package on demonstrated demand (≥ real users
wanting autonomous routing) **and** each wrapper surviving one upstream CLI
version bump. As of 2026-07-13 npm shows publish-spike-only downloads
(mcp-opencode 172, mcp-grok 128, no organic tail) and both wrappers are days
old. **Neither gate is met.** Proceeding is an explicit owner decision to build
ahead of demand; this section stays here so that decision is never implicit.

## Scope (v1)

A new published MCP server `mcp-router`. The calling model (Claude) delegates a
coding sub-task by naming a **tier** (`light` / `standard` / `heavy`) and any
required **capabilities** (`vision`); the router dispatches to the model the
**user** mapped into that tier slot. If a dispatch fails, the router falls back
to the next entry **only when doing so is provably safe**. The calling model
routes by intent (it has full task context); the router owns the mapping,
capability filtering, and reliability (fallback, cooldowns, safety gate). No
quota ledger, no effort-enum tool, no LLM-side model *invention*, no
working-tree restore.

## Setup-agnostic (published OSS) — hard requirement

This ships as an open-source package for arbitrary users. **Nothing about the
author's environment is baked in:** no backend, provider, model, or filesystem
path is hardcoded in code or in defaults. The tier/capability *vocabulary* is
product-owned and fixed (that is the routing contract); every *mapping* is 100%
user-supplied via config. Docs/README use `<placeholder>` model strings, never a
real author model. Zero-config auto-detect probes whatever CLIs the user actually
has installed and synthesizes single-entry tiers from those — it never assumes a
specific provider or model. The supported backend *integrations* (opencode, grok,
codex) are an extensible product feature, not a user-specific assumption. Any
delegated implementer that hardcodes a model id, provider, key, or home path is
wrong and must be corrected in review.

## Routing model — tiers + capabilities (locked 2026-07-13)

Derived from a 2-researcher market analysis + adversarial synthesis. The market
gave a rich superset; v1 deliberately takes almost none of it. **The discipline
is subtraction.**

### Tiers (the routing axis — caller picks exactly one)

`light` / `standard` / `heavy`. A **fixed** vocabulary the product owns; users
only choose *which model fills each slot*, never the names.

- `light` — fast/cheap, mechanical or narrow-scope work.
- `standard` — default; moderate-complexity implementation.
- `heavy` — frontier reasoning; ambiguous, high-stakes, or cross-cutting work.

Rationale: the Triage paper (arXiv 2604.07494), which routes SWE subtasks to
fixed model tiers — the closest academic precedent to this exact problem — lands
on `light/standard/heavy`. Every vendor family also ships exactly three tiers
(haiku/sonnet/opus, nano/mini/full, flash-lite/flash/pro). Three is the
convergence point. Names describe **intent, not model size**, so an unusual
user mapping (a strong model parked in a low slot) is not systematically
mis-routed the way `small/medium/large` would be.

### Capability tags (hard filters — optional, default none)

**v1 ships exactly one: `vision`.** Objective, discrete, discriminating (some
models have it, some don't), and it is the canonical user trigger ("there's an
image → needs vision"). It is a *hard* filter: a tier whose model lacks a
required capability is skipped for that call in favor of a slot that satisfies
it.

Considered and **cut** for v1 (market-real, but not a routing gate *here*):

- `tool-use` — universal across coding backends; a filter that never excludes
  anything is noise. Assume-true, not a tag.
- `reasoning` — redundant with the `heavy` tier; do not double-encode.
- `code-execution` / `web-search` — provided by the *backend* (opencode/grok
  shell tools), not a property of the model being routed to.
- `structured-output` / `prompt-caching` — not a gate for "delegate a task, get
  edited files + text back."
- `long-context` — a *number*, not a boolean; defer as a numeric threshold hint
  if big-repo routing ever needs it.

Canonical term choices (from the analysis, for when tags are added): `vision`
(not "multimodal"/"image-input"), `tool-use` (not "function-calling"),
`reasoning` (not "extended-thinking"), `structured-output`, `web-search` (not
"grounding").

### Task-type is NOT a configured axis

`plan/implement/debug/review/explore` was evaluated and **rejected as a routing
dimension.** It is (a) largely redundant with tier for *model* choice (plan→heavy,
implement→standard, explore→light), and (b) the non-redundant part is
**agent-mode**, which the backend already owns (opencode's `agent: build|plan`).
Making it a slot axis would create a 3×5 grid users with 3 models cannot fill —
the sprawl that collapses routing accuracy. Expressed instead via the chosen
tier plus an optional `agentMode` pass-through to backends that support it.

### Guardrails (bake in)

1. **System-prompt line:** a tier denotes the user's *declared intent for the
   slot*, not the model's inherent strength — so an odd mapping is not mis-routed.
2. **Tier and effort never share words.** Tiers are `light/standard/heavy`; any
   `reasoning_effort` forwarded to a backend uses `low/medium/high`. Sharing
   `high` would make the caller conflate "pick the strong slot" with "make this
   call think harder" — two different knobs.

## Package

`packages/mcp-router`, published as `mcp-router`. Thin MCP shell + router logic;
bundles `@mcp-coding-agents/core` via tsup (same as the other two products).
Runtime deps: `@modelcontextprotocol/sdk`, `zod`. core is a devDependency,
bundled in. Preserve the shebang; 4-file tarball.

## Backend abstraction

```
interface Backend {
  name: 'opencode' | 'grok';                 // extensible: codex, gemini later
  provider(entry): string;                   // e.g. 'anthropic', 'xai' — for cross-provider gate
  capabilities(entry): Set<Capability>;      // e.g. {'vision'} — declared in config, provider-verified
  detect(): Promise<{ installed: boolean; version?: string }>;  // bounded exec, no network
  run(opts): Promise<NormalizedOutcome>;     // wraps core runOpencode / runGrok
}
interface NormalizedOutcome {
  ok: boolean;
  errors: StructuredError[];                 // from core classifyOpencode / classifyGrok
  text: string;
  sessionId?: string;
  elapsedSec: number;
  // NOTE: no `startedExecution` in the decision. Core can't reliably signal it
  // (parsers discard tool events). Eligibility uses `provenance:"spawn"` +
  // the fingerprint gate only. Any "started" proxy is trace-annotation at most.
}
```

Adapters live in `backends/opencode.ts` / `backends/grok.ts`, each importing the
core runner + classifier. The router never re-implements spawn/parse/redact.

Note (open, from review): **codex is reached as its own MCP, not a CLI the router
spawns.** v1 treats a codex-backed tier as *advisory* — the router returns "use
your codex MCP for this tier" rather than spawning it. Router-as-MCP-client is
deferred.

## Fallback eligibility (the safety core)

**REVISED per implementation review — the eligibility is AND-gated, not OR.**
Core emits no reliable "a tool ran" / "started execution" signal (the parsers
discard `step_start`/`tool_use` events), and mid-run auth is indistinguishable
from launch-time auth. So `startedExecution` is NOT a trustworthy independent
trigger and is used only as a trace annotation, never in the decision.

Fallback order: capability-filter the tiers → dispatch chosen tier → on failure,
try the next capability-satisfying entry, subject to the gate below. For each
attempt: fingerprint the cwd → run backend → on failure, decide:

- **Fall back to the next entry IFF EITHER:**
  1. **`provenance:"spawn"`** — the child process never existed (ENOENT / launch
     failure). This is the *only* provably-nothing-ran signal, and it is reliably
     derivable from core. No fingerprint needed (nothing could have run).
  2. **Fingerprint byte-identical** (`F_after === F_before`) AND the category is
     fallback-worthy (`capacity` / `auth` / `transport`). The fingerprint match
     is a **necessary condition** for every post-spawn fallback — including
     launch-time auth, which still falls back because a clean tree proves nothing
     was written.
- **TERMINAL (return to caller, never fall back):** `timeout`, `empty-result`,
  `task` failure, and **any failure where the fingerprint changed** (partial
  edits — the F5 data-loss blocker). Grok `capacity` is `provenance:inferred` →
  same rule; it can only fall back when the tree is provably clean, never on the
  text match alone.

### Fingerprint (detect-and-refuse, NO restore)

**REVISED per review — must capture history moves and content-hash untracked.**
git cwd, `F =` combination of:
- `hash(git status --porcelain=v1 -z)`
- content hash of tracked changes: `git diff` + `git diff --cached` (or the
  staged tree oid via `git write-tree`)
- **`git rev-parse HEAD`, the current branch ref, and `ORIG_HEAD`** — so a
  backend that `commit`/`amend`/`reset`s (grok runs `--always-approve` by
  default) is caught even though `status` is then clean
- **content hash** (not just path/size/mtime) of untracked non-ignored files —
  an in-place same-size rewrite must not read as unchanged

Clean iff `F_after === F_before`. **Sample `F_after` only after the backend's
detached process group is provably reaped** (poll `kill(-pgid, 0)` until ESRCH,
bounded) — core's killer resolves on a 5s timer, not on confirmed death, so a
naive immediate sample races an orphaned writer (review BLOCKER 2). **Reap-poll
timeout → TERMINAL** (a surviving writer past the bound may still mutate; never
fall back). Restore is explicitly NOT attempted. **Hard scope limit
(documented): the gate is cwd-scoped only** — an agent's bash tool can write
outside cwd (`$HOME`, sibling repos, git config); "cwd tree unchanged" does not
prove "machine unchanged". Non-git cwd: cannot fingerprint cheaply → after spawn
succeeds, any failure is terminal (conservative).

## Timeout / deadline

**REVISED per review.** One total `timeoutSec` (default 900) shared across
attempts so a chain fits a client's single tool-call tolerance. The deadline `D`
starts **at dequeue** (not at call receipt); `CwdQueue` wait is bounded
separately, and a call that waited past its budget returns "budget exhausted,
nothing attempted" rather than silently overrunning the client's clock.

- **Protect attempt 2:** when a next entry exists, soft-cap attempt 1 at
  `D − minViableNext − reserve` so a slow first attempt can't starve the whole
  chain. (Honest consequence, surfaced below: fallback is meaningful mainly for
  *fast, clean* failures.)
- Each attempt gets `Math.floor(remaining(D) − cleanupReserve)`; **do not start**
  an attempt whose budget `< backendMin` (grok floor 30s) `+ reserve`.
  `cleanupReserve` must cover the process-group reap wait (fingerprint F2).
- `runGrok`'s `validateTimeoutSec` throws on non-integers — adapters must
  `Math.floor` and floor-enforce before calling (review MAJOR 5).
- Client abort is terminal. Progress: `attempt n/N · <tier>:<entry> · <remaining>s`.

### What fallback actually delivers (honest framing)

The fingerprint gate + shared deadline converge: the router falls back **only
when little or no work happened** — a backend that isn't installed, is
rate-limited/overloaded immediately, or fails auth at launch (all clean-tree,
fast). A task that ran for minutes and then failed either edited the tree
(terminal) or exhausted the budget (terminal). So the fallback half is **"graceful
fallback on fast/clean failure,"** not a mid-task rescue. Fallback is also
**directional**: grok's `--always-approve` rarely leaves a clean tree on failure,
so `standard→grok` fallback is practically live but `grok→…` almost never fires.
The README and tool description must say all of this plainly.

## Config (authorization boundary)

`~/.config/mcp-router/config.json`, mode **0600** (refuse if world/group
readable). Schema (zod-validated):

```jsonc
{
  "tiers": {                                   // fixed slot names; user fills the model
    "light":    null,                          // unconfigured → falls back per `fallbacks`
    "standard": { "backend": "opencode", "provider": "<provider>", "model": "<provider>/<model>" },
    "heavy":    { "backend": "codex", "advisory": true }   // codex = advisory (its own MCP)
  },
  "capabilities": {                            // capability → slot that satisfies it
    "vision": { "backend": "opencode", "provider": "<provider>", "model": "<provider>/<vision-model>" }
  },
  "fallbacks": { "light": "standard", "heavy": "standard" },
  "allowCrossProviderFallback": false          // cross-provider fallback requires explicit opt-in
}
// EXAMPLE ONLY — all ids are placeholders. Nothing here is a default; users
// supply their own backend/provider/model per slot.
```

- The caller names a **tier** (+ optional `caps`) — never a raw model. It can
  never introduce a backend/provider/model the config didn't authorize.
- **Provider is derived, not trusted (review MAJOR 4):** for opencode, provider
  is `model.split("/")[0]`; reject any entry whose declared `provider` disagrees.
  grok is always `xai`. **Aggregator caveat (new):** `openrouter/…` and
  `github-copilot/…` prefixes hide the true downstream provider, so treat known
  aggregator prefixes as always-cross-provider for the egress gate.
- Cross-provider transition (a capability fallback or tier fallback that changes
  provider) is rejected unless `allowCrossProviderFallback` is true — fallback
  silently ships prompt + repo content to a second provider (user's explicit
  call). The gate runs on the **post-resolution** entry sequence.
- `MCP_ROUTER_ROOTS` (colon-list, default `$HOME/Projects`) → `validateCwd` from
  core, before any spawn.
- **0600 check hardening (review MINOR 7):** open→`fstat` the fd (not stat→open,
  TOCTOU), require owner uid == current uid, reject symlinks, reject a
  group/world-writable parent dir. Mode alone is insufficient.
- **No config?** auto-detect: probe installed CLIs (`detect()`, no network),
  synthesize single-entry tiers (never cross-provider by default). Zero-config
  first run works but is **`dry_run`/single-tier only** until a config exists —
  installing a CLI is not consent to run it auto-approve across `$HOME/Projects`
  (review: auto-approve blast-radius, research F7).

## Cooldowns

Per **named entry** (not per backend), bounded in-memory TTL: capacity 10m, auth
30m, transport 5m (then re-probe). Never "until restart". Skipped/cooling entries
are surfaced in results and `router_dry_run` **without the category** — the
caller sees "unavailable, retry in Ns", not "auth vs capacity" (the latter leaks
live per-provider credential health — review MINOR 7). **Consistency fix:** the
`route` attempt trace must therefore ALSO omit raw `category` for the same reason
(surface a coarse `reason` instead) — the previous draft leaked in the trace what
cooldowns hid.

## Tools

- `route(prompt, cwd, tier, caps?, timeoutSec?)` → capability-filters, dispatches
  the tier (with fallback). Returns: **served-by** (tier, entry, backend,
  provider/model), **attempt trace** `[{entry, reason, provenance, elapsedSec,
  editedTree}]` (coarse `reason`, no raw category — see Cooldowns), an explicit
  cross-provider notice if a fallback crossed providers, then the assistant text.
  All redacted via core.
- `list_tiers(cwd?)` → the discovery tool: returns the configured tiers, which
  are filled vs unconfigured, each entry's capabilities, and cooling/skipped
  state (no category). Lets the caller route without ever firing into an empty
  slot. `detect()` cached with a short TTL so repeated calls can't spin spawns.
- `router_dry_run(cwd, tier?, caps?)` → resolve cwd + effective entry sequence,
  list exact recipients (backend/provider/model) in order, authorization
  decisions, budget split, cooling entries — **without sending the prompt or
  probing providers**. The safety previewer.
- **`router_status()` — DROPPED from v1** (review MINOR 8): `list_tiers` +
  `dry_run` subsume it; a standalone status tool is pure recon surface.
- **`router_reply` — CUT from v1.** Sessions are non-transferable and never fall
  back, so a reply belongs to one backend — use that backend's own MCP server
  with its session id. Revisit on demand.

## Modules

`index.ts` (MCP shell + zod schemas), `config.ts` (load/validate/authorize),
`tiers.ts` (tier resolution + capability filtering + fallback ordering),
`fallback.ts` (attempt loop + eligibility), `fingerprint.ts` (git
detect-and-refuse), `cooldown.ts`, `deadline.ts`, `backends/{opencode,grok}.ts`,
`report.ts` (served-by + trace formatting).

## Tests

- **Adapter-over-real-fixtures (review MAJOR 6 — highest-risk unit):** the
  `RunOutcome → NormalizedOutcome` translation is where the dangerous decision is
  born. Table-driven tests over real captured core outcomes (phase0
  `streaming-json.jsonl` etc.) assert category/provenance and the eligibility
  decision for: spawn-ENOENT, mid-run-auth-after-edit, 429-after-session,
  timeout, empty-result.
- **Tier + capability resolution:** capability filter selects the vision slot when
  `caps:["vision"]` and the tier's model lacks it; unconfigured tier falls back
  per `fallbacks`; caller cannot name a model outside config; tier-name never
  leaks model-strength assumptions into the decision.
- Fake `Backend` impls drive: per-call authorization rejection (unauthorized
  cross-provider / aggregator-prefix egress), the fallback loop per category
  (spawn → fall back; fingerprint-changed → terminal; timeout/empty → terminal;
  grok-inferred-capacity → only when tree clean), cooldown set/skip/expire (no
  category leak in cooldown OR trace), deadline floor + attempt-2 soft-cap.
- **Real-subprocess race test (review BLOCKER 2 — the safety claim):** spawn a
  detached writer that outlives its parent; assert `F_after` sampling waits for
  ESRCH and that a reap-poll timeout is treated as TERMINAL. A fake Backend
  cannot exercise this; without it the core safety claim is unverified.
- Real temp-git-repo tests for `fingerprint.ts`: clean; modified-tracked; staged;
  new-untracked; **untracked in-place same-size rewrite**; ignored-file-edit;
  **git commit / amend / reset (clean status, moved HEAD)**; non-git cwd terminal.
- No live CLI calls. `npm test` green; `npm pack --dry-run` 4 files; MCP
  handshake smoke.

## Explicitly out of scope (v1)

Quota ledger; effort-enum `delegate()`; task-type routing axis; LLM-side model
invention; router-as-MCP-client (codex is advisory); cross-CLI working-tree
restore; `router_reply`; `long-context`/non-`vision` capability tags;
observability beyond list_tiers/dry_run/trace.
