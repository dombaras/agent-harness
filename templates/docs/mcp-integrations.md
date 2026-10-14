# MCP integrations (project-side, per-agent)

Model Context Protocol (MCP) servers give an agent live external state (the dev
database, a browser, a tracker) through tools. They are powerful and expensive:
**every MCP tool schema is billed on every request that can see it**, and opencode
spawns the server itself — so it bypasses the `serve.js` machine-capacity envelope
and consumes RAM per session. This project wires MCP **project-side, per-agent,
dev-only**. Read this before adding or changing an MCP server.

## The two rules (non-negotiable)

1. **Per agent, never global.** Disable every MCP tool at the top level, then
   re-enable the server's tools only for the persona that genuinely needs them.
   An MCP tool the orchestrator never uses is pure context tax.
2. **Development data only.** An MCP server that reaches a database must point at
   the `development` database (`DATABASE_URL`). Never uat/prod — the forward
   boundary in `.agents/memory/environments.md` still applies. Prefer a read-only
   or restricted mode where the server offers one.

## Config shape

`opencode.json` (top level):

```jsonc
{
  "mcp": {
    "servers": {
      "pg": {
        "type": "local",
        "command": ["npx", "-y", "prisma", "mcp"],
        "disabled": false
      }
    }
  },
  // Deny ALL of the server's tools globally (the action prefix is the server
  // name + "_"; V2 permissions replace the V1 top-level `tools` disable).
  "permissions": [{ "action": "pg_*", "resource": "*", "effect": "deny" }],
  "agents": {
    // Re-enable only for the personas that need live DB state (agent rules are
    // appended after global rules, so a later allow wins).
    "data-engineer": { "permissions": [{ "action": "pg_*", "resource": "*", "effect": "allow" }] },
    "diagnostics-expert": { "permissions": [{ "action": "pg_*", "resource": "*", "effect": "allow" }] }
  }
}
```

- MCP tools are registered **prefixed by the server name** (`pg_*`), so in V2 the
  deny/allow rule is an `action` of `"pg_*"` (the form used above). If action
  wildcards do not match in your V2 build, list per-tool rules instead.
- `--yes`/`-y` on `npx` avoids an interactive install prompt at startup.
- Keep a secret URL out of the tracked config: use `{env:...}` or a local
  untracked override. `npx` servers inherit the project `.env` (dev) as usual.

## Included servers in this project

| Server | Package | Enabled for | Notes |
|---|---|---|---|
| `pg` (Prisma/Postgres) | `npx -y prisma mcp` | `data-engineer`, `diagnostics-expert` | schema- and migration-aware; **dev DB only** |
| `playwright` | `npx -y @playwright/mcp@latest --headless` | `qa-runner`, `diagnostics-expert` | interactive web-E2E debugging; run against the `serve.js` dev server |

**GitHub MCP is deliberately not enabled.** It is the most token-heavy server and
is mostly obviated by the direct-land flow (`ship` + `gh` + `wait --ci`). Add it
only on a concrete demonstrated need, per-agent (`devops-engineer`) only.

## Capacity

A local MCP server is a process opencode spawns — it is **not** counted by
`serve.js`. On a small WSL2 VM a heavy server (a browser, an indexer) per parallel
session can exhaust RAM. Prefer remote servers (no local RSS) or one local server
enabled for a single agent. Watch RSS with `node scripts/serve.js list` /
`npm run test:capacity`.

## Verify

```bash
opencode mcp list          # server status + auth
opencode mcp debug <name>  # connection/auth diagnostics
```

## Deploy safety

`agent-harness update` deep-merges `opencode.json` by key: it preserves this
project's `mcp`, top-level `tools`, and per-agent `tools`. If the harness ever
ships a default `mcp` block it merges **by server name** (project wins), so a
project's server is never clobbered. Sources: `mergeOpencodeJson` /
`mergeMcp` in `bin/agent-harness.js`.
