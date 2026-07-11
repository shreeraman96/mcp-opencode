# MCP CLI workspace

This private npm workspace contains two independent MCP stdio servers. They
are separate packages, separate executable processes, and separate published
identities:

- [`mcp-opencode`](./packages/mcp-opencode) preserves the existing
  `mcp-opencode` package and delegates to the OpenCode CLI.
- [`mcp-grok`](./packages/mcp-grok) wraps the installed Grok Build CLI and
  publishes as `mcp-grok`.

Neither server is a combined router, and there is deliberately no shared core
package yet. Each package owns its CLI adapter, policy, parser, queue, tests,
and runtime dependencies so either package can be installed and published on
its own.

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
