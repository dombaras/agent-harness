---
description: Pick the next item off the Queue, move it to In progress, and start working (Step Zero).
---

Pull the next item off the Queue and start working on it — no confirmation needed; this command is the explicit "go".

1. **Claim it first — atomically.** Run `node scripts/backlog.js next --take` (or the
   `backlog_next` tool with `take: true`). This immediately promotes the top-priority
   unblocked Queued row to **In progress** in a single locked write, so no other
   session can pick the same row. If it reports "no queued rows" (or "all queued
   rows are blocked"), say so and STOP — do not invent work or reach into Open.
   Remember the returned `<id>` — you own it now.
2. Read the board + memory: `BACKLOG.md`, `.agents/memory/locations.md`,
   `.agents/memory/model-routing.md`, `.agents/memory/product-principles.md`.
3. Isolate from the MAIN tree: `node scripts/backlog.js worktree <id>` (creates a git
   worktree + branch and records it in the row's Handoff cell; the row is already
   In progress from step 1). Every feature works in its own worktree — `main` stays
   board + shippable code only.
4. **Right-size the ceremony BEFORE you dispatch** — state the decision in one
   line so it is auditable (put the same `execution_mode:` line in the handoff):
   - **single-surface / single-file** (rename, typo, constant, one-line doc, CSS,
     config, a self-contained client-side fix): `execution_mode: direct` —
     implement on the main model, run the targeted gate, and write the QA plan
     yourself if `qa-architect` isn't warranted. Do NOT author the full doc chain;
     four personas on a one-file fix is exactly the budget blowout this rule
     prevents (F-256 dispatched product-manager + planner + mobile-engineer +
     qa-architect for a client-only cover fix and hit the soft turn budget before
     shipping).
   - **multi-surface** (auth/DB/API/flow-siblings/new subsystem): author the doc
     chain by dispatching each author persona **directly** — `product-manager` ->
     intent, `system-architect` -> scope (HIGH-risk only), `planner` -> plan,
     `qa-architect` -> tests — and produce a QA plan.
   Then do the work under the standard protocol (`.agents/rules/00-operating.md` §Step Zero).
5. Integrate early: before pushing, `git rebase main` and re-run
   `npm run test:backlog` + `npm run test:concurrency` so board/code conflicts surface
   now, not at the merge.
6. Close with the one-call finalize: `npm run finalize -- --feature <id>` — it
   archives the row, commits the board + CHANGELOG + handoff, ships the branch
   (rebase, gates, push, PR, landing label), and watches to landed + UAT deploy.
   If only this tail remains when the context budget hits, run `finalize` (or
   `/finish <id>`) once instead of stopping — it is a single blocking call and
   cannot be starved by the budget.

Report the picked row (ID, epic, task) as the first line of your reply.
