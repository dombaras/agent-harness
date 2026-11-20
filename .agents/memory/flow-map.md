# Flow map — every user-facing flow and where it lives

Project-owned (like all `.agents/memory/*`). This is the registry that turns the
"Fix One, Fix All" rule (`AGENTS.md` §3) into a **gate**:
`npm run test:qa-plan` reads this file and, for every flow your diff touches,
requires the QA plan to explicitly address EVERY sibling surface — the same
behavior implemented anywhere else: another codebase (web vs `mobile/`), another
layer (API route), another page — and every OPTIONAL variant (state a surface can
be in, e.g. "condition selector present" vs "absent") before the change may be
verified.

The failure mode this kills: a change to one surface (e.g. web) ships while its
twin in another codebase silently keeps the old behavior. The diff is web-only so
per-file coverage looks green, but the flow is now inconsistent — the exact
"web/mobile return flow" miss.

Keep it current: every time a flow gains/removes a surface or variant, update its
entry here in the same change.

## flow: return
behavior: "Mark as Returned" — return POST with an optional condition payload (condition selector)
surfaces: components/LendingActionDrawers.tsx, mobile/features/return/ReturnStatusSheet.tsx, app/api/transactions/[id]/return/route.ts
variants: condition-selector-present, condition-selector-absent