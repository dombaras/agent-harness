# BACKLOG — canonical task list

Single source of truth for **all** open work: features, bugs, follow-ups, audits,
roadmaps, ideas. Every other list (`.agents/features/INDEX.md`,
`.agents/memory/todo.md`, historical docs) points here. One row per task — if it's
not a row, it doesn't exist.

**Status ladder:** `backlog → ready → in-progress → testing → shipped → archived`,
plus `frozen` (parked — keep a *why* and a *reopen condition*, never delete).
The board maps status to section: `backlog`/`ready` → **Open**,
`in-progress`/`testing` → **In progress** (active work), `shipped`/`archived` →
**Archive**, `frozen` → **Frozen**.
**Priority (`P`):** `P1` blocking · `P2` important · `P3` nice-to-have · `P4` later.
Priority applies to open rows only. **Evidence** = a pointer (file/log/ticket/words),
never a re-derivation. Leave `?` where unknown — don't invent.

> Updated in the same session the work happens. Pick up a row by moving it
> `Open` → `In progress`; archive `shipped` rows; freeze don't-delete. Historical
> design docs are aspirational — verify against live code.

## Active / next

- _the next few picks (optional): cite each as `ID (P)`._

## In progress

Active work — rows a session has picked up and is working on right now. Move a row
here from `Open` the moment a session starts dealing with it (cite the session's
handoff), and move it to `Archive (shipped · done)` when it ships — or back to
`Open` if it stalls.

| ID | Task | Handoff |
|----|------|---------|
| | | |

_Rows: `| F-004 | short desc | .agents/handoffs/F-004.md (or `?` if not yet written) |`_

## Open

Sorted by priority (P1 → P4).

| ID | P | Task | Evidence |
|----|---|------|----------|
| | | | |

_Rows: `| F-001 | P3 | short desc; open questions with \`?\` | pointer, never a re-derivation |`_

## Frozen

Parked, not deleted. Reopen only when the stated condition recurs.

| ID | Task | Why frozen / reopen when |
|----|------|--------------------------|
| | | |

_Rows: `| F-002 | short desc | why + reopen condition (required) |`_

## Archive (shipped · done)

| ID | Task | Closed |
|----|------|--------|
| | | |

_Rows: `| F-003 | short desc | shipped/done + date/commit |`_

## Not tracking (leave-in-place, no action)

_One prose note listing built-and-stable items deliberately left in place (no
investment, no removal). Omit the section if there is nothing to note._
