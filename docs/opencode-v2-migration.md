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
| `diagnostics-expert` | `opencode-go/deepseek-v4.1-flash#low` | 30 | | | same as data-engineer |
| `docs` | `opencode-go/gpt-5.6-luna#low` | 20 | | | edit `*` allow + governance denies; shell `*` **deny** |
| `features` | `opencode-go/gpt-5.6-luna#low` | 15 | ✓ | | shell `*` deny |
| `frontend-engineer` | `opencode-go/deepseek-v4.1-flash#low` | 40 | | | same as data-engineer |
| `handoff` | `opencode-go/glm-5.3-flash#low` | 10 | ✓ | | shell `*` deny |
| `mobile-engineer` | `opencode-go/deepseek-v4.1-flash#low` | 40 | | | same as data-engineer |
| `planner` | `deepseek/deepseek-v4-pro` | 15 | ✓ | | edit `*` deny; allow `.agents/features/*/plan.md`, `../.worktrees/**/.agents/features/*/plan.md`; shell `*` deny |
| `product-manager` | `opencode-go/gpt-5.6-luna` | 20 | | | edit `*` deny; allow `.agents/features/*/intent.md`, `../.worktrees/**/…/intent.md`; shell `*` deny |
| `qa-architect` | `deepseek/deepseek-v4-pro` | 20 | | | shell `*` deny |
| `qa-runner` | `opencode-go/deepseek-v4.1-flash#low` | 50 | | | (none) |
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

> **Review note (superseded in §17):** V2 `request.body` values are *preserved but not
> sent* with model requests (documented V2 warning), so the migrated `temperature: 0.1`
> had no runtime effect. §17 removed the blocks and expressed the intended determinism
> as a **model variant** instead: the mechanical/fast personas (`docs`, `features`,
> `handoff`, plus the already-`#low` `diagnostics-expert`/`qa-runner`) pin `#low`, while
> the Pro architect tier (`planner`, `qa-architect`) keeps full reasoning effort with no
> variant, matching their `system-architect`/`security-engineer` siblings.

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
| `temperature: 0.1` no-op removed | V2 preserves `request.body` but does not send it, so the value was dead config | the intent moved to a **model variant** (`#low`) on the mechanical personas; the Pro architect tier keeps full reasoning (no variant) |
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
- **Not verified here (found 2026-10-14):** the plugin **event stream**. These checks cover
  **load** and **config gates**, not event behaviour. The port carried the V1 event contract
  (`event.properties`, `message.updated`, `file.watcher.updated`, `session.error`) into the
  V2 `ctx.event.subscribe()` loop, so the guard's session/telemetry half and the global
  `harness-freshness` safety net were silently dead, and the test suite missed it because its
  fake stream still emitted the V1 shape. Fixed in **§17** (0.1.160).

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

---

## 16. Post-review pass (0.1.159)

A second full review of the port (2026-10-14) verified the migration against the real
V2 runtime and the published `@opencode/*@2.0.29` types, and turned §15 into findings.
Outcome and fixes:

**Verified good (no change):**
- `npm run lint` green; `npm test` **424/424** (the V1→V2 converge/prune tests included).
- Deployed projects resolve correctly under V2: agents discover with their
  `model#variant` pins (22 agents in LibraryOS), the `permissions` precedence is
  global → project → agent with last-match-wins, and credential denies sit *after* the
  work-root allow. `test:dispatch` / `test:prefix` green in the project.
- The 10 project plugins load with the real loader and correct ids.

**Corrections to the previous review's findings:**
- The `v1Result` "error → `[object Object]`" claim is **wrong**. `event.error` is a
  `Tool.Error` (an `Error` subclass), so `String(it)` yields `"Tool.Error: <message>"`;
  the same-failure signature keeps the message. A new test (§11, `execute.after`
  adapter) now locks this so a future change cannot silently collapse it.
- The global `harness-freshness.ts` "load failure" is the **long-running server that
  started before the port** memoizing the V1 load error, not the file. A fresh server
  loads it clean; `opencode service restart` clears it.

**Fixes shipped in 0.1.159:**
1. `templates/opencode.json` (and the repo's own `opencode.json`): `*` matches `/` in a
   V2 shell pattern, so the `rm -rf /*` deny also blocked `rm -rf /tmp/…` (reproduced
   live). Added a later `rm -rf /tmp/*` allow so absolute temp scratch cleanup works
   while `rm -rf /`, `rm -rf /usr`, `rm -rf ~`, `rm -rf ~/*` stay denied.
2. Doc/prose drift the port trimmed elsewhere but missed:
   `templates/.agents/skills/features/SKILL.md` (`task` tool → `subagent`),
   `templates/docs/mobile-testing.md` + `templates/scripts/qa/mobile-e2e/job-events.js`
   (`session.promptAsync` → `session.prompt`), `README.md`
   (`experimental.chat.messages.transform` → the V2 `context` session hook), and a
   `context-guard-core.js` comment.
3. `tests/agent-harness.test.js`: a `tool.execute.after` error-path test (the adapter
   was previously untested).

**Also actioned (outside the repo):** removed the leftover duplicate
`~/.config/opencode/plugins/zz-global-test.ts` (a byte-identical copy of
`harness-freshness.ts`, which double-ran the freshness check); migrated the machine
config `~/.config/opencode/opencode.jsonc` from the V1 `permission` map to a V2
`permissions` array; removed the stale `.opencode/package.json`
(`@opencode-ai/plugin`) from the projects; re-synced the `f-064` / `f-343` worktrees
(§14.2).

**Still open:** `request.body`/`temperature` is a documented V2 no-op (§3, §10);
historical docs are intentionally left as-is (§12).

**Correction (0.1.160):** "the 10 project plugins load with the real loader and correct
ids" verified **registration**, not **event behaviour**. The event stream was still
V1-shaped (it loaded and returned an id, then ignored every event); see §17.

---

## 17. Event-stream remap (0.1.160)

The 0.1.157 port moved the plugin `event` hook to `ctx.event.subscribe()` but carried the
**V1 event contract** (event *names* and the `event.properties` payload) across unchanged.
V2's server API is one of the three documented breaking changes, so this was in-scope for
the port; it silently disabled the `context-guard` session/telemetry half (`writeLease` at
session start, `clearLease`/`syncBoard`/`collectOrient`, subagent child tracking, turn/band
/request telemetry, funds arming from session errors) and the whole `harness-freshness`
safety net. The suite missed it because `loadGuardPlugin()`'s fake stream emitted the V1
shape. Findings isolated live against OpenCode **2.0.29** and the published
`@opencode/@2.0.29` types.

**The V2 event envelope has no `properties`.** It is
`{ id, created, type, durable?, location, data }`: the payload is **`event.data`**
(`event.properties` is always `undefined`). The event *names* changed too:

| V1 name (used until 0.1.159) | V2 name | Note |
|---|---|---|
| `session.created` | `session.created` | same name, different payload (`data.sessionID`; a child carries `data.parentID`) |
| `session.updated` | *(gone)* | a child's `parentID` arrives on `session.created` |
| `session.deleted` | `session.deleted` | `data.sessionID` |
| `message.updated` | *(gone)* | use `session.step.ended` / `session.usage.updated` |
| `file.watcher.updated` | `filesystem.changed` | nominal rename; **not observed firing** even on real add/change/unlink — not relied on |
| `session.error` | `session.execution.failed` (and `session.step.failed`) | `data.sessionID`, `data.error` |

**Fixes:**
1. `templates/.opencode/plugins/context-guard.ts` — `hooks.event` reads `event.data` and the
   V2 names. `session.step.ended` (`data.tokens` is exactly the `TokenUsageInfo` the core
   already reads) is the V1 `message.updated` analogue: one model call == one orchestrator
   turn. A child's `session.created` omits `model`, so the per-step model comes from
   `session.step.started`; a new `modelFields()` maps the V2 `ModelRef`
   (`{id, providerID, variant}`) to the `{providerID, modelID}` `modelLabel` reads.
2. **Threshold reload without the watcher.** `loadThresholds()` is now mtime-aware
   (`statSync`), replacing the dead `file.watcher.updated` cache-bust. `filesystem.changed`
   was **not** wired: it exists in the manifest but did not fire in a probe, so the guard
   must not depend on it.
3. **Funds release on real user input.** V1 released the stop on a `message.updated`
   `role:"user"`. In V2 that branch is gone; the new `ctx.session.hook("prompt", …)` clears
   `fundsPending` for a **primary** session only (synthetic/shell/compaction submissions do
   not fire it, and a child's prompt cannot clear the orchestrator's stop).
4. `contrib/global-plugins/harness-freshness.ts` — reads `event.data`, skips children via
   `data.parentID`, and uses `data.location.directory`.
5. **Tests:** the `loadGuardPlugin()` fixtures now emit V2 payloads; a new
   **`[drift-guard]`** test fails any `event.subscribe` plugin that reads `event.properties`
   or names a V1 event (this is the guard that would have caught the original bug); new tests
   cover the V2 lease/child path and the `prompt`-hook funds release.
6. **`convertV1Permission`** now maps every renamed V1 action (`bash→shell`, `write`/
   `patch→edit`, `task→subagent`), not just `bash`.
7. **Persona skills** carry `metadata: { opencode/autoinvoke: false }` so the 15
   persona `SKILL.md` files stay registered/loadable by ID but leave the model's advertised
   skill list (they are persona definitions read with `read`/`grep`, never `skill`-tool
   targets). `dev-loop`/`bounded-explore` stay advertised.
8. Per-agent `request.body.temperature` (a documented V2 no-op) was removed from the 7
   agent files that carried it, and the intended determinism was expressed as a **model
   variant**: `docs`, `features` and `handoff` now pin `#low` (joining the already-`#low`
   mechanical tier), while `planner`/`qa-architect` keep full reasoning effort on
   `deepseek/deepseek-v4-pro` (no variant) to match their architect-tier siblings.
9. **Turn-count caveat resolved — no auxiliary-step filter needed.** The plan flagged a
   risk that `session.step.ended` might fire for title/compaction steps and inflate the
   orchestrator turn count (plan §11/§12). A live probe against 2.0.29 showed this does
   **not** happen: title generation emits **`session.renamed`** (`{ sessionID, title }`),
   never `session.step.*`, and compaction has its **own** event family
   (`session.compaction.started/ended/failed/delta`) — the ACP layer tracks it separately.
   A 2-turn run produced exactly 2 `session.step.started`/`ended` (both `agent: "build"`)
   plus one `session.renamed`. So `session.step.ended` counts only real orchestrator model
   calls; no `session.step.started.agent` filter was added. (`session.usage.updated` is
   still deliberately excluded from turn counting — it also fires at admission.)

---

## 18. Post-review fixes — G1 (MCP gating) + G2 (recon tool names), 0.1.161

A third review (2026-10-14) of the shipped 0.1.160 port found two "registered but
not working" regressions in the measurement/integration periphery — the same class
as the 0.1.157 event bug. Fixed here.

**G1 — per-agent MCP gating was dead.** V2 has **no `tools` field** (confirmed
against `Agent.Info` in `@opencode/schema@2.0.29`). A project that gated MCP the
V1 way — global `"tools": { "pg*": false }` plus `agents.<name>.tools: { "pg*":
true }` — saw `opencode mcp list` report the server *connected*, while the global
disable survived as a `permissions` rule and the per-agent allow was silently
dropped: no agent could call a `pg_*`/`playwright_*` tool (live in LibraryOS,
regressing H-32). Fix:
1. `mergeOpencodeJson` now migrates both maps — a new `convertV1Tools` (sharing
   the `V1_ACTION` rename table with `convertV1Permission`) turns the top-level map
   into global rules and each `agents.<name>.tools` map into **appended** agent
   rules, then drops the V1 `tools` keys. Agent rules are appended last, so a
   per-agent `allow` still wins the global `deny`.
2. `doctor` warns while a project still declares `tools` (top-level and/or
   per-agent) and points at `agent-harness update`.
3. `templates/docs/mcp-integrations.md`: the Deploy-safety section now documents
   the migration instead of claiming `tools` is preserved.
4. Tests: `convertV1Tools` unit coverage, a merge test (agent's own rules kept +
   migrated enables appended), and a `doctor` warning test.

**G2 — `session-recon.js` was half-blind under V2.** `WORK_TOOLS` listed `"task"`
(not `"subagent"`) and the shell branch tested `tool === "bash"` (not `"shell"`),
so `report:recon` measured **zero** shell use, dispatches, `cd`-chaining and
inspection — the exact data the H-23/H-25/H-34 loop depends on. Fixes:
- `session-recon.js` accepts both names (`shell`, `subagent`), matching
  `context-guard-core.js`.
- The same bug sat in `context-guard-core.js:isLoopExempt` (only `"bash"`), which
  `provider-stats.js` uses to exclude serve polls — also fixed.
- A new **`[drift-guard]`** test scans the tool-name classifiers
  (`session-recon.js`, `context-guard-core.js`, the plugin) and fails any
  `bash`/`task` tool comparison or `*TOOLS*` set that omits the V2 alias, so this
  class is caught in CI rather than by a manual probe.
- The `session-recon` fixture test now includes `shell`/`subagent` rows (the old
  test fed only V1 names, masking the bug).

---

## 19. Periphery cleanup — docs, version guard, plugin contract (0.1.162)

The same third review that produced §18 listed further gaps it did not fix. This
pass closes the deterministic, in-repo ones; the two that need a decision or
infrastructure are called out as remaining.

**Closed:**

- **G4/G5/G6 — stale V1 prose.** `README.md` dropped `request.body` from the
  agent-frontmatter list and from the deterministic-persona bullet (V2 treats it
  as a no-op; determinism is now a `#low` model **variant**), and the notify
  plugin is described as a structured **console log** (V2 server plugins have no
  TUI — V1 "push a toast"), not a toast. `templates/.agents/memory/model-routing.md`
  now says the mechanical tier pins a `#low` variant while the architect tier
  keeps full effort, matching the agent files. `templates/docs/mobile-testing.md`
  says `shell` (not `bash`), and the `job-notify` push is described as a console
  line per scenario + a `session.prompt` on first-failure/completion.
- **G7 — `context-guard.ts` comments.** The funds branch now states correctly
  that `SessionStructuredError` carries no provider/model (the label comes from
  the observed `sessionModel`), and the registration comment records that V2
  **does** expose `ctx.permission.hook("evaluate")` — only the built-in
  `doom_loop` action was removed. The source-contract test asserts both.
- **G8 — `check-prefix-stability.js` premise.** The gate now explains that under
  V2 only the root `AGENTS.md` is auto-loaded (`.agents/AGENTS.md` is discovered
  lazily, `.agents/rules/00-operating.md` is linked, never auto-loaded), so its
  file set is a **budget proxy** for the deliberate context, not the literal live
  prefix. Behaviour is unchanged.
- **G10 — no `opencode` version check.** `doctor` now reports the runtime and
  **fails** on a V1 banner (the harness is V2-only; V1 loads no plugins while
  everything else says "ok"), warns on an unparseable banner, and is silent when
  the binary is absent (CI). `deploy` prints the same warning (cached, one probe
  per process). Pure `parseOpencodeVersion`/`checkOpencodeVersion` helpers are
  unit-tested.
- **G11 (partial) — plugin contract drift guard.** A new `[drift-guard]` test
  asserts every V2 plugin declares a stable `id:` and a `setup()`/`effect()`
  entrypoint and only calls a hook name from the pinned V2 set
  (`execute.before`/`execute.after`/`context`/`prompt`/`evaluate`, from
  `@opencode/plugin@2.0.29`). This is static; the **real-loader e2e** the review
  asked for stays open (below).
- **G12/G13 — permission-model limits are now documented** in a new README
  "Permission model & limits" subsection: `permissions` are ordered
  last-match-wins and a project rule is appended *after* the harness rules (so a
  project `allow` can shadow a harness `deny` — audit when a deny must be
  absolute), and `permissions` gate tool *selection*, not the host (no OS
  sandbox; a `shell` call runs with the user's authority).

**Already fixed before this pass:** G9 — `templates/docs/mcp-integrations.md`
"Deploy safety" was corrected in 0.1.161 (§18.3).

**Remaining:**

1. **G3 — the `f-343` worktree** still runs the V1 harness (needs a rebase/merge
   decision on its local work, then the `AGENTS.md` §5 worktree sweep).
2. **G11 — a real-loader e2e** (boot a throwaway server, activate a fixture
   location, assert the plugin ids + one end-to-end guard event). Static guards
   now cover the name/id class; behaviour still depends on probes.
3. **G12 — optional policy hardening:** V2's managed `policies` (hard-deny) is
   the unused lever if a harness deny must not be overridable by a project rule.
