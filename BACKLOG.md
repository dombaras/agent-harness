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
| F-005 | ? | Enable OpenCode V2 todowrite end-to-end: ship `experimental.todo: true` in `templates/opencode.json`; deep-merge `experimental` in `mergeOpencodeJson` so a project's other experimental keys survive; tighten the todo guard (require a `todowrite` update after every completed step, exactly ONE `in_progress`, suppress nudges when the flag is off); add `test:opencode-compat` (V2 version + config + deprecated-V1-key + plugin-hook check) wired into gates/doctor/update. | .agents/handoffs/F-005.md (worktree: ../.worktrees/agent-harness/f-005; branch: f-005) |
| F-010 | ? | Auto-tag version bumps on green main CI and dispatch the npm Release workflow (trusted publishing) | ? (worktree: ../.worktrees/agent-harness/f-010; branch: f-010) |

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
| F-006 | P2 | ? | OpenCode V2 compatibility scan: audit every harness surface (plugin hooks/API, config keys, built-in tool names, CLI commands, store/telemetry, permissions/policies, MCP, skills/commands, worktrees, child-session behavior) against the OpenCode V2 docs + installed binary; produce a gap report and file each gap as a row. The `todowrite` miss is a known symptom. | docs/opencode-v2-migration.md; https://opencode.ai/docs/; opencode v2.3.2; F-005 fixes the first gap | F-005 |

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

_Rows: `| F-003 | epic-key | short desc | shipped/done + date/commit |`_

## Not tracking (leave-in-place, no action)

_One prose note listing built-and-stable items deliberately left in place (no
investment, no removal). Omit the section if there is nothing to note._
