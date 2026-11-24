# BACKLOG — canonical task list

Single source of truth for **all** open work: features, bugs, follow-ups, audits,
roadmaps, ideas. Every other list (`.agents/features/INDEX.md`,
`.agents/memory/todo.md`, historical docs) points here. One row per task — if it's
not a row, it doesn't exist.

**Status ladder:** `backlog → ready → in-progress → testing → shipped → archived`,
plus `frozen` (parked — keep a *why* and a *reopen condition*, never delete).
The board maps status to section: `backlog`/`ready` → **Open**,
`in-progress`/`testing` → **In progress** (active work), `shipped`/`archived` →
**Archive**, `frozen` → **Frozen**. A **Queued** row is a ready-to-pull lane:
`backlog queue <id>` allocates an `Open` row into it, and `/next` (or
`backlog next --take`) pulls the top-priority Queued row into `In progress`.
**Priority (`P`):** `P1` blocking · `P2` important · `P3` nice-to-have · `P4` later.
Priority applies to open/queued rows only. **Evidence** = a pointer
(file/log/ticket/words), never a re-derivation. **Epic** = a declared `## Epics`
key (or `?` when unassigned). **Depends on** = comma-separated row IDs that must
be archived before this row is picked up (`?` when none); `/next`/`take`/`worktree`
skip or refuse a row whose dependencies aren't archived. Leave `?` where unknown —
don't invent.

> Updated in the same session the work happens. Pick up a row by moving it
> `Open`/`Queued` → `In progress`; archive `shipped` rows; freeze don't-delete.
> Historical design docs are aspirational — verify against live code.

## Epics

Group work into logical containers. Declare an epic here (`Key` / `Label` / `Goal`),
then set a row's `Epic` cell to the key — or leave `?` when unassigned. Editable
in-file; no code change needed.

| Key | Label | Goal |
|-----|-------|------|
| | | |

## Active / next

- _the next few picks (optional): cite each as `ID (P)`._

## In progress

Active work — rows a session has picked up and is working on right now. Move a row
here from `Open`/`Queued` the moment a session starts dealing with it (cite the
session's handoff), and move it to `Archive (shipped · done)` when it ships — or
back to `Open` if it stalls.

| ID | Epic | Task | Handoff |
|---|---|---|---|
| F-028 | ? | Make finalize, update and deploy session-scoped: finalize aborts before staging when a shared checkout holds another live session's WIP (replace blanket add -u/untracked sweep with an ownership/tail allowlist), governance checks only handoffs in the push (untracked foreign drafts warn, never fail), and harness auto-deploy stops being a concurrent writer on LibraryOS main (publish-only or quiescence-gated). | .agents/handoffs/F-028.md (worktree: ../.worktrees/agent-harness/f-028; branch: f-028) |

_Rows: `| F-004 | epic-key | short desc | .agents/handoffs/F-004.md (or \`?\`) |`_

## Queued

Sorted by priority (P1 → P4). Ready-to-pull work allocated to a worker.

| ID | P | Epic | Task | Evidence | Depends on |
|----|---|------|------|----------|------------|
| | | | | | |

_Rows: `| F-005 | P2 | epic-key | short desc | pointer, never a re-derivation | F-004 |`_

## Open

Sorted by priority (P1 → P4).

| ID | P | Epic | Task | Evidence | Depends on |
|---|---|---|---|---|---|
| F-016 | P4 | ? | Document the 2.3.2 CLI/config additions the harness docs miss: `opencode plugin` (list/add/check/update/remove), `opencode stats` (--tools/--cost/--json), the top-level `plugins` config key, and the MCP server `protocol` field. | docs/opencode-v2.3-compat-scan.md §G4; `opencode plugin --help`; `opencode stats --help`; @opencode/schema@2.3.2 config.plugin | ? |
| F-017 | P4 | ? | Cross-check agent-report/store-lib against `opencode stats --json` as an independent oracle: the CLI now emits per-tool reliability + cost/token stats, so a parity assertion would catch store-shape drift the direct-DB reader silently misses. | docs/opencode-v2.3-compat-scan.md §G5; `opencode stats --help` | ? |

_Rows: `| F-001 | P3 | epic-key | short desc; open questions with \`?\` | pointer | ? |`_

## Frozen

Parked, not deleted. Reopen only when the stated condition recurs.

| ID | Epic | Task | Why frozen / reopen when |
|----|------|------|--------------------------|
| | | | |

_Rows: `| F-002 | epic-key | short desc | why + reopen condition (required) |`_

## Archive (shipped · done)

| ID | Epic | Task | Closed |
|---|---|---|---|
| F-001 | ? | Port LibraryOS's project-proven check-flows.js upstream: forwarded *TestID resolves at runtime; runFlow file: includes validated recursively | shipped 0.3.8 — 5d07aec, CI green (03f3013) |
| F-002 | ? | update: absorb or report pre-existing target modifications to harness-owned files whose content already matches the release (currently left uncommitted AND recorded in .harness.json, so the drift becomes invisible) | shipped |
| F-004 | ? | fix the completion pipeline: publishBoard aborts on the gitignored tracked `.agents/memory/owned-files.md` (git add without -f), backlog.js masks every publish failure as 'remote unreachable', worktree-prune treats finished sessions' pointers as live, and test:docs/test:backlog are not wired into CI | shipped |
| F-003 | ? | green the local process gates on main: test:docs flags a `...` link inside inline code (docs/opencode-v2-migration.md:245 `]({...}, ...)`) and a missing CHANGELOG entry for b68e1bc (fix(harness): commit root worktree-hygiene scripts); test:backlog flags templates/BACKLOG.md as a stray board (the template scaffold shipped to targets). Decide per item: teach the checker to ignore code spans / exempt templates, or fix the content. | subsumed by F-004 (landed 894bc3b): docs/backlog gate findings fixed + gates green |
| F-007 | ? | board: archive from a linked worktree must route an inherited OPEN row to main, never the worktree's snapshot | shipped |
| F-008 | ? | board sync: a behind-only fast-forward must proceed past unrelated tracked dirt; drop the accidentally tracked node_modules symlink | shipped 0.3.12 — 7049179, CI green: behind-only converge fast-forwards past unrelated tracked dirt; dropped the accidentally tracked node_modules symlink |
| F-009 | ? | Auto-deploy the harness to LibraryOS on every green CI run on main (deploy key + workflow) and fast-forward the local LibraryOS clone | shipped |
| F-010 | ? | Auto-tag version bumps on green main CI and dispatch the npm Release workflow (trusted publishing) | shipped |
| F-011 | ? | Pin the Release workflow to npm 11 (or move the upgrade after test:pack): npm@latest 12.x breaks test:pack with an empty `npm pack --json` array, failing auto-releases before publish | shipped |
| F-012 | ? | Harness version badge in the opencode TUI: ship a template TUI plugin (templates/.opencode/plugins/harness-version/) that renders the deployed `.harness.json` version in the home footer + session prompt footer status slots (beside opencode's own version / the model indicator), only in harness-provisioned repos. | shipped |
| F-005 | ? | Enable OpenCode V2 todowrite end-to-end: ship `experimental.todo: true` in `templates/opencode.json`; deep-merge `experimental` in `mergeOpencodeJson` so a project's other experimental keys survive; tighten the todo guard (require a `todowrite` update after every completed step, exactly ONE `in_progress`, suppress nudges when the flag is off); add `test:opencode-compat` (V2 version + config + deprecated-V1-key + plugin-hook check) wired into gates/doctor/update. | shipped |
| F-006 | ? | OpenCode V2 compatibility scan: audit every harness surface (plugin hooks/API, config keys, built-in tool names, CLI commands, store/telemetry, permissions/policies, MCP, skills/commands, worktrees, child-session behavior) against the OpenCode V2 docs + installed binary; produce a gap report and file each gap as a row. The `todowrite` miss is a known symptom. | shipped |
| F-013 | ? | Adopt managed `policies` hard-denies for credential paths and MCP gating: OpenCode 2.3.2 ships a real top-level `policies` key (hard allow/deny over provider.use/tool.use/mcp.use/skill.use/plugin.use/websearch.use); the harness still relies on overridable `permissions`, so a project allow can shadow a harness credential/MCP deny. | shipped 0.4.0 — 5e597ee, CI green (run 44923107044); 3204fbb landed CI-red and was fixed forward |
| F-018 | ? | Make the always-loaded AGENTS.md budget a pre-landing gate: wire test:prefix into ship/pre-push, give the file deliberate headroom, and document the trim-or-ask escalation path | shipped |
| F-014 | ? | Align guard/session tool classifiers with the OpenCode 2.3.2 built-in tool set (`todo`, `skill`, `question`, `webfetch`, `websearch`, `patch`, `artifact`, `automation`, `image-generate`): `EXEMPT_TOOLS` has `todowrite` but not `todo`, `MATERIAL_TOOLS` has no `skill`/`artifact`. Verify effective tool names first, then update classifiers + the drift-guard test. | shipped |
| F-015 | ? | Decide worktree alignment with OpenCode 2.3.2 native support: `worktree.directory` config, `ctx.worktree` (transform/add/list/create/remove), and `opencode run --worktree [=name]` now exist while the harness shells out to `git worktree` under `../.worktrees/<repo>/<id>`. Adopt the native surface or document the deliberate divergence. | shipped |
| F-022 | ? | agent-harness update fails closed on an unmodified previous-release AGENTS.md once next dev appends its block (blocks 0.4.1+ deploy to LibraryOS) | shipped |
| F-019 | ? | Session-end guard: an untracked `.agents/handoffs/*.md` in a project's shared main checkout is silently orphaned — `finalize` stages only the current feature's handoff and refuses every other one, while main-checkout commits are guard-blocked. Add a gate (or a handoff sync into the landing worktree) so no session handoff can be left behind unnoticed. | shipped |
| F-021 | ? | Migrate or retire a session's `.serve/sessions/<id>.json` lease when `session_move` relocates the session to the main checkout: the lease file stays inside the old worktree, `liveLeases(main)` surfaces it, and `worktree-prune` then reports every merged worktree as 'this session is rooted in it' and refuses to prune (observed for f-014/f-015/f-018 after moving F-015 to main). | shipped |
| F-020 | ? | Fix `archive` worktree cleanup when the board write runs from inside the feature worktree: cleanupWorktree resolves the recorded worktree path against the worktree root instead of the main checkout, so `git worktree remove` targets `<worktree>/../.worktrees/...` and fails, leaving the shipped worktree behind with a misleading fatal. | shipped |
| F-023 | ? | Session-start harness update check: compare the deployed `.harness.json` version to npm `dist-tags.latest` and suggest `npx opencode-agent-harness@latest update` (like opencode's "Update available"). Must be a cached (24h TTL) detached probe, not a blocking `npm view`; show once per new version in `orient --brief`, the TUI harness badge (v0.4.4 ↑0.5.0), and `doctor`; extend the global `harness-freshness` plugin so a stale project still sees it; stay silent offline and when the local checkout is ahead of npm. | shipped |
| F-024 | ? | Persona dispatch activation: make delegation legible, cheap and reliable — persona decision contracts, a prefilled dispatch_persona wrapper with preflight, persona economics in orient, risk-tiered dispatch policy, derived dispatch log, dispatch health probe | shipped |
| F-026 | ? | worktree-prune --self cannot identify the caller under OpenCode V2: tool bash runs under the pty helper, so the opencode server pid (which owns every session lease) is NOT a process ancestor, and all sessions share that pid. Result: finalize/ship reports 'worktree left in place' and every merged, clean feature worktree survives (f-023/f-024), forcing manual housekeeping each session. | shipped |
| F-027 | ? | Harness TUI version badge must append a restart marker when the global harness-freshness verdict is restart-needed (deployed .harness.json is current but the running opencode server predates the last write), so the footer never implies the loaded server-side harness is already active. | shipped |
| F-025 | ? | Persona dispatch activation, remaining slices S2-S6: dispatch_persona plugin tool (create child with parentID+agent+location, preflight model/write-scope/tree), persona economics in orient, risk-tiered dispatch policy (T0-T3 classifier), derived dispatch log in finalize, dispatch health probe + persona-hint interception. S1 (decision contracts + drift guard) shipped in 0.4.8. | shipped |

_Rows: `| F-003 | epic-key | short desc | shipped/done + date/commit |`_

## Not tracking (leave-in-place, no action)

_One prose note listing built-and-stable items deliberately left in place (no
investment, no removal). Omit the section if there is nothing to note._
