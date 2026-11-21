# MCP integrations (project-side, per-agent)

Model Context Protocol (MCP) servers give an agent live external state (the dev
database, a browser, a tracker) through tools. They are powerful and expensive:
**every MCP tool schema is billed on every request that can see it**, and opencode
spawns the server itself — so it bypasses the `serve.js` machine-capacity envelope
and consumes RAM per session. This project wires MCP **project-side, per-agent,
dev-only**. Read this before adding or changing an MCP server.

## The two rules (non-negotiable)

1. **Per agent, never global.** The managed `mcp.use: "*"` policy default-denies
   every MCP server. Append an explicit allow for only the server and agents
   that genuinely need it; re-enable its tools only for that persona.
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
  // Managed policy denies MCP availability; append this project opt-in.
  "policies": [{ "action": "mcp.use", "resource": "pg", "effect": "allow" }],
  // Deny the server's tools globally (the action prefix is the server
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

`agent-harness update` unions managed-first and project-appended `policies`
(duplicate entries are dropped and legacy `experimental.policies` are migrated).
Existing configured servers remain hard-denied after update until the project
appends an `mcp.use` allow; this deliberate breaking behavior is not auto-allowed.
`update` prints a warning naming affected servers, and `doctor` reports each
server with the exact snippet. Sources: `mergeOpencodeJson` / `mergeMcp` in
`bin/agent-harness.js`.

**V1 `tools` gating is migrated, not preserved.** V2 has no top-level or
per-agent `tools` field (only `permissions`), so an older project that gates MCP
the V1 way (`"tools": { "pg*": false }` plus `agents.<name>.tools: { "pg*": true }`)
would otherwise be silently broken: the server reports *connected* while no agent
can call its tools. `update` translates both maps into ordered rules — the
top-level map into global `{ "action": "<name>", "resource": "*", "effect":
"deny" }` rules and each `agents.<name>.tools` map into that agent's own rules
(an `allow` wins the global deny, since agent rules are appended last) — and drops
the V1 `tools` keys. `agent-harness doctor` warns while a project still declares
`tools`; re-run `update` to convert it.
