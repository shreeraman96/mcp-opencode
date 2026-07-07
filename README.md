# mcp-opencode

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

An [MCP](https://modelcontextprotocol.io) server that lets an AI coding agent
(Claude Code, Codex, or any MCP client) **delegate implementation work to the
[OpenCode CLI](https://opencode.ai)** — choosing an explicit **provider + model
on every call**.

Use it to orchestrate with one model while offloading the actual code-writing to
another: plan in Claude, implement with GLM 5.2, Kimi, DeepSeek, a local Ollama
model, or anything else OpenCode can reach.

> **Provider-agnostic.** This server contains **no** provider-specific logic. It
> passes your `provider/model` string straight to `opencode run -m`, so it works
> with every provider OpenCode supports (75+ via [models.dev](https://models.dev),
> plus local models). Whatever you've authenticated in OpenCode, you can use here.

## Why

- **Model per task.** A cheap model for mechanical edits, a strong one for hard
  changes — decided per call, not baked into config.
- **Real cost/token reporting** returned with every run.
- **Multi-turn.** Continue a session to iterate on the same working tree.
- **Safe by construction.** `cwd` is confined to an allowlist; the child process
  tree is killed cleanly on timeout/abort/cost-cap; secrets are redacted from
  anything echoed back.

## Prerequisites

- Node.js ≥ 20
- The [OpenCode CLI](https://opencode.ai) installed and on `PATH`, with at least
  one provider authenticated (`opencode auth login`). Run `opencode models` to
  see what's available to you.

## Install

```bash
git clone https://github.com/shreeraman96/mcp-opencode.git
cd mcp-opencode
npm install
npm run build
npm test          # unit tests
npm run smoke     # optional: live test against a real free OpenCode model
```

## Register

**Claude Code:**

```bash
claude mcp add -s user opencode \
  -e OPENCODE_MCP_ROOTS="$HOME/Projects" \
  -- node /absolute/path/to/mcp-opencode/dist/index.js
```

**Codex:**

```bash
codex mcp add opencode \
  --env OPENCODE_MCP_ROOTS="$HOME/Projects" \
  -- node /absolute/path/to/mcp-opencode/dist/index.js
```

Restart the client (or run `claude mcp list` / `codex mcp list`) to confirm it
connects. The tools appear as `opencode_run`, `opencode_reply`, `opencode_models`.

## Tools

### `opencode_run` — start a new session

| field | type | notes |
|---|---|---|
| `prompt` | string | required — the task |
| `model` | string | required — `provider/model`, e.g. `fireworks-ai/accounts/fireworks/models/glm-5p2` |
| `cwd` | string | required — must resolve inside an allowed root (see below) |
| `agent` | `'build' \| 'plan'` | default `'build'` (`plan` is read-only) |
| `variant` | string | optional model variant / reasoning effort (`high`, `max`, `minimal`) |
| `timeoutSec` | int 30–3600 | default 900 |
| `maxCostUsd` | number | optional — kill the run and return partial output if exceeded |

Returns status, `sessionID`, model, elapsed time, tokens/cost, a `git`-derived
changed-files summary (when `cwd` is a repo), and the assistant output.

### `opencode_reply` — continue a session

Takes a `sessionID` (`ses_…`) from a prior run plus a new `prompt`, `model`,
`cwd`, and `agent`. **`model` is required on every call** — there is no silent
inheritance from the original run, by design.

### `opencode_models`

No input. Runs `opencode models` and returns the available list.

## Example (Claude Code)

> Delegate to OpenCode: call `opencode_run` with model
> `fireworks-ai/accounts/fireworks/models/glm-5p2`, cwd `~/Projects/myapp`,
> agent `build`, and prompt "add input validation to routes/user.ts".

Swap the model string for `anthropic/claude-sonnet-4-5`, `openai/gpt-oss-120b`,
`opencode/big-pickle` (free), or any local model — nothing else changes.

## Configuration

| env var | default | purpose |
|---|---|---|
| `OPENCODE_MCP_ROOTS` | `$HOME/Projects` | colon-separated allowlist of directories `cwd` may resolve inside |
| `OPENCODE_MCP_ALLOW_AUTO` | unset | set to `1` to add OpenCode's `--auto` flag for `agent=build` runs (see below) |

### cwd allowlist

`cwd` is resolved with `fs.realpath` (symlinks followed) and must land inside one
of the `OPENCODE_MCP_ROOTS` directories. Requests outside the allowlist are
rejected before `opencode` is ever spawned.

### Permission model

OpenCode's `build` agent already runs `edit`/`bash`/`webfetch` non-interactively;
the `plan` agent is read-only. This server relies on those built-in agent
defaults and does **not** inject a custom permission config.

> **Note:** passing a custom `permission` block via `OPENCODE_CONFIG` was found to
> hang `opencode run` in a non-TTY environment (an unanswerable `ask` prompt), so
> that path is deliberately avoided. See [`src/policy.ts`](./src/policy.ts).

`--auto` (OpenCode's "auto-approve anything not explicitly denied", which the CLI
itself flags as dangerous) is **off by default** and only added when you set
`OPENCODE_MCP_ALLOW_AUTO=1` *and* the call uses `agent: 'build'`.

## How it works

- **`src/run.ts`** spawns `opencode` detached in its own process group, so the
  whole subprocess tree is killed as a unit (SIGTERM → 5s grace → SIGKILL) on
  timeout, client abort, or a `maxCostUsd` breach. Process exit is treated as the
  authoritative completion signal.
- **`src/parse.ts`** streams the `--format json` output line-by-line without ever
  buffering the raw stream; assistant text is capped to head(40k)+tail(10k) chars
  past 50k total.
- **`src/queue.ts`** serializes runs that share the same resolved `cwd`; different
  working trees run concurrently.
- **`src/policy.ts`** holds the cwd allowlist, model/session validation, secret
  redaction, and error classification.

For long runs, the server emits MCP progress notifications every 15s (when the
client supplies a progress token), which resets the client's idle timeout.

## License

[MIT](./LICENSE)
