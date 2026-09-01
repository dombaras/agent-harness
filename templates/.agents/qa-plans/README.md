# QA plans — one file per change

Project-owned (like all `.agents/memory/*`). This directory holds the
coverage-driven QA plan, **sharded**: one file per shipped change instead of a
single shared `qa-plan.md`. Each concurrent session owns its own file, so two
sessions (e.g. `F-003` and `F-035`) never rewrite each other's entries — the
failure mode where one session's "keep-last-on-top" edit moves another's entry
around (and risks dropping it on commit).

`npm run test:qa-plan` reads EVERY `.md` file under this directory (plus the
legacy `.agents/memory/qa-plan.md` if it exists) and unions their coverage maps,
waivers, and flow audits against the live diff — so a changed code path is
covered if ANY plan file names it.

## Naming & ownership

- One file per change. Name it after the `BACKLOG.md` feature ID (`F-003.md`),
  or a short hyphenated slug of the change (`return-no-condition.md`) when there
  is no feature row.
- **Own your file; never edit another change's file.** That single rule removes
  the collision. If a later change revisits the same feature, append a new
  `##`-block to that feature's file (or open a new dated file) — never reorder
  or delete another entry.
- Same four sections the old `qa-plan.md` carried (authored by `qa-architect`,
  or by the main orchestrator as the mandatory fallback): `## Change intent`,
  `## Parallel-surface & variant audit`, `## Coverage map`, `## Waivers`.

## Example (`F-003.md`)

    # QA plan — F-003 (return flow: no condition selector)

    ## Change intent
    - change: return flow no longer offers a condition selector — every return POSTs without a condition payload

    ## Parallel-surface & variant audit
    - components/LendingActionDrawers.tsx -> test:quick::return (click-through: Mark as Returned, no condition selector)
    - mobile/features/return/ReturnStatusSheet.tsx audited: deferred — mobile still renders the selector; same simplification pending, logged in handoff.md
    - app/api/transactions/[id]/return/route.ts -> test:api::return (POST without condition payload succeeds)
    - flow: return variant: condition-selector-present audited: removed by this change — asserting absence only
    - flow: return variant: condition-selector-absent -> test:quick::return (no-selector click-through renders no condition UI)

    ## Coverage map
    - components/return/ReturnConfirmDrawer.tsx -> test:quick::progression (click-through: Mark as Returned -> confirm -> /api/transactions/[id]/return)
    - app/api/transactions/[id]/return/route.ts -> test:quick::progression (return POST succeeds with no condition payload)

    ## Waivers
    # waived: src/some-screen.tsx reason: copy-only string swap, no runtime path changed

Lines starting with `#` are ignored by the gate.
