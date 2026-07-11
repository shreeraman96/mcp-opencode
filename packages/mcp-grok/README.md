# mcp-grok

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

`mcp-grok` is an MCP stdio server that wraps the installed official Grok Build
CLI. It does not call the xAI API directly, and it does not bundle or replace
the `grok` executable. Every tool invocation starts or queries the local CLI.

## Prerequisites

- Node.js ≥ 20.
- Grok Build CLI installed as `grok` and available on `PATH`. The behavior was
  probed against v0.2.93.
- A CLI login, normally completed with `grok login` or the CLI's supported
  existing credential setup. `grok models` is the quickest availability check.

The wrapper passes model IDs to Grok as-is after a safe argument-shape check.
IDs can be simple names such as `grok-4.5` or
`grok-composer-2.5-fast`; they do not use OpenCode's `provider/model` format.

## Register with an MCP client

No global install is required. `npx` fetches the published package:

```bash
# Claude Code
claude mcp add -s user grok \
  -e GROK_MCP_ROOTS="$HOME/Projects" \
  -- npx -y mcp-grok

# Codex
codex mcp add grok \
  --env GROK_MCP_ROOTS="$HOME/Projects" \
  -- npx -y mcp-grok
```

For a local checkout, register
`node /absolute/path/to/mcp-opencode/packages/mcp-grok/dist/index.js` after
running `npm run build --workspace mcp-grok`.

## Tools

### `grok_run`

Starts a new Grok session and returns the generated UUID in the response.

| field | type | notes |
|---|---|---|
| `prompt` | string | required task prompt |
| `cwd` | string | required; must resolve inside `GROK_MCP_ROOTS` |
| `model` | string | required Grok model ID, for example `grok-4.5` |
| `effort` | string | optional reasoning effort passed as `--effort` |
| `maxTurns` | integer 1–100 | default 8; bounds runaway agent loops |
| `timeoutSec` | integer 30–3600 | default 900 |

### `grok_reply`

Continues an existing session with `--resume <uuid>`. It accepts the same
`prompt`, `cwd`, `model`, `effort`, `maxTurns`, and `timeoutSec` fields plus:

| field | type | notes |
|---|---|---|
| `sessionID` | UUIDv4 string | required session ID returned by `grok_run` |

The caller must provide the same `cwd` used by the original session. Grok
stores session data under its own configuration and this wrapper has no
reliable way to prove that a supplied cwd is the original one, so it does not
invent that guarantee.

### `grok_models`

Takes no input. Runs the supported `grok models` command. The wrapper does not
add `--json` or `--cwd` because v0.2.93 rejects both. Output and diagnostics
are bounded and redacted.

### `grok_inspect`

Accepts `cwd` and runs `grok inspect --json` with the validated directory as the
child process `cwd`. The CLI rejects `--cwd` for this subcommand, so no cwd
flag is passed. Output is bounded and redacted.

## Configuration and permissions

| env var | default | purpose |
|---|---|---|
| `GROK_MCP_ROOTS` | `$HOME/Projects` | colon-separated cwd allowlist; realpaths are checked |
| `GROK_MCP_ALLOW_AUTO` | unset | only when exactly `1`, pass Grok `--always-approve` |

Without the opt-in, runs explicitly pass `--permission-mode auto`. This is the
least-privileged mode that actually authorizes tool calls in a headless
(`--prompt-file`, non-TTY) run: on Grok v0.2.93, `acceptEdits` and `dontAsk`
cancel the turn (stopReason `Cancelled`, no edits made), while `auto` and
`bypassPermissions` complete (stopReason `EndTurn`). `auto` is chosen over
`bypassPermissions` to keep the default as constrained as possible while still
letting the delegated task do its work. The default never passes
`--always-approve`; the `GROK_MCP_ALLOW_AUTO=1` opt-in passes that flag alone
(full auto-approval) and never combines contradictory permission flags.

Each run also passes `--no-memory`, `--no-subagents`, and `--verbatim` to avoid
cross-session memory, surprise subagent work, and prompt rewriting. These flags
are behavior-affecting choices and can change what the CLI does compared with
an interactive session.

### Security posture — read before enabling

**`GROK_MCP_ROOTS` is a start-directory allowlist, not a filesystem sandbox.**
Under the default `--permission-mode auto` (and, a fortiori, the
`GROK_MCP_ALLOW_AUTO=1` full-bypass mode), every successful run is an
**autonomous coding agent with tool approval already on**. It can read and write
any path the invoking user can — including files outside the configured roots,
e.g. `~/.ssh`, `~/.zshrc`, or other projects. The roots check only constrains
where the child process *starts*; it does not confine the reads, writes, or
shell commands the agent performs afterward. Grant roots, models, and network
access on that understanding, and run untrusted prompts only where that blast
radius is acceptable.

On timeout or abort the server force-signals the child process group and the
child pid, then finalizes. A grandchild that re-sessions itself with `setsid`
into its own process group can outlive that signal; the server reports the run
as timed out/aborted, but such a detached descendant may keep running. Treat a
timeout/abort as "stop waiting", not "guaranteed nothing is still executing".

## Process and privacy behavior

- The prompt is written to a temporary file with mode `0600`; prompt text is
  never placed on the child argv or visible in normal process listings.
- A per-run temporary leader socket is passed to Grok and its temporary
  directory is cleaned on exit, abort, timeout, spawn failure, and forced
  finalization. The CLI may still delegate work to a leader; removing the
  socket is not proof that remote work or billing stopped.
- Runs sharing a resolved cwd are serialized. Different resolved cwds can run
  concurrently. Roots and cwd are resolved with `fs.realpath`, so symlink
  escapes are rejected.
- stdout is parsed as JSONL. Only `text.data` is retained. Observed
  `thought.data` reasoning, tool payloads, request IDs, and unknown events are
  ignored. Assistant text is capped to a head/tail window; malformed and
  oversized lines are counted rather than retained.
- Errors include only bounded, ANSI-stripped, redacted stderr tails. Common
  xAI/Grok key shapes, bearer tokens, generic secret assignments, and Grok
  session paths are redacted.
- Timeout and client abort send SIGTERM to the detached process group and then
  SIGKILL after a grace period. This proves local process cleanup only; it does
  not claim cancellation of already submitted remote model work or billing.
- No reliable incremental usage or cost event appeared in the observed CLI
  stream, so this wrapper deliberately has no cost-cap or cost-reporting field.

## CLI compatibility and observed stream

The implementation targets the installed Grok Build CLI v0.2.93. The CLI
accepts `--no-auto-update` even though it is not shown in its help output; the
wrapper uses it for automation and this is a compatibility risk if the flag is
removed. v0.2.93 makes `--prompt-file` headless by itself and rejects combining
it with `-p/--single`, so the wrapper uses `--prompt-file` only. New sessions
use `--session-id <uuid>`; replies use `--resume <uuid>`, never `-s` as a
resume flag.

The authenticated read-only probe produced this event shape:

```json
{"type":"thought","data":"..."}
{"type":"text","data":"READY"}
{"type":"end","stopReason":"EndTurn","sessionId":"<uuid>","requestId":"<uuid>"}
```

The fixture at [`tests/fixtures/streaming-json.jsonl`](./tests/fixtures/streaming-json.jsonl)
contains the sanitized observation. The wrapper captures the requested or
generated session ID even if the CLI omits its terminal event.

## Development

From the repository root:

```bash
npm install
npm run build --workspace mcp-grok
npm test --workspace mcp-grok
npm pack --workspace mcp-grok --dry-run
```

Live CLI calls are intentionally not part of the unit suite. The checked-in
fixture is sanitized and contains no credentials, local paths, or real session
IDs.

## License

[MIT](./LICENSE)
