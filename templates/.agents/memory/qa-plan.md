# QA plan — coverage-driven

One entry per SHIPPED change. Authored by `qa-architect` (thinker), or by the
main orchestrator as the mandatory fallback when qa-architect is not dispatched.
Gated mechanically by `npm run test:qa-plan` — a changed code path that is neither
covered nor waivered here fails, so the change cannot be declared verified.

Keep the LAST change on top. Remove the illustrative examples below; never leave
a real-looking path in Coverage map without the actual runtime assertion backing it.

## Change intent

One sentence naming the SEMANTIC behavior change (what the user experiences), not
the file list. The flow-closure half of the gate judges sibling surfaces and
optional variant states against this intent.

- change: return flow no longer offers a condition selector — every return POSTs without a condition payload

## Parallel-surface & variant audit

For every flow in `.agents/memory/flow-map.md` whose `surfaces:` intersect this
diff, address EVERY sibling surface and EVERY declared `variant` here — either
`->` a covering assertion or `audited:` with a reason. `test:qa-plan` fails on any
sibling surface or variant the plan does not NAME. A sibling that intentionally
keeps old behavior must say so (`audited: deferred — logged in handoff`), never be
silently omitted.

- components/LendingActionDrawers.tsx -> test:quick::return (click-through: Mark as Returned, no condition selector)
- mobile/features/return/ReturnStatusSheet.tsx audited: deferred — mobile still renders the selector; same simplification pending, logged in handoff.md
- app/api/transactions/[id]/return/route.ts -> test:api::return (POST without condition payload succeeds)
- flow: return variant: condition-selector-present audited: removed by this change — asserting absence only
- flow: return variant: condition-selector-absent -> test:quick::return (no-selector click-through renders no condition UI)

## Coverage map

A `Changed path -> executing test/assertion` list. Every changed CODE path needs a
runtime assertion that ACTUALLY exercises it (never trust a tier label — verify the
backing suite reaches the path). Paths may be files or directories. Lines starting
with `#` are ignored.

# components/return/ReturnConfirmDrawer.tsx -> test:quick::progression (click-through: Mark as Returned -> confirm -> /api/transactions/[id]/return)
# app/api/transactions/[id]/return/route.ts -> test:quick::progression (return POST succeeds with no condition payload)

## Waivers

Trivial diffs only (pure copy/docs, or a path whose behavior is already covered
elsewhere). Every waiver MUST carry a `reason:` on the same line.

# waived: src/some-screen.tsx reason: copy-only string swap, no runtime path changed