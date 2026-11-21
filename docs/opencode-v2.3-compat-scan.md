# OpenCode V2.3 compatibility scan (F-006)

**Status:** in progress — evidence gathered, gap list being verified.
**Scope:** every harness surface that touches OpenCode (plugin hooks/API, config
keys, built-in tool names, CLI commands, store/telemetry, permissions/policies,
MCP, skills/commands, worktrees, child-session behavior) checked against the
**installed** OpenCode `v2.3.2` binary, its published `@opencode/*@2.3.2`
packages, and the V2 docs.

**Baseline in the repo:** the V2 port and its follow-ups were verified against
`opencode 2.0.29` / `2.0.31` and `@opencode/*@2.0.29` (see
[`opencode-v2-migration.md`](opencode-v2-migration.md)). The harness is 0.4.0.
This scan asks a different question: **what does 2.3.2 expose that the harness
pins, misses, or now gets wrong?**

## Method

1. Probe the installed binary (`opencode --version`, per-subcommand `--help`,
   `opencode debug paths`, `opencode debug config`).
2. Unpack the published `@opencode/plugin@2.3.2`, `@opencode/schema@2.3.2`,
   `@opencode/client@2.3.2` and read the `.d.ts` contracts.
3. Compare every harness plugin, template, script, and doc against those
   contracts.
4. File each confirmed gap as a backlog row; record non-gaps as "verified".

Reproduction of the package baseline:

```sh
mkdir -p /tmp/opencode/v2-audit && cd /tmp/opencode/v2-audit
npm pack @opencode/plugin@2.3.2 @opencode/schema@2.3.2 @opencode/client@2.3.2
```

## Evidence log

### Runtime

- `opencode --version` → `v2.3.2`.
- `opencode debug paths` → db at `~/.local/share/opencode/opencode.db`.
- Subcommands observed: `upgrade/update`, `uninstall`, `acp`, `api`, `debug`,
  `auth`, `mcp`, `plugin`, `models`, `stats`, `mini`, `run`, `session`,
  `service`, `reload`, `pair`, `serve`.
- `opencode plugin` is a first-class subcommand: `list`, `add`, `check`,
  `update`, `remove` (2.0.29 had no `plugin` subcommand).
- `opencode stats` is a first-class subcommand: `--days`, `--year`, `--all`,
  `--project`, `--models`, `--tools`, `--cost`, `--full`, `--json`.
- `opencode run` has `--worktree/-w [=name]`, `--fork`, `--title`,
  `--archived`, `--format`, `--thinking`, `--auto`, `--server`, `--standalone`.
- `opencode serve` exposes `--hostname`, `--port`, `--cors`, `--service`,
  `--stdio`.
- `opencode debug` exposes `agents`, `config`, `heap-dump`, `paths`.

### `@opencode/plugin@2.3.2` — Context surface

`Context` now exposes domains that did not exist in the 2.0.29 contract:
`app`, `location`, `options`, `agent`, `aisdk`, `command`, `credential`,
`event`, `experimental` (`terminal.read`, `generate`, `artifact`), `integration`,
`mcp`, `model`, `permission`, `plugin.list`, `provider`, `reference`, `rpc`,
`session`, `shell`, `skill`, `storage`, `tool`, `vcs`, `websearch`, `worktree`.

Notable additions the harness does not use: `worktree`, `vcs`, `skill`,
`command`, `agent`, `mcp`, `shell`, `model`, `provider`, `storage`, `rpc`,
`reference`, `integration`, `aisdk`, `websearch`, and the experimental
artifact/PTY/generate APIs.

### `tool` domain (2.3.2)

```ts
interface ToolDomain {
  readonly transform: Transform<ToolEditor>
  readonly reload: () => Promise<void>
  readonly list: () => Promise<readonly (Info & { id: string })[]>
  readonly hook: Hooks<ToolHooks>
}
```

- Hooks are still `execute.before` / `execute.after`, but the payload is richer:
  `{ tool, sessionID, agent, messageID, id, input }`, and `execute.after` also
  carries `status: "completed" | "error"` with `result` / `error`.
- `ToolEditor` supports `namespace(namespace)`, `add`, `update`, `remove`, and
  `list`/`get`.
- `ToolContext` (the tool `execute` context) now has `signal`, `progress`,
  plus the schema `Tool.Context` fields.

### `session` domain (2.3.2)

Hooks: `fork`, `prompt`, `context`, `compaction`, `generate`, `title`,
`experimental.model.resolve`, `model.request`, `http.request`,
`http.response`, `experimental.ws.handshake`, `experimental.ws.send`,
`experimental.ws.receive`, `retry`, `experimental.idle`.

- `SessionContext` is now the full request (`sessionID`, `model`, `system`,
  `messages`, `options`, `agent`, `tools`) — not just `{ sessionID, messages }`.
- `SessionRequestKind` is `"primary" | "compaction" | "title" | "generate"`,
  which makes auxiliary requests distinguishable without name-sniffing.
- `experimental.idle` reports background work (codemode, shell, subagent,
  image) — relevant to the harness's "session idle" logic.

### Plugin contract

`Plugin` is still `{ id, setup(ctx) }` and `define(plugin)` still exists, so the
harness's default-export object shape remains valid. Hook registration now
returns a `Registration` (`{ dispose }`) — a plugin can unregister individual
hooks without returning a whole-setup cleanup.

### `@opencode/schema@2.3.2` — config surface

The top-level config schema (`Config.Info`) now accepts:

| Key | Shape (2.3.2) | Harness uses it? |
|---|---|---|
| `model` | string **or** `{ providerID, model, variant }` | yes (string) |
| `default_agent` | string | no |
| `permissions` | array of `{ action, resource, effect }` (same) | yes |
| `policies` | array of `{ action, resource, effect }`, hard allow/deny over `provider.use`, `tool.use`, `integration.connect`, `integration.use`, `mcp.use`, `skill.use`, `plugin.use`, `websearch.use` | **no** |
| `agents` | map of agent overrides (same) | yes |
| `skills` | array of strings (skill paths) | no |
| `commands` | map of command definitions | no |
| `instructions` | array of strings (still in schema) | no (relies on `AGENTS.md`) |
| `mcp` | `{ timeout?, servers: { name: local|remote } }` (same) | yes |
| `plugins` | array of `string` or `{ package, options }` | no (auto-discovery) |
| `worktree` | `{ directory: string }` | no (harness has its own convention) |
| `references` | map of `string` / git / local refs | no |
| `websearch` | `false` or info | no |
| `warming` | boolean or info | no |
| `compaction` | info | no |
| `watcher`, `formatter`, `lsp`, `media`, `snapshots`, `tool_output`, `providers`, `experimental` | present | partially (`experimental.todo`) |

Two facts that directly affect the harness:

1. **`experimental.todo` still exists in 2.3.2** (line 71 of
   `config/experimental.d.ts`). F-005's todowrite enablement is still valid.
2. **`policies` is a real, top-level config key now** — with hard
   `provider.use` / `tool.use` / `mcp.use` / `skill.use` / `plugin.use` /
   `websearch.use` actions and `allow|deny` effects. The migration doc's
   remaining G12 ("optional policy hardening") can move from "unused lever" to a
   shipped default (e.g. hard-deny MCP tools globally, then allow per persona via
   `permissions`).

`experimental` also exposes `policies` (a duplicate of the top-level key),
`subagent_depth`, `location_idle_timeout`, `codemode_vm`, `schedules`,
`part_rows`, `image_generate`, `artifacts`, `automations`, `console_watches`,
`full_codemode`, `mcp_events`, `media_blob`, `todo`, `video_generate`.

### MCP

`ConfigMCP.Info` is still `{ timeout?, servers }`, so `mcp.servers` is
unchanged. The server union now carries a `protocol: "legacy" | "auto" |
"2026-07-28"` field (new, optional) — the harness's MCP docs and merge logic do
not mention it.

## Live runtime probe (2.3.2, this machine)

`GET /api/plugin?location[directory]=/home/ronen/develop/agent-harness` returned
all **11 harness plugins active**: `backlog-notify`, `backlog-tools`,
`checkpoint-tools`, `context-guard`, `diff-tools`, `gates-tools`, `job-notify`,
`orient-tools`, `session-tools`, `wait-tools`, `where-tools`.

The same response lists the built-in tool plugins, which confirms the 2.3.2
built-in tool set the harness must classify:

`shell`, `subagent`, `read`, `edit`, `write`, `glob`, `grep`, `question`,
`todo`, `skill`, `patch`, `webfetch`, `websearch`, `image-generate`, `artifact`,
`automation`.

`GET /api/skill?...` returns the skill catalogue (the `opencode` skill plus the
project's skills), so `.agents/skills`/`.opencode/skills` discovery still works.
`GET /api/agent?...` returns the resolved agents with their `permissions` array
(the build agent shows `steps: 120` and the project's 34 permission rules).
There is no `/api/tool` endpoint (404); tool names come from the plugin
manifest and the tool contract.

Store: the 2.3.2 DB contains `session`, `session_v2`, `message`,
`session_message`, `part`, `session_part`, `todo`, `worktree`, `permission`,
`event`, and `event_sequence`. `store-lib.js` reads `session_v2` +
`session_message`, so its path is intact (and `session_part` is now the V2
part table beside `session_message`).

## Verified — no gap

| Surface | Result |
|---|---|
| Plugin contract | `{ id, setup(ctx) }` / `define()` unchanged; all 11 plugins load and are active on 2.3.2. |
| Tool hooks | `execute.before` / `execute.after` unchanged; payload now adds `agent`, `messageID`, `id`. |
| Session hook call shapes | `ctx.session.prompt({ sessionID, text })` is still the `SessionPromptInput` shape (`{ sessionID, id?, text, files?, agents? }`). |
| `experimental.todo` | Still present in 2.3.2 — F-005's todowrite enablement remains valid. |
| Event names/payload | `session.created`, `session.deleted`, `session.step.ended`, `session.step.failed`, `session.execution.failed`, `session.renamed`, `session.compaction.*`, `filesystem.changed` all still exist; payload is still `event.data`. `session.created` now also carries `agent`, `model`, `permissions`, `parentID`. |
| Store/telemetry | `opencode debug paths` still yields the DB; `session_v2` + `session_message` still present. |
| MCP | `mcp.servers` + `timeout` unchanged. |
| Skills/commands | Skill catalogue resolves; command discovery remains config/markdown based. |
| Child sessions | `parentID` still on `session.created`; child session APIs unchanged. |
| Model-variant rule | `model` still accepts `provider/model#variant`; config also accepts an object `{ providerID, model, variant }`. |
| Permissions | Ordered `{ action, resource, effect }` array unchanged; `effect` now also accepts `"ask"`. |

## Confirmed gaps (filed as backlog rows)

| # | Surface | Gap | Priority |
|---|---|---|---|
| G1 | Permissions/policies | The harness has no managed `policies` defaults. 2.3.2 ships a real top-level `policies` key (hard `allow|deny` over `provider.use`, `tool.use`, `mcp.use`, `skill.use`, `plugin.use`, `websearch.use`). A project `permissions` allow can still shadow a harness credential/MCP deny — the exact remaining item from migration-doc §19 G12. | P2 |
| G2 | Built-in tools | The guard/session classifiers predate the 2.3.2 tool set (`todo`, `skill`, `question`, `webfetch`, `websearch`, `patch`, `artifact`, `automation`, `image-generate`). `EXEMPT_TOOLS` has `todowrite` but not `todo`; `MATERIAL_TOOLS` has no `skill`/`artifact`. Verify the effective names, then align the classifiers + drift guard. | P3 |
| G3 | Worktrees | 2.3.2 adds `worktree.directory`, `ctx.worktree` (`transform`/`add`/`list`/`create`/`remove`) and `opencode run --worktree [=name]`. The harness still shells out to `git worktree` under its own `../.worktrees/<repo>/<id>` convention. Decide whether to adopt the native config/CLI or document the deliberate divergence. | P3 |
| G4 | CLI/docs | `opencode plugin` (`list/add/check/update/remove`) and `opencode stats` (`--tools/--cost/--json`) are first-class in 2.3.2 and absent from the harness docs; config also gained `plugins` and MCP servers gained `protocol`. | P4 |
| G5 | Telemetry | `opencode stats --json` is a new independent oracle for agent-report/store-lib. The harness reads the DB directly; adopting the CLI output as a cross-check would catch store-shape drift. | P4 |

## Remaining follow-ups (not gaps)

- The migration doc (`opencode-v2-migration.md`) remains the 2.0.29/2.0.31
  record; this scan is the 2.3.2 delta. Keep both, do not rewrite history.
- 2.3.2's new session hooks (`fork`, `compaction`, `title`, `retry`,
  `experimental.idle`) and event families (`session.idle`, `session.status`,
  `session.shell.*`, `session.tool.*`) are unused by the harness. They are
  opportunities, not compatibility breaks: the harness's pinned subset still
  works.
- A live `opencode run` probe is not included here because it would start a
  model session; the service probe above already exercised plugin registration
  and the agent/skill APIs against the real 2.3.2 runtime.

## How to re-run

```sh
opencode --version                                  # expect 2.3.2
opencode api get '/api/plugin?location[directory]=<repo>'
opencode api get '/api/agent?location[directory]=<repo>'
opencode api get '/api/skill?location[directory]=<repo>'
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.env.HOME+'/.local/share/opencode/opencode.db',{readOnly:true});console.log(db.prepare(\"select name from sqlite_master where type='table'\").all())"
```
