# mcp-orchestrate

An MCP stdio server that routes a coding task to a **model tier** you configure
(`light` / `standard` / `heavy`), filters by **capability** (e.g. `vision`), and
falls back to the next configured backend **only when doing so is provably safe**.

The calling model (e.g. Claude Code, Codex) routes by *intent* — it picks a tier
with full task context. The router owns *reliability*: the tier→model mapping,
capability filtering, cooldowns, and a safety-gated fallback. It never invents a
model, and **nothing about any author's setup is baked in** — every mapping is
yours, supplied in config.

> **Honest scope (v1):** fallback fires only for **fast, clean failures** — a
> backend that isn't installed, is rate-limited/overloaded immediately, or fails
> auth at launch, with a byte-identical git tree. A run that edited files, timed
> out, or exhausted the budget is **terminal** and returned as-is. This is
> graceful fallback on fast/clean failure, not a mid-task rescue.

## Install

```bash
npx -y mcp-orchestrate
```

Register with an MCP client (Claude Code):

```bash
claude mcp add router -- npx -y mcp-orchestrate
```

> The published package is **`mcp-orchestrate`** and its CLI command is
> `mcp-orchestrate`. The config directory (`~/.config/mcp-router/`) and the
> `MCP_ROUTER_*` environment variables keep the `mcp-router` prefix for
> backward compatibility.

## Backends

`mcp-orchestrate` drives the CLIs you already have installed. It does not ship
or assume any model:

- **opencode** — spawned; any provider/model your OpenCode install exposes.
- **grok** — spawned; the Grok Build CLI.
- **codex** — spawned by default, or set `"advisory": true` on the entry to have
  the router return a "use the Codex MCP directly" hint instead of spawning it
  (an advisory entry needs no model and never sends your prompt anywhere).

## Configuration

`~/.config/mcp-router/config.json` (or `$XDG_CONFIG_HOME/mcp-router/config.json`,
or `$MCP_ROUTER_CONFIG`). The file **must be mode `0600`** and owned by you, or
the server refuses to read it.

```jsonc
{
  "tiers": {
    "light":    null,
    "standard": { "backend": "opencode", "model": "<provider>/<model>" },
    "heavy":    { "backend": "codex", "advisory": true }
  },
  "capabilities": {
    "vision": { "backend": "opencode", "model": "<provider>/<vision-model>", "capabilities": ["vision"] }
  },
  "fallbacks": { "light": "standard", "heavy": "standard" },
  "allowCrossProviderFallback": false
}
// All ids are placeholders. Supply your own backend/provider/model per slot.
```

- **Tier names are fixed** (`light`/`standard`/`heavy`); you only choose which
  model fills each slot. A tier name denotes *your intent for the slot*, not a
  model's size.
- **Provider is derived** from the opencode model prefix (`<provider>/...`) and a
  declared `provider` that disagrees is rejected. grok is always `xai`.
- **`allowCrossProviderFallback`** (default `false`): a fallback that would ship
  your prompt + repo content to a *different* provider requires this opt-in.
  Aggregator prefixes (`openrouter`, `github-copilot`) are always treated as
  cross-provider.
- **No config file?** The server still runs (zero-config), but every tier is
  unconfigured until you write one — it never fabricates a model.

### Environment

- `MCP_ROUTER_ROOTS` — colon-separated allowlist of directories a `cwd` must be
  inside (default `$HOME/Projects`). This is the security boundary.
- `MCP_ROUTER_CONFIG` — override the config path.

### Validate your config: `mcp-router --check`

Run the config doctor in your terminal (this is a CLI command, separate from the
MCP stdio server) to confirm the server will accept your config before wiring it
up:

```bash
mcp-orchestrate --check            # checks the default config path
mcp-orchestrate --check <path>     # or an explicit path
```

It loads the config through the exact same hardened path the server uses
(permissions `0600`, ownership, parent-directory checks, schema, and provider
derivation), prints the configured tiers/capabilities and which backend CLIs are
installed (warning on any configured-but-missing backend), and exits `0` when the
config is valid, `1` when it is invalid or absent.

## Tools

- **`route(prompt, cwd, tier, caps?, timeoutSec?)`** — dispatch to the tier (with
  safe fallback). Returns served-by, the full attempt trace, any cross-provider
  notice, then the assistant text (redacted).
- **`list_tiers()`** — minimal discovery: which tiers/capabilities are configured
  (presence only — never model ids, candidate counts, or the config path), which
  are cooling, and which CLIs are installed. Sends no prompt, probes no provider.
- **`router_dry_run(cwd, tier, caps?, timeoutSec?)`** — the explicit recipient
  preview: the exact ordered recipients (backend/model), authorization decisions,
  cross-provider crossings, and budget split, **without** sending the prompt.

## Safety limitations

- The fallback fingerprint is **cwd-scoped**: it proves the git working tree in
  `cwd` is unchanged, not that the machine is unchanged (an agent's shell can
  write to `$HOME`, sibling repos, or git config). "cwd tree unchanged" ≠
  "nothing happened".
- A non-git `cwd` cannot be fingerprinted, so any post-spawn failure there is
  terminal (never falls back).
- Cooldowns and traces surface a **coarse** reason (`unavailable`), never `auth`
  vs `capacity`, to avoid leaking per-provider credential health.

## License

MIT.
