# Phase 1 plan — extract internal `core`, thin the wrappers, fix 2 bugs

*Locked 2026-07-12. Prereq for mcp-router (Phase 2). Packaging decision: bundle
core internally (not a published package). Pure refactor + 2 bug fixes — NO
user-facing behavior change, NO tool-schema change, NO publish, NO commit.*

## Goal

One shared home for run/parse/classify/redact/validateCwd so the router (Phase 2)
and both wrappers share ONE copy instead of drifting into three. Resolves
reviewer blockers M2 (no floating-against-internals) and M3 (security lives in a
reusable layer, not only in each `index.ts`).

## New package: `packages/core` (private, never published)

`package.json`: `"name": "@mcp-coding-agents/core"`, `"private": true`, `"type":
"module"`. No `bin`. Consumed only inside the workspace; bundled into each
product's `dist` at build, so it is never a runtime npm dependency.

### Public API (the versioned contract the router will also use)

- `text.ts` — `stripAnsi`, `redact`, `boundText` (move verbatim; identical today).
- `cwd.ts` — `getConfiguredRoots(envVar, defaultRoots)`, `validateCwd(cwd, {
  rootsEnvVar, defaultRoots })`. Parameterize the env-var name — the ONLY
  difference between the two wrappers' copies today (`OPENCODE_MCP_ROOTS` vs
  `GROK_MCP_ROOTS`). This is the security boundary; the router (Phase 2) calls it
  with `MCP_ROUTER_ROOTS`.
- `queue.ts` — `CwdQueue` (near-identical; unify).
- `errors.ts` — the new structured contract:
  - `type ErrorCategory = 'transport' | 'capacity' | 'auth' | 'model' |
    'timeout' | 'task' | 'empty' | 'unknown'`
  - `type Provenance = 'spawn' | 'exit' | 'stream' | 'timeout' | 'inferred'`
    (where the signal came from — the router trusts `stream`/`spawn`/`timeout`
    over `inferred`)
  - `interface StructuredError { category: ErrorCategory; provenance:
    Provenance; message: string; statusCode?: number }`
- `types.ts` — the shared `RunOutcome` shape (reason, exitCode, parsed events,
  stderrTail, elapsedSec, sessionID, structuredErrors: StructuredError[]).
- `backends/opencode.ts` — `runOpencode(opts)`, opencode stream parser,
  `classifyOpencode(...) : StructuredError[]`.
- `backends/grok.ts` — `runGrok(opts)`, grok JSONL parser, `classifyGrok(...)`.

The CLI-specific arg-building + run loops (very different between the two, ~470-
line diff) live in their `backends/*.ts` module — moved, not merged.

## Thin shells: `mcp-opencode` / `mcp-grok`

Each `index.ts` keeps ONLY: the `McpServer`, `registerTool` calls, the zod input
schemas, and the mapping from tool input → `core` backend call → tool result
text. It imports `validateCwd`/`redact`/`runOpencode` etc. from core with its own
env-var name. Everything else (policy.ts/parse.ts/run.ts/queue.ts bodies) moves
into core. `mcp-opencode/src/index.ts` must keep the current behavior; note it
currently starts its server on import — after the refactor the server-start must
be guarded (grok already has an `isMainModule` guard; opencode must match) so the
router can safely import shared code paths without launching a server.

## Bundling (tsc → tsup, per product)

Add `tsup` as a dev dependency. Each product's build:
`tsup src/index.ts --format esm --platform node --dts=false`, with core marked
`noExternal` (bundled in) and `@modelcontextprotocol/sdk` + `zod` kept
`external` (real runtime deps, stay in each product's `dependencies`). core is a
`devDependency` of each product (available at build, not declared at runtime).
MUST preserve the `#!/usr/bin/env node` shebang on the emitted `dist/index.js`
(tsup `banner`/shebang handling) so the `bin` still works. `files`, `bin`, and
the published tarball contents must be unchanged. Verify `npm pack --dry-run`
output matches today's (dist + README + LICENSE).

## Bug fixes (from Phase 0)

1. **`mcp-opencode` parse `[object Object]` (parse.ts:265-272).** When the
   `type:"error"` event's `.error` is an object, DON'T `String()` it. Extract
   `error.name`, `error.data.statusCode`, and provider `error.data.responseBody`
   into a `StructuredError` (this is the router's capacity signal). Keep a
   readable message too. Add a fixture + test with the real event envelope:
   `{"type":"error","error":{"name":"APIError","data":{"statusCode":529,...}}}`.
2. **OpenCode retry-exhausted wrapper.** Errors that fall through as
   `{"name":"Unknown","data":{"message":"Failed after N attempts. Last error:
   ..."}}` — add a classify rule that unwraps this to a `capacity`/`transport`
   category by inspecting the trailing "Last error". Test it.

## Classification (structured, replacing string-returning classifyError)

- opencode: read structured `type:"error"` events → map statusCode 429/529 /
  provider `error.type` (`rate_limit_error`/`overloaded_error`) → `capacity`
  (provenance `stream`); `insufficient_quota` → `capacity`; auth/401 → `auth`;
  `ProviderModelNotFoundError` → `model`. Spawn ENOENT → `transport` (provenance
  `spawn`). Router-enforced timeout → `timeout`.
- grok: free-text only today → keyword match RESTRICTED to the error-event
  channel = `capacity`/`auth` with provenance `inferred` (never a sole fallback
  trigger, per locked plan). Missing CLI → `transport`.

## Tests / acceptance

- All existing tests in both packages stay green (behavior-preserving refactor).
- New tests: the 2 bug fixes; structured classification for the known
  categories; `validateCwd` parameterized env var.
- `npm test` (workspace) green; `npm run build` green; `npm pack --dry-run` for
  both products unchanged vs. current.
- No change to any tool name, input schema, or result text format that a client
  would observe.

## Out of scope (Phase 2)

The router package, fallback/cooldown/chain logic, session handles, dry-run.
Phase 1 only makes the shared, tested foundation.
