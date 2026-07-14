# MCP CLI workspace

This npm workspace contains three MCP stdio servers built on one internal
shared core. They are separate packages, separate executable processes, and
separate published identities:

- [`mcp-opencode`](./packages/mcp-opencode) delegates to the OpenCode CLI.
  Published on npm: [`mcp-opencode`](https://www.npmjs.com/package/mcp-opencode).
- [`mcp-grok`](./packages/mcp-grok) wraps the installed Grok Build CLI.
  Published on npm: [`mcp-grok`](https://www.npmjs.com/package/mcp-grok).
- [`mcp-router`](./packages/mcp-router) routes a coding task to a
  user-configured model tier (light/standard/heavy) with capability filtering
  and provably-safe cross-backend fallback. **New; not yet published.**

`@mcp-coding-agents/core` is a private, never-published package that holds the
shared run/parse/classify/redact/validateCwd runtime; it is bundled into each
product's `dist` at build, so it is never a runtime npm dependency. Each
publishable package still owns its own tool schemas, tests, and runtime deps and
can be installed on its own.

## Quick start

```bash
npm install
npm run build
npm test
```

Register either published server directly with an MCP client:

```bash
# OpenCode-backed server
npx -y mcp-opencode

# Grok Build CLI-backed server
npx -y mcp-grok
```

For Claude Code, add the desired server with `claude mcp add`; for Codex, use
`codex mcp add`. Package-specific READMEs contain complete commands, tool
schemas, environment variables, prerequisites, and security limitations:

- [mcp-opencode setup and tools](./packages/mcp-opencode/README.md)
- [mcp-grok setup and tools](./packages/mcp-grok/README.md)

## Workspace development

Run one package in isolation when iterating:

```bash
npm run build --workspace mcp-opencode
npm test --workspace mcp-opencode
npm run build --workspace mcp-grok
npm test --workspace mcp-grok
```

The root package is private and has no `bin`, `files`, or publishable package
behavior. Do not commit, publish, or rename the repository as part of local
development.

## License

The workspace and both packages are MIT licensed. Each publishable package
contains its own copy of [`LICENSE`](./LICENSE).
