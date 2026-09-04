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
4. Do the work under the standard protocol (`.agents/rules/00-operating.md` §Step Zero):
   dispatch personas via the `task` tool, author the feature doc chain
   (`product-manager` -> intent, `system-architect` -> scope, `planner` -> plan,
   `qa-architect` -> tests) by dispatching each author persona directly, and produce a QA plan.
   Right-size ceremony to the blast radius.
5. Integrate early: before pushing, `git rebase main` and re-run
   `npm run test:backlog` + `npm run test:concurrency` so board/code conflicts surface
   now, not at the merge.
6. Close by moving shipped rows In progress -> Archive (`backlog_archive`), recording the
   dispatch log in the handoff file, and committing + pushing (including the BACKLOG.md delta).

Report the picked row (ID, epic, task) as the first line of your reply.
