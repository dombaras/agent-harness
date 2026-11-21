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
|----|------|------|---------|
| | | | |

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
| F-002 | P2 | ? | update: absorb or report pre-existing target modifications to harness-owned files whose content already matches the release (currently left uncommitted AND recorded in .harness.json, so the drift becomes invisible) | LibraryOS 0.3.8 deploy: update committed .harness.json + 2 new files but left scripts/board-service.sh, finalize.js, qa/run-gates.js, wsl-tune.sh modified-uncommitted; manual commit dabe5d5 was required; manifest now matches the worktree hashes so the next update will not flag them | ? |

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

_Rows: `| F-003 | epic-key | short desc | shipped/done + date/commit |`_

## Not tracking (leave-in-place, no action)

_One prose note listing built-and-stable items deliberately left in place (no
investment, no removal). Omit the section if there is nothing to note._
