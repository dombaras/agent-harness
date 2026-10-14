# OpenCode V2 migration — change spec (harness 0.1.157 / 0.1.158)

**Status:** shipped to `main` and deployed. This document is the review artifact for
that migration — read it before touching the plugin/tool layer again.

**Goal:** make `@dombaras/agent-harness` work under **OpenCode V2** (verified against
`opencode 2.0.29`). V2 has three intentional breaking changes over V1 — a new
**plugin API**, a new **server API/clients**, and terminal config moving to
`cli.json` — and **V1 plugin implementations do not run in V2**. The harness's
entire plugin/tool layer was V1 (`@opencode-ai/plugin`), so under V2 its tools and
hooks were silently dead.

**Decisions taken (confirmed with the requester up front):**

1. **Full native V2 conversion** — config, agents, commands, plugins, tools all move
   to the native V2 shapes (not just "keep the V1 shapes V2 still tolerates").
2. **V2-only** — no dual V1/V2 plugin exports. V1 support is dropped; V1 users stay
   on the prior release.

**Sources of truth used:** <https://opencode.ai/v2/docs/migrate-v1>,
<https://opencode.ai/v2/docs/build/plugins>,
<https://opencode.ai/v2/docs/build/plugins/migrate-v1>,
<https://opencode.ai/v2/docs/config>, `/permissions`, `/agents`, `/commands`,
`/skills`, `/instructions`, `/tools`; and the published packages
`@opencode/plugin@2.0.29` / `@opencode/client@2.0.29` / `@opencode/ai@2.0.29` /
`@opencode/schema@2.0.29` (unpacked to read the exact `.d.ts` types).

---

## 0. Commits

| Commit | Version | Contents |
|---|---|---|
| `3370906` | 0.1.157 | The migration: config, agents, commands, plugins, tools, CLI, gates, tests, docs. |
| `ecdd413` | 0.1.158 | V1→V2 `opencode.json` convergence on `update` (`mergeOpencodeJson`) + `convertV1Permission` + a test. |
| _(this doc)_ | — | `docs/opencode-v2-migration.md` (docs-only; no version bump — it touches neither `bin/` nor `templates/`). |

Change size: 60 files, +2347 / −1537 (0.1.157) plus 3 files, +103 / −12 (0.1.158).

---

## 1. Compatibility matrix (at a glance)

| Surface | V1 (before) | V2-native (after) | V2 still accepts V1? |
|---|---|---|---|
| Plugins | `@opencode-ai/plugin`, object of string-keyed hooks | `@opencode/plugin`, default export `{ id, setup(ctx) }`, domain hooks/transforms | No (V1 plugins don't run) |
| Custom tools | `.opencode/tools/*.ts` exporting `tool()` | registered inside a plugin via `ctx.tool.transform((editor) => editor.add(...))` | No |
| Config model routing | `model` + `small_model` | `model` + `agents.title.model` | `small_model` normalized |
| Agent overrides | singular `agent` map | `agents` map | normalized |
| Permissions | keyed `permission` map | ordered `permissions` array | normalized |
| Instruction files | `instructions: [...]` | `AGENTS.md` (V2 does **not** resolve `instructions`) | accepted, **ignored** |
| Agent frontmatter | `permission`, `variant`, `temperature` | `permissions`, `model#variant`, `request.body` | auto-translated |
| Commands | `.opencode/command/` | `.opencode/commands/` | both discovered |
| Skills | `.opencode/skills/` | `.opencode/skills/` **and** `.agents/skills/` | both discovered |
| Tool names | `bash`, `task` | `shell`, `subagent` | n/a (V2 names) |
| MCP | `mcp.<name>` | `mcp.servers.<name>` | `mcp` recognized |

---

## 2. Config — `templates/opencode.json` (and the repo's own `opencode.json`)

Rewritten to the native V2 shape. Both the template (deployed) and the harness repo's
own root `opencode.json` were converted — the template uses `{{WORKSPACE_ROOT}}`, the
repo root uses the literal `/home/ronen/develop/**`.

**Before (V1):**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/deepseek-v4.1-flash",
  "small_model": "opencode-go/glm-5.3-flash",
  "instructions": [".agents/rules/00-operating.md"],
  "agent": { "build": { "steps": 100 }, "explore": { "model": "opencode-go/glm-5.3-flash", "steps": 40 } },
  "permission": {
    "external_directory": { "{{WORKSPACE_ROOT}}/**": "allow", "~/.ssh/**": "deny", /* … */ },
    "edit": { "~/.config/opencode/**": "deny", /* … */ },
    "bash": { "sudo *": "deny", "rm -rf /*": "deny", /* … */ }
  }
}
```

**After (V2):**

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "opencode-go/deepseek-v4.1-flash",
  "agents": {
    "title":   { "model": "opencode-go/glm-5.3-flash" },   // was small_model
    "build":   { "steps": 100 },
    "explore": { "model": "opencode-go/glm-5.3-flash", "steps": 40 }
  },
  "permissions": [
    { "action": "external_directory", "resource": "{{WORKSPACE_ROOT}}/**", "effect": "allow" },
    { "action": "external_directory", "resource": "~/.ssh/**", "effect": "deny" },
    { "action": "edit", "resource": "~/.config/opencode/**", "effect": "deny" },
    { "action": "shell", "resource": "sudo *", "effect": "deny" }
    /* …one rule per V1 key; allows first, denies after (V2: last match wins) */
  ]
}
```

Notes:
- `instructions` is dropped: V2 accepts the key but **does not resolve** it (documented
  in the V2 instructions guide). See §7 for where the always-loaded rules went.
- `bash` action → `shell`. `write`/`patch` fold into the `edit` action.
- V1 `external_directory` allow/deny entries became `external_directory` rules; the
  ordering (allows, then denies) is preserved so "last match wins" keeps the credential
  denies authoritative.

---

## 3. Agents — `templates/.opencode/agents/*.md` (15 files)

Mechanical V1→V2 frontmatter conversion (done by a one-off script, then reviewed):

| V1 | V2 |
|---|---|
| `model: X` + `variant: V` | `model: X#V` |
| `temperature: T` | `request:` → `body:` → `temperature: T` |
| `permission:` keyed map | `permissions:` ordered list of `{ action, resource, effect }` |
| `permission.bash` | `action: shell` |
| `steps:`, `hidden:`, `mode:`, `description` | unchanged (already V2 field names) |

**Resulting model + permission pins** (extracted from the shipped files):

| Agent | `model` | steps | hidden | request.body | permissions |
|---|---|---|---|---|---|
| `data-engineer` | `opencode-go/deepseek-v4.1-flash#low` | 40 | | | edit `*` allow; edit `opencode.json`/`.harness.json`/`.opencode/**`/`.agents/**` deny; shell `*` allow |
| `devops-engineer` | `opencode-go/deepseek-v4.1-flash#low` | 40 | | | same as data-engineer |
| `diagnostics-expert` | `opencode-go/deepseek-v4.1-flash#low` | 30 | | `temperature: 0.1` | same as data-engineer |
| `docs` | `opencode-go/gpt-5.6-luna` | 20 | | `temperature: 0.1` | edit `*` allow + governance denies; shell `*` **deny** |
| `features` | `opencode-go/gpt-5.6-luna` | 15 | ✓ | `temperature: 0.1` | shell `*` deny |
| `frontend-engineer` | `opencode-go/deepseek-v4.1-flash#low` | 40 | | | same as data-engineer |
| `handoff` | `opencode-go/glm-5.3-flash` | 10 | ✓ | `temperature: 0.1` | shell `*` deny |
| `mobile-engineer` | `opencode-go/deepseek-v4.1-flash#low` | 40 | | | same as data-engineer |
| `planner` | `deepseek/deepseek-v4-pro` | 15 | ✓ | `temperature: 0.1` | edit `*` deny; allow `.agents/features/*/plan.md`, `../.worktrees/**/.agents/features/*/plan.md`; shell `*` deny |
| `product-manager` | `opencode-go/gpt-5.6-luna` | 20 | | | edit `*` deny; allow `.agents/features/*/intent.md`, `../.worktrees/**/…/intent.md`; shell `*` deny |
| `qa-architect` | `deepseek/deepseek-v4-pro` | 20 | | `temperature: 0.1` | shell `*` deny |
| `qa-runner` | `opencode-go/deepseek-v4.1-flash#low` | 50 | | `temperature: 0.1` | (none) |
| `security-engineer` | `deepseek/deepseek-v4-pro` | 30 | | | same as data-engineer |
| `system-architect` | `deepseek/deepseek-v4-pro` | 40 | | | same as data-engineer |
| `ui-designer` | `opencode-go/gpt-5.6-luna` | 40 | | | same as data-engineer |

Example (`data-engineer.md`):

```yaml
---
description: Use for catalog/data ingestion and entity resolution — …
mode: subagent
steps: 40
model: opencode-go/deepseek-v4.1-flash#low
permissions:
  - action: edit
    resource: "*"
    effect: allow
  - action: edit
    resource: "opencode.json"
    effect: deny
  - action: edit
    resource: ".harness.json"
    effect: deny
  - action: edit
    resource: ".opencode/**"
    effect: deny
  - action: edit
    resource: ".agents/**"
    effect: deny
  - action: shell
    resource: "*"
    effect: allow
---
```

> **Review note:** V2 `request.body` values are *preserved but not yet sent* with model
> requests (documented V2 warning). `temperature: 0.1` therefore currently has no
> runtime effect in V2 — kept for forward-compat and to record intent.

---

## 4. Commands — `.opencode/command/` → `.opencode/commands/`

Pure rename (git-rename, 8 files, contents unchanged): `board`, `checkpoint`,
`feature`, `finish`, `next`, `report`, `resume`, `switch-model`. V2 discovers both the
singular and plural dirs, so the deploy also **removes the stale singular dir** (§8).

---

## 5. Plugins — V2 API port (`templates/.opencode/plugins/`, `contrib/global-plugins/`)

V1 shape → V2 shape (all four plugins):

```ts
// V1
import type { Plugin } from "@opencode-ai/plugin"
export const X: Plugin = async ({ directory, client }) => ({ "hook.name": async (input, output) => {} })

// V2
import type { Context } from "@opencode/plugin"      // type-only; erased at runtime
export default { id: "stable-id", async setup(ctx: Context) { /* register */ return () => {} } }
```

- **Default-export a plain object literal `{ id, setup }`** (that is exactly what
  `Plugin.define` returns). `import type` only — no runtime dependency on
  `@opencode/plugin`, so the files load with Node's type stripping and under Bun.
- No `client`: `client.app.log` → `console.log`/`console.warn`; `client.tui.showToast`
  → **dropped** (a server plugin has no TUI in V2).
- `directory` → `ctx.location.directory`. `client.session.promptAsync` →
  `ctx.session.prompt({ sessionID, text })`.

| Plugin | V1 hooks | V2 registration |
|---|---|---|
| `backlog-notify` | `tool.execute.after` | `ctx.tool.hook("execute.after", …)`; logs `Backlog: …` |
| `job-notify` | `tool.execute.before/after` + timers | both `ctx.tool.hook(...)`; `wake()` → `ctx.session.prompt`; setup returns a cleanup that clears all watch timers |
| `harness-freshness` (global) | `event`, `experimental.chat.messages.transform` | `ctx.event.subscribe({signal})` loop in `setup`; `ctx.session.hook("context", …)`; returns `() => controller.abort()` |
| `context-guard` | see §5.1 | see §5.1 |

### 5.1 `context-guard.ts` (the intricate one)

The plugin keeps its existing V1-shaped hook **bodies** (so the pure, heavily tested
`scripts/qa/context-guard-core.js` contract is unchanged) and drives them through thin
V2 adapters registered in `setup`:

- `ctx.tool.hook("execute.before", e => hooks["tool.execute.before"]({ tool: e.tool, sessionID: e.sessionID }, { args: e.input }))`
  — mutating `e.input` (the tool args) still reroots `workdir`/`command`; a thrown
  error still aborts the call.
- `ctx.tool.hook("execute.after", e => hooks["tool.execute.after"]({…}, v1Result(e)))`
  where `v1Result` maps `{status,result|error}` → the V1 `{args,status,error,output,metadata}`.
- `ctx.session.hook("context", onContext)` replaces
  `experimental.chat.messages.transform`: `onContext` reads `event.sessionID` directly
  (no scanning) and appends `{ id: GUARD_MESSAGE_ID, role: "user", content: [{type:"text",text}], metadata:{synthetic:true} }`
  to `event.messages`, updating in place when the last message is already the guard msg.
- `ctx.event.subscribe({ signal })` replaces the `event` hook; sessions are swept on
  unload via the returned cleanup.
- **Tool-name renames:** a local `isShell()` accepts `bash` **or** `shell` everywhere the
  guard inspects the shell tool; `EDIT_TOOLS` already covered `edit`/`write`/`patch`.
- **Dropped:** the `permission.ask` hook. V2 removed the `doom_loop` permission action,
  so the runtime's own identical-call guard is no longer mirrored by the plugin (the
  plugin's own identical-call counter is unaffected).

---

## 6. Tools → plugins (`templates/.opencode/plugins/*.ts`, 7 files)

V2 has no `.opencode/tools/` discovery and no `tool()` helper. Each old tool file
became a plugin that registers its tool(s) by **explicit name** via a synchronous
`ctx.tool.transform`:

```ts
export default {
  id: "backlog-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "backlog_list",
        description: "…",
        input: { type: "object", properties: { limit: { type: "string", description: "…" } }, required: [], additionalProperties: false },
        async execute(input, context) {
          return { content: toolLib.runScript({ directory, sessionID: context.sessionID, agent: context.agent }, "scripts/backlog.js", argv, opts) }
        },
      })
    })
  },
}
```

- Zod args → plain **JSON Schema**; `execute(input, context)` returns `{ content }`.
- V2's tool-execution `context` has **no `directory`/`worktree`** (only
  `sessionID`/`agent`/`messageID`/`id`/`signal`), so each plugin captures
  `ctx.location.directory` in `setup` and feeds `{ directory, sessionID, agent }` to
  `scripts/qa/tool-lib.js` (`sessionRoot` still reroots to a mid-session worktree pointer).

**Exact tool names preserved** (the harness prose/tests depend on them):

- `backlog.ts` → `backlog_list`, `backlog_add`, `backlog_take`, `backlog_queue`,
  `backlog_next`, `backlog_archive`, `backlog_freeze`, `backlog_epic`,
  `backlog_epic_add`, `backlog_worktree`, `backlog_depends`, `backlog_owns`
- `checkpoint.ts` → `checkpoint_write`, `checkpoint_resume`
- `session.ts` → `session_info`
- `orient.ts` → `orient` · `gates.ts` → `gates` · `wait.ts` → `wait` · `where.ts` → `where`

Old files **deleted:** `templates/.opencode/tools/{backlog,checkpoint,gates,orient,session,wait,where}.ts`.

---

## 7. Always-loaded rules (`instructions` → `AGENTS.md`)

Because V2 ignores `instructions`, the deployed `AGENTS.md` is now the always-loaded
project instructions. `templates/AGENTS.md` line 3 was reworded to say so and to point
at the expanded rules (`.agents/rules/00-operating.md`) and the rulebook
(`.agents/AGENTS.md`) — both of which V2 **auto-discovers** as it works under `.agents/`.
The prefix size gate budget is unchanged (the file stays ≤ 10240 bytes).

Also corrected V2 tool-name references in the rulebook/rules summary: `` `task` tool ``
→ `` `subagent` tool ``, `` bash `workdir` `` → `` `shell` tool's `workdir` ``; MCP
guidance changed from the V1 `"tools": { "<server>*": false }` disable to a
`<server>_*` rule in `permissions`.

---

## 8. CLI — `bin/agent-harness.js`

1. **`mergeOpencodeJson`** (rewritten):
   - `agents` ADD-ONLY per agent (project values win) instead of the V1 `agent` map.
   - `permissions` array **union** (harness baseline first, project rules appended so
     they win a collision, exact duplicates dropped) instead of the keyed `permission`.
   - `mcp` deep-merge now targets **`mcp.servers`** by server name.
   - `instructions` union removed; the harness's own `instructions` entry is filtered out.
2. **V1→V2 convergence** (0.1.158): on `update`, an existing V1 `opencode.json` is
   migrated — `small_model` → `agents.title.model`, singular `agent` → `agents`, keyed
   `permission` → `permissions` (via new `convertV1Permission`, mapping `bash`→`shell`,
   scalar action values → `resource: "*"`), then the V1 keys are deleted. This is why
   the deployed projects have no `small_model`/`agent`/`permission`/`instructions` keys.
3. **Obsolete-file pruning** (`pruneObsoleteHarnessFiles`): `update` removes the 7 old
   `.opencode/tools/*.ts` and the 8 legacy `.opencode/command/*.md`, then prunes the
   dirs if empty. A deploy cannot see a deleted template, and V2 *still discovers* the
   legacy `command/` dir — so without this the old command text would shadow the new
   `commands/`. Only files the harness itself shipped are removed (a project-added file
   is left alone). Removals are staged in the auto-commit as `remove-obsolete`.
4. `module.exports` no longer exports `mergePermission`; summary prints a
   "removed (obsolete)" count; header comment updated.

---

## 9. Gates & scripts

- **`scripts/qa/check-dispatch-config.js`** (`test:dispatch`): strips a `#variant` suffix
  before allowlist matching; reads `model` + `agents.title.model` + every
  `agents.<name>.model` (was `small_model`/`agent.*.model`); "shell-enabled editor"
  detection is now a parsed V2 `permissions` shell-allow rule (was the `bash: "*": allow` regex).
- **`scripts/qa/context-guard-core.js`**: `EXEMPT_TOOLS`/`MATERIAL_TOOLS` accept
  `subagent` alongside `task`; `isMaterial` and `fundsArmText` accept `shell` alongside
  `bash`. (Both names accepted to keep core tests stable.)
- Comment/path touch-ups: `scripts/backlog.js`, `scripts/orient.js`,
  `scripts/qa/tool-lib.js`, `scripts/qa/run-loop.js`
  (`.opencode/tools/…` → `.opencode/plugins/…`, `.opencode/command/next.md` → `.opencode/commands/next.md`).
- **`test:prefix`** unchanged in behavior; `AGENTS.md` text was trimmed to stay under budget.

---

## 10. Behavior changes you can observe

| Change | Why | Impact |
|---|---|---|
| Board/notify toasts gone | no TUI in a V2 server plugin | board mutations + E2E progress still go to the **log**; `job-notify` still wakes the session via `ctx.session.prompt` |
| `doom_loop` mirror gone | V2 removed the permission action | the plugin's own loop detector still nudges; the built-in guard no longer adds a notice |
| `temperature: 0.1` no-op | V2 preserves `request.body` but does not send it yet | deterministic personas still run at default temperature until V2 wires it |
| `AGENTS.md` is now the always-loaded file | V2 ignores `instructions` | rules still loaded; `.agents/rules/00-operating.md` & `.agents/AGENTS.md` are auto-discovered as the agent works under `.agents/` |
| `.agents/skills/*` now skills | V2 discovers `.agents/skills` | persona skills are also advertised via the `skill` tool (was read-only files) |
| Legacy V1 files removed on update | avoid stale `command/` shadowing | project keeps only `.opencode/{agents,commands,plugins,skills}` |

---

## 11. Tests — `tests/agent-harness.test.js` (423 tests, all green)

- Config tests rewritten the config-merge tests to the V2 shape (`agents`, `permissions`
  array, `mcp.servers`) + added a **V1→V2 convergence** test.
- Added a **prune** test (`update prunes the V1 obsolete layout`).
- Agent frontmatter assertions rewritten to V2 `permissions` syntax; model assertions
  accept the `#variant` suffix.
- `test:dispatch`/`test:prefix` assertions updated (`agents.explore.model`, etc.).
- The context-guard simulation tests were rewritten around a new
  **`loadGuardPlugin()`** helper (a fake `ctx` that records the registered V2 hooks and
  exposes `emit`/`toolBefore`/`toolAfter`/`context` drivers), replacing direct V1
  `plugin["tool.execute.before"](…)` calls. All guard scenarios (tail injection, orient,
  tool-block, branch-switch, main-checkout, reroute, hygiene) still asserted.

---

## 12. Docs

- `README.md`: added a V2-native banner; updated the file table (`.opencode/plugins/*`,
  `.opencode/commands/*`), the merge section, the model-routing/permission prose, and
  the worktree `permissions` note.
- `templates/docs/mcp-integrations.md`: V2 example (`mcp.servers`, `disabled`, a
  `pg_*` deny in `permissions` + per-agent allow).
- `docs/mcp-skills-backlog.md` + `docs/open-work.md`: path/field touch-ups.
- Historical point-in-time docs (`docs/backlog-integrity-fixes.md`,
  `docs/cost-optimization-recommendations-*.md`,
  `docs/optimization-implementation-status.md`, `docs/adr-board-service.md`) were
  **left as-is** — they record past state. Flag if you want them swept too.

---

## 13. Verification performed

- `npm run lint` green; `npm test` **423/423** green on the harness.
- Deployed to **LibraryOS** (`~/develop/PublicVirtualLibrary`; committed + pushed) and
  **FamilyBudget** (`/mnt/c/develop/FamilyBudget`; no remote, push skipped). Both
  `.harness.json` at **0.1.158**.
- Post-deploy check in LibraryOS: no `small_model`/`agent`/`permission`/`instructions`
  keys; `agents.title.model` present; 34 `permissions`; `.opencode/{agents,commands,plugins,skills}`
  with `tools/`+`command/` gone; `context-guard` plugin loads and default-exports `id`.
- Ran the migrated project's own gates: **`test:dispatch` 0 failures**;
  **`test:prefix` 0 volatile values, within budget**.
- All harness plugins use **`import type` only** — no runtime `@opencode/*` resolution is
  required (the project `.opencode/node_modules` still holds the old `@opencode-ai/plugin`,
  which is now unused).

---

## 14. Known limitations & follow-ups

1. **Live plugin execution is unverified end-to-end.** Tests load the plugin modules and
   drive their hooks with a fake `ctx`; the real OpenCode V2 loader was not exercised
   from this session. **Restart OpenCode** and confirm the `context-guard`/tool plugins
   appear in the active plugin list and the `backlog_*` tools work.
2. **Two LibraryOS worktrees did not fast-forward** and were left manual:
   - `~/develop/.worktrees/PublicVirtualLibrary/f-064` — dirty `.agents/handoffs/F-064.md`
     blocks `merge --ff-only origin/main` (commit/stash first).
   - `~/develop/.worktrees/PublicVirtualLibrary/f-343` — diverged (8 ahead / 1 behind);
     needs a rebase onto `origin/main`.
   The other five worktrees (F-264, f-329, f-333, f-339, nightly) fast-forwarded.
3. **Stale `.opencode/package.json`** exists in deployed projects
   (`@opencode-ai/plugin` dependency). It is project-side (not harness-owned), unused in
   V2, and deliberately untouched. Consider removing it project-by-project if V2 warns.
4. **`mcp` disable guidance** now uses a `permissions` action wildcard (`<server>_*`).
   Confirm against your V2 build that action wildcards match MCP tool actions as
   documented; if not, switch to per-tool deny rules.
5. **V2-only**: projects still on V1 cannot take this release (their plugins won't load
   the new files, and the config is now V2-native). V1 users stay on 0.1.156.
6. `services/board` was **not** touched — it is a standalone Next.js HTTP service, not
   the OpenCode server API.

---

## 15. Review checklist (what to scrutinize next session)

- [ ] Restart OpenCode and confirm the four plugins + seven tool plugins load.
- [ ] `node bin/agent-harness.js list` shows the per-persona `model#variant` pins.
- [ ] `agent-harness doctor --target <project>` is clean for both projects.
- [ ] Confirm the `permissions` order in a deployed `opencode.json` still yields the
      intended last-match-wins result (credential denies after the work-root allow).
- [ ] Confirm `agents.<name>.permissions` behavior matches the old `permission` map
      (especially the planner/product-manager narrow write grants).
- [ ] Decide whether to drop the now-unused `temperature`/`request.body` or keep it for
      when V2 sends request bodies.
- [ ] Decide whether to sweep the historical docs (§12).
- [ ] Resolve the two manual worktrees (§14.2).
