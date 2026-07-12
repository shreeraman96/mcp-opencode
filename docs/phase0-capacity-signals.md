# Phase 0 — Capacity-failure signals: can we classify with high precision?

*2026-07-11. Static analysis of installed binaries (opencode 1.17.13, grok 0.2.93),
OpenCode source research (github.com/sst/opencode → anomalyco/opencode), AI SDK
source, embedded Grok CLI docs, and two live error probes. Gates the mcp-router
LOCKED PLAN (see routing-research.md).*

## VERDICT: **PARTIALLY classifiable**

- **OpenCode: classifiable with HIGH precision.** Capacity errors surface as a
  structured stdout JSONL event `{"type":"error", "error":{"name":"APIError",
  "data":{statusCode, isRetryable, responseBody, ...}}}` — numeric `statusCode`
  plus the raw provider error body (whose stable `error.type` string, e.g.
  `rate_limit_error` / `overloaded_error` / `insufficient_quota`, survives
  verbatim in `data.responseBody`). The agent's own prose can never write to the
  `type:"error"` channel, which eliminates the "agent text mentions rate limit"
  false-positive class entirely.
- **Grok: NOT classifiable with high precision today.** The only documented
  error surface is `{"type":"error","message":"<free text>"}` (live-confirmed;
  no code/status field). Rate limits are auto-retried inside an internal HTTP
  retry middleware; the typed capacity machinery (`RetryState.is_rate_limited`,
  `error_type` ∈ `RateLimited | UsagePoolExhausted | UsageLimitReached |
  GlobalRateLimit | ServiceUnavailable | ...`) is confirmed to exist in the
  binary but is only *plausibly* — not confirmedly — emitted on stdout.
  Keyword matching restricted to the error-event channel gives MEDIUM precision.
- **Implication for the router:** the premise survives for OpenCode-backed
  entries. For Grok, capacity detection must be treated as advisory (cooldown
  hint), never as the sole trigger for fallback — which is compatible with the
  LOCKED PLAN's Phase 2 restriction (fallback only on pre-execution failures or
  byte-identical trees). One live 429 capture per CLI is still wanted before
  fixtures are locked (see "Remaining unknowns").

---

## (a) Per-CLI catalog of error surfaces

### OpenCode (`opencode run --format json --print-logs --log-level ERROR`)

Consumed channels: stdout JSONL, stderr text logs, exit code.

#### A1. Structured stdout error events — the primary signal

The `run` command's JSON emitter (verified in the installed binary, matching
`packages/opencode/src/cli/cmd/run.ts` upstream):

```js
Z(N,_){if(j.format==="json")return process.stdout.write(
  JSON.stringify({type:N,timestamp:Date.now(),sessionID:W,..._})+"\n"),!0;...}
// on session.error stream events:  Z("error",{error:J.error})
```

So every session error is one stdout line:

```json
{"type":"error","timestamp":...,"sessionID":"ses_...","error":{"name":"<NamedError>","data":{...}}}
```

**Live-captured example** (bogus model, opencode 1.17.13, exit code 1):

```json
{"type":"error","timestamp":1783798004906,"sessionID":"ses_0ad5a83a6ffe6i0wuaLl2tRwOK","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"err_c3aeaf16"}}}
```

#### A2. The `APIError` NamedError — carries the capacity data

Schema verified byte-for-byte in the installed binary (defined upstream in
`packages/opencode/src/session/message-v2.ts` + `packages/core/src/util/error.ts`
`NamedError.create(...).toObject()` → `{name, data}`):

```
"APIError": { message: String, statusCode?: Number, isRetryable: Boolean,
              responseHeaders?: Record, responseBody?: String, metadata?: Record }
"ContextOverflowError": { message, responseBody? }
"ProviderAuthError", "ProviderModelNotFoundError", "AbortedError",
"StructuredOutputError", "Unknown"  (sibling NamedError types)
```

Provider-error mapping (`packages/opencode/src/provider/error.ts`
`parseAPICallError` / `parseStreamError`, verified in binary):

- AI SDK `APICallError` → `APIError` with `statusCode` = HTTP status (429, 529,
  503, …), `isRetryable`, and `responseBody` = **raw provider JSON verbatim**.
- OpenAI `error.code === "insufficient_quota"` → explicitly special-cased:
  `message: "Quota exceeded. Check your plan and billing details."`,
  `isRetryable: false`, raw body preserved.
- `context_length_exceeded` / HTTP 413 → `ContextOverflowError` (distinct name —
  never confused with capacity).
- Anthropic streamed `overloaded_error` → the AI SDK anthropic provider maps it
  to `APICallError{statusCode: 529, isRetryable: true, responseBody:
  JSON.stringify(error)}` (verified in binary):

```js
throw new CQ({..., statusCode: U.type==="overloaded_error"?529:500,
  responseBody: JSON.stringify(U), isRetryable: U.type==="overloaded_error"})
```

#### A3. AI SDK retry-exhaustion wrinkle (`AI_RetryError`)

The AI SDK retries retryable errors (429/5xx and `retry-after` hints) with
exponential backoff; on exhaustion it throws `AI_RetryError` with message
`"Failed after N attempts. Last error: <msg>"` and reason
`"maxRetriesExceeded"`. OpenCode's `fromError` has **no RetryError case** — the
binary contains exactly one `lastError` reference (the AI SDK class definition
itself), so a retry-exhausted capacity error falls through
`Q instanceof Error` → `{"name":"Unknown","data":{"message":"Failed after N
attempts. Last error: ..."}}`. Still on the error channel, still stable prefix,
but **without** `statusCode`. A capacity classifier must handle both shapes.
(Whether opencode's streamText path always hits this wrapper vs. surfacing the
inner `APICallError` directly was not runtime-verified — see unknowns.)

#### A4. stderr (`--print-logs --log-level ERROR`)

Structured-ish log lines; live-captured:

```
timestamp=... level=ERROR ... error="ProviderModelNotFoundError: Model not found: bogus-provider/bogus-model." cause="..."
```

Named error classes appear here even when the stdout event was masked as
`UnknownError` (observed for launch-time errors). Useful as a fallback/refinement
channel; the current `classifyError` in
`packages/mcp-opencode/src/policy.ts` already regexes it for
`ProviderModelNotFoundError` and auth.

#### A5. Current wrapper gap (bug, fix in Phase 1)

`packages/mcp-opencode/src/parse.ts` `feedLine` handles `type:"error"` as
`(part.message || part.error) || event.message || event.error || JSON.stringify(event)`
— but the real event nests the payload under `event.error` as an **object**, so
`String(message)` yields `"[object Object]"`. The structured `error.name` /
`error.data.statusCode` / `error.data.responseBody` are currently discarded.
Any classifier must read `event.error.name` + `event.error.data` directly.

#### Stability assessment

- The `{name, data}` NamedError envelope and `Z(...)` emitter are core to
  opencode's `--format json` contract; `APIError`'s field set is a Zod schema in
  `packages/core`. Moderate-to-high stability.
- `statusCode` numbers and provider `error.type` strings
  (`rate_limit_error`, `overloaded_error`, `insufficient_quota`,
  `rate_limit_exceeded` — all present as literals in the binary) are
  provider-API contracts: very stable.

### Grok Build CLI v0.2.93 (`grok --prompt-file ... --output-format streaming-json`)

Consumed channels: stdout JSONL, stderr text, exit code.

#### B1. Documented stdout error event — free text only

From the CLI's own embedded headless-mode docs (extracted from the binary):

> | `error` | An error occurred (carries `message`) |
> Grok may also emit `max_turns_reached` and `auto_compact_*` events; treat the
> list as non-exhaustive and switch on `type`.

**Live-captured** (bogus model, exit code 1):

```
stdout: {"type":"error","message":"Couldn't set model 'definitely-not-a-model-xyz': Invalid params: \"unknown model id\". Run 'grok models' to see available models."}
stderr: Error: Couldn't set model '...': Invalid params: "unknown model id". ...
```

Same free text on both channels; **no code/status/kind field.**

#### B2. Internal capacity machinery — exists, stdout surfacing unconfirmed

All from `strings` on the binary (code-path evidence, not observed output):

- `RetryState { attempt, max_retries, exhausted, is_rate_limited, error_type }`
  — a variant (`retry_state`) of an internally tagged `SessionUpdate` enum
  alongside `diff_review`, `auto_compact_started/completed/failed`,
  `memory_flush_*` (source refs: `crates/codegen/xai-grok-pager/src/trace_cmd.rs`).
  Ambiguity: `SessionUpdate` serialization was traced to a **WebSocket gateway
  bridge** (`xai-grok-shell/src/gateway_bridge/connection.rs`, for
  GrokWeb/Desktop sync) and to `grok trace` session export — yet the embedded
  docs say `auto_compact_*` (the same enum family) *does* reach streaming-json
  stdout. So `{"type":"retry_state","is_rate_limited":true,"error_type":...}`
  on stdout is plausible but **unconfirmed**.
- Typed denial reasons (serde/proto enum with `source`/`details`):
  `NotImplemented | Unauthorized | Timeout | Cancelled | RateLimited |
  UsagePoolExhausted | UsageLimitReached | GlobalRateLimit | ServiceUnavailable
  | NetworkError | ... | TerminalError | Custom` — with proto doc comments
  ("system-wide (global) rate limit", "usage limit with no balance verdict").
  Backend admission-control taxonomy; no evidence it reaches CLI output.
- Retry middleware (`xai-grok-auth/src/retry_middleware.rs`,
  `SharedRetryClassifier`) matching a lowercase keyword list —
  `rate limit`, `too many requests`, `status 429`, `error 429`, `status 500`,
  `bad gateway`, `status 503`, `gateway timeout`, ... — i.e. Grok **auto-retries
  capacity errors internally**; transient 429s are likely absorbed silently and
  only exhaustion would surface (as free text, format unknown).
- Plain string `"You've hit the rate limit for your plan. Upgrade your account
  or try again later."` exists but sits amid vendored web-UI assets; call site
  in the CLI path unconfirmed.
- `ChatGlobalRateLimitDetails` / `ChatRenderToolRateLimitedDetails`: protobuf
  messages for a narrow image-gen quota feature; not general coding capacity.

#### B3. `stopReason` does not encode capacity

`end`-event `stopReason` serde variants found: `EndTurn`, `MaxTokens`,
`MaxTurnRequests`, `Refusal`, `Cancelled`, (`StreamingError` adjacent). No
rate-limit/quota variant. Observed live: `EndTurn`, `Cancelled`.

#### B4. Existing fixtures

- `packages/mcp-grok/tests/fixtures/streaming-json.jsonl`: 4 sanitized lines
  (`thought`×2, `text`, `end{stopReason:"EndTurn"}`) — no error event captured.
- `packages/mcp-opencode/tests/fixtures/`: only `tree.mjs` (spawn harness); no
  real opencode output fixtures at all. New live captures from this
  investigation: `grok-badmodel.out/.err`, `oc-badmodel.out/.err` in the session
  scratchpad (worth promoting to fixtures in Phase 1).

#### B5. Demonstrated false-positive risk on free text

The Grok binary itself contains what is clearly baked-in *assistant prose*
discussing rate limits: `"You asked how retries work in the payment client:
exponential backoff in billing/retry.rs, max 5 attempts, 429s only."` — proof
that "429"/"rate limit" legitimately occurs in agent `text` output. Any rule
that scans assistant text is disqualified.

---

## (b) Proposed classification rules

Principle: **classify only on error-designated channels** (stdout
`type:"error"` events, stderr, exit code) — never on `text`/`thought` events or
tool output. Agent prose cannot reach those channels, so the dominant
false-positive class is structurally excluded on both CLIs.

### OpenCode (all rules operate on the parsed `{"type":"error"}` event object)

| Category | Rule (JSON-path) | Precision |
|---|---|---|
| capacity (rate limit) | `error.name=="APIError" && error.data.statusCode==429` | **High.** Numeric field, provider-set. Refine via `JSON.parse(error.data.responseBody).error.type` ∈ {`rate_limit_error`,`rate_limit_exceeded`} to split rate-limit vs quota. |
| capacity (overloaded) | `error.name=="APIError" && (statusCode==529 \|\| statusCode==503 \|\| responseBody.error.type=="overloaded_error")` | **High.** 529 mapping to Anthropic `overloaded_error` verified in binary. Plain 500s should stay "transport/unknown", not capacity. |
| capacity (quota exhausted) | `error.name=="APIError" && (responseBody.error.type\|code ∈ {insufficient_quota} \|\| (statusCode==429 && isRetryable==false))` | **High.** `insufficient_quota` special-case verified (isRetryable forced false). |
| capacity (retry-exhausted fallback) | `error.name=="Unknown" && /^Failed after \d+ attempts\./.test(error.data.message)` → then keyword-check the remainder for 429/rate-limit/overloaded | **Medium-high.** AI-SDK-stable prefix, error channel only; lacks statusCode. Mark provenance "inferred". |
| auth | `error.name=="ProviderAuthError"` or stderr `/ProviderAuthError\|401\|unauthorized/` | High (structured) / medium (stderr). |
| model-not-found | `error.name=="ProviderModelNotFoundError"` (stdout may mask as `UnknownError`; stderr regex `ProviderModelNotFoundError` — already implemented — remains necessary) | High. |
| context overflow (never capacity) | `error.name=="ContextOverflowError"` | High; explicitly excluded from capacity. |
| transport | spawn `ENOENT`, `error.name=="ProviderHeaderTimeoutError"/"ProviderResponseStreamError"` (surface as `APIError` with `metadata.code`), or `APIError` with no statusCode + network-ish message | Medium; keep separate from capacity. |

False-positive analysis: `statusCode` and `error.name` are program-set fields
on a channel the model cannot write to. The only leak path is
`error.data.message` *quoting* upstream text — mitigated by preferring the
numeric/enum fields and only falling back to message-prefix matching for the
`Unknown`/retry-exhausted shape.

### Grok (rules operate on `{"type":"error"}.message` and the stderr `Error:` line ONLY)

| Category | Rule | Precision |
|---|---|---|
| capacity (suspected) | within error event message or stderr `Error:` line: `/rate.?limit\|too many requests\|\b429\b\|quota\|usage limit\|overloaded\|capacity/i` | **Medium.** Channel restriction removes agent-prose FPs, but: (1) the actual message template for a real capacity failure is UNVERIFIED; (2) an error message that merely quotes a file/url containing "429" could FP; (3) internal auto-retry may absorb transient 429s so exhaustion text may say something else entirely. Treat as advisory only. |
| capacity (structured, future) | if a `{"type":"retry_state"}` event with `is_rate_limited`/`error_type` ever observed on stdout → high-precision; add to parser as unknown-event today (it would currently count into `unknownEvents`) | Unconfirmed — needs live capture. |
| auth | existing `classifyError` in `packages/mcp-grok/src/policy.ts` (`No auth credentials for cli-chat-proxy`, `auth.x.ai`, 401, ...) | Medium-high (live-derived patterns). |
| transport | `spawn grok ENOENT` (existing rule), `NetworkError`-ish messages | High for ENOENT; medium otherwise. |
| NOT capacity | `stopReason` ∈ {MaxTokens, MaxTurnRequests, Refusal, Cancelled}; anything only in `text` events | — |

Recommended structured output for the shared core (Phase 1):
`{category: "capacity"|"auth"|"model"|"context"|"transport"|"task"|"unknown",
provenance: "structured"|"inferred", backend, statusCode?, providerErrorType?}`
— provenance "structured" only when derived from `error.name`/`statusCode`/
provider `error.type`; router cooldown/fallback decisions should require
"structured" for OpenCode and treat all Grok capacity classifications as
"inferred".

---

## (c) Remaining unknowns / recommended follow-ups (cheap)

1. **No live 429 was captured for either CLI** (deliberately not forced). The
   OpenCode `APIError{statusCode:429}` shape is verified from emitter + schema +
   mapping code in the shipped binary and upstream source — high confidence —
   but one real capture (e.g. an OpenRouter free-tier key, which 429s readily)
   should be taken in Phase 1 to lock the fixture, and would also settle the
   A3 RetryError-vs-APIError question.
2. **Grok capacity-failure message text is unknown.** Options: exhaust a
   trial-tier quota once and capture; or watch `unknownEvents` for
   `retry_state` in normal operation. Until then Grok capacity = advisory.
3. OpenCode `maxRetries` configuration (whether users can set it to 0, making
   the raw `APICallError` path the only one) was not pinned down.
4. Upstream drift risk: OpenCode renamed orgs (sst → anomalyco) and moves fast;
   the `NamedError` names should be covered by a fixture-based contract test in
   both wrappers so a CLI bump that changes shapes fails loudly.

## Evidence sources

- Installed binaries: `/Users/shreeram/.opencode/bin/opencode` (1.17.13, bun
  bundle — JS readable via `strings`), `/Users/shreeram/.grok/downloads/grok-macos-aarch64`
  (0.2.93, Rust; includes embedded headless-mode docs).
- OpenCode source (fetched from github.com/anomalyco/opencode, redirect target
  of sst/opencode): `packages/opencode/src/provider/error.ts`,
  `packages/opencode/src/session/message-v2.ts`,
  `packages/opencode/src/cli/cmd/run.ts`, `packages/core/src/util/error.ts`.
- Vercel AI SDK: `packages/provider/src/errors/api-call-error.ts`
  (`isRetryable` default = statusCode ∈ {408,409,429} ∪ ≥500; no dedicated
  RateLimitError class), `retry-with-exponential-backoff` (RetryError,
  `maxRetriesExceeded`).
- Live probes (this session): bogus-model runs of both CLIs; outputs quoted in
  §A1/§B1 verbatim.
- This repo: `packages/mcp-opencode/src/{parse,policy}.ts`,
  `packages/mcp-grok/src/{parse,policy}.ts`, both `tests/fixtures/`.
