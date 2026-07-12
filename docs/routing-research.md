# Autonomous task routing across agent backends — research & proposal

*2026-07-11. Market research (2 Sonnet researchers) + adversarial Opus PE/PM review. Not committed; internal working doc.*

## Question

How should frontier models (Claude, Codex, Grok) autonomously route coding tasks
to our MCP-wrapped agent backends (mcp-opencode, mcp-grok) based on effort,
reasoning need, and usage limits? Feeds the decision: build an `mcp-router`
package vs. sharpen what exists.

## Recommendation (post-adversarial)

1. **Now — ship "disambiguation," not "routing":** rewrite `opencode_run` /
   `grok_run` tool descriptions per Anthropic guidance (explicit *when to use /
   when not*, negative guidance, worked criteria). Companion: a **CLAUDE.md
   routing rubric** — the highest-ROI option; it gives the frontier model
   explicit routing criteria *while preserving its full task context*.
2. **Gate everything else on demand:** no third package until the two wrappers
   have real users who demonstrably want autonomous routing (vs. picking
   manually) and both wrappers survive at least one upstream CLI version bump.
3. **If routing infra is ever built,** it is *not* a `delegate(task, effort)`
   tool. Surviving form: deterministic shared failover/cooldown state consulted
   by the existing tools; MCP **sampling** (server asks the client model to
   classify with full context) instead of a self-reported effort enum; no
   cross-backend escalation without git checkpoint/reset + human ack; no quota
   ledger for cost-blind backends (Grok emits no cost events).

## Key research findings

### Products (Agent A)
- **Industry split is universal:** model-class selection = classifier/heuristic
  (NotDiamond trained router powers OpenRouter Auto; Copilot's disclosed
  complexity+availability two-system design; RouteLLM matrix factorization);
  provider/endpoint selection = always deterministic code (LiteLLM cooldowns,
  OpenRouter inverse-square price weighting). Nobody uses an LLM to pick the
  provider.
- **LiteLLM Router is the public reference design** for the code layer: 429 →
  cooldown (5s default), >50% failure-rate/min threshold, tpm/rpm pre-call
  checks, typed fallback chains, exponential backoff.
  https://docs.litellm.ai/docs/routing
- **Factory Router** is the only product shipping mid-session
  escalate-on-failure (within one agent's session — not across CLIs).
  https://docs.factory.ai/web/factory-router
- **Confirmed absent in market:** (1) quota-aware routing across agent
  *subscriptions* (all six agent platforms manual-only on limits; Claude Code
  documents it as manual); (2) any routing layer in MCP agent-wrappers —
  existing multi-CLI bridges (agent-multicli, ai-cli-mcp) expose N tools and
  punt to the calling LLM.
- Session stickiness / cache-awareness matters everywhere (OpenRouter pins per
  session; Factory optimizes prompt-cache retention).

### Papers (Agent B)
- No zero-shot difficulty classifier exists: RouteLLM (arxiv 2406.18665),
  FrugalGPT (2305.05176), HybridLLM (2404.14618) all need preference/labeled
  data. Triage (2604.07494) is the closest analog to per-task effort tiering
  for SWE tasks (code metrics → tier, ~50-70% cost cut).
- PILOT (2508.21141): budget-constrained routing = online multi-choice knapsack
  layered over a contextual bandit — the right *shape* for quota enforcement.
- MTRouter (2604.23530): multi-turn routing with session history reduces model
  switching and cost — argues for per-session state, against per-call
  independence.

### Tool descriptions (Agent B)
- Anthropic: detailed descriptions with explicit when/when-not + negative
  guidance; consolidate near-duplicates; namespace names; set MCP annotations
  explicitly (`readOnlyHint` controls Claude Code parallel dispatch).
  https://www.anthropic.com/engineering/writing-tools-for-agents
- Tool-selection accuracy collapses with tool count (43%→2% from 4→51 tools in
  one benchmark). ~5-7 similar tools is the soft degradation threshold.
- Community consensus: description-driven auto-delegation is *unreliable*;
  explicit invocation is the only reliable trigger. Descriptions disambiguate a
  delegation the model already decided on; they don't create autonomy.

## Options considered

| # | Option | Trade-off | Verdict |
|---|---|---|---|
| 1 | Sharpen tool descriptions + CLAUDE.md rubric | Cheap, immediate; informs rather than enforces | **Do now** (scoped as disambiguation) |
| 2 | `mcp-router` with `delegate(task, effort)` | Quota/failover aware; but destroys context, ledger can't work, escalation corrupts tree | **Killed as specified** |
| 3 | Learned/bandit router (RouteLLM/PILOT-style) | Needs data we don't have | Rejected — premature |
| 4 | CLAUDE.md routing rubric only | Zero maintenance, full context preserved | Folded into #1 |
| 5 | Contribute routing to existing multi-CLI bridge | Shares maintenance; loses control | Revisit if demand appears |

## What the adversarial pass changed (findings that stuck)

- **F1 (blocker):** the "empty niche" is unproven demand, not opportunity —
  near-zero users on existing wrappers; gate any router on ≥5 real users
  showing they want autonomy.
- **F2 (blocker):** `delegate(task, effort)` is an information-destroying
  bottleneck — the frontier model has full context; a 3-value enum + code with
  less information cannot route better than the model choosing between two
  well-described tools. Failover/quota state doesn't require a single-tool
  façade.
- **F4 (blocker):** the quota ledger can't work — Grok CLI provably emits no
  cost events; Claude Max limits are opaque/non-linear; a wall-time proxy has
  no calibration anchor and drifts into harm.
- **F5 (blocker):** cross-CLI escalate-on-failure corrupts the shared working
  tree — a failed opencode run leaves partial edits; grok retrying inherits
  corruption; sessions are non-transferable. Requires git snapshot/reset +
  explicit ack, or nothing.
- **F7 (major):** routing pressure pushes users toward enabling auto-approve on
  *multiple* agents — compounding blast radius (both wrappers' documented
  security posture).
- **F8 (major):** MCP **sampling** (server asks client model to classify with
  full context) and **elicitation** (confirm backend switch) were missed —
  they're the context-preserving primitives the effort enum badly reinvents.
- **F9 (major):** Approach 1 rescoped — descriptions disambiguate, they don't
  achieve autonomous routing (our own cited evidence says so).

## Next actions

1. Rewrite `opencode_run`/`grok_run`/`*_reply` descriptions: when/when-not,
   negative guidance, worked effort criteria in prose; set MCP annotations
   (`readOnlyHint:false`, `destructiveHint:true`, `openWorldHint:true`).
2. Add a routing rubric to the user-level CLAUDE.md (mechanical → opencode w/
   Sonnet; cheap second opinion → grok; keep planning/review in-session).
3. Instrument nothing new; observe real usage. Revisit router only on
   demonstrated demand + wrapper stability across one upstream CLI bump each.

## LOCKED PLAN — mcp-router (post PE + Codex adversarial review, 2026-07-11)

Decision: build as OSS, revised scope. Both reviewers (Opus PE, Codex) killed
working-tree restore and the aspirational error taxonomy; converged on:

- **Phase 0 (gate):** empirically catalog capacity/quota/rate-limit error
  surfaces of both CLIs (fixtures). If capacity is not classifiable with high
  precision → stop; premise unsound.
- **Phase 1:** extract side-effect-free shared core (run/parse/classify/redact/
  validateCwd) consumed by both wrappers + router; structured
  `{category, provenance}` errors. Fixes: security bypass (validateCwd lives in
  index.ts today, not runners), mcp-opencode server-start-on-import, exports
  coupling.
- **Phase 2 — router v1 (narrowed):**
  - Fallback ONLY for provably pre-execution failures (spawn ENOENT,
    launch-time auth) OR when post-failure tree fingerprint is byte-identical
    to pre-attempt. **No restore** (stash create can't capture untracked;
    concurrent user edits make restore ill-defined; setsid survivors).
  - Timeout and empty-result are TERMINAL (never fallback).
  - Total time budget must fit MCP-client tool-call tolerance; cross-attempt
    progress notifications.
  - Chains = named immutable (backend, provider, model) entries in 0600 user
    config; per-call chain references names only; cross-provider transitions
    explicit opt-in.
  - Per-entry cooldowns with bounded TTL (no "until restart").
  - Every result: served-by + full attempt trace. Add `router_dry_run`.
  - `router_reply`: opaque router session handles w/ persisted metadata, or
    cut from v1.

## Open questions

- Does OpenCode's stream expose usable cost events (Grok's doesn't)? Determines
  whether any future quota work is even partially feasible.
- MCP sampling support across clients (Claude Code, Codex) — mature enough to
  build on?
- Would upstream multi-CLI bridges accept a failover/cooldown contribution?
