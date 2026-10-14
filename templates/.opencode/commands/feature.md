---
description: Start a feature — register the row, scaffold the doc tree in one call, then dispatch the author personas.
---

Start the named feature (or pull the next Queued row) with the minimum ceremony
that still satisfies the gates. This is Step Zero for feature work.

1. **Register + claim.** If you are starting from the queue, `node scripts/backlog.js
   next --take` (or the `backlog_next` tool with `take: true`); otherwise make sure
   the row exists (`backlog_add`) and is In progress (`backlog_take`). Remember the
   `<id>` and a short `<slug>` (e.g. `f-302-cover-sync`).

2. **Orient in one call.** `node scripts/orient.js --feature <id>` (the `orient`
   tool) — tree/branch/HEAD/dirty, checkpoint, board rows, owned files, serve +
   capacity, and the session-start memory digest. Use the digest; open a memory
   file only for a fact it does not carry.

3. **Isolate.** `node scripts/backlog.js worktree <id>` — every feature works in
   its own worktree; `main` stays board + shippable code only. Record owned files
   with `backlog owns <id> --files <globs>`.

4. **Right-size the ceremony, THEN scaffold in one call.**
   - **trivial / single-surface** (rename, typo, constant, one-line doc, CSS,
     config tweak): `execution_mode: direct` — implement, run the targeted gate,
     done. **No scaffold, no persona dispatch.**
   - **low risk** (few files, no auth/DB/API contract): one `intent.md` is enough.
   - **high risk** (auth/security, schema/migration, public API, flow with
     cross-surface siblings): full chain (intent + scope + plan + tests).

   Scaffold the section skeletons in ONE call so the personas fill a known shape
   (the `test:product` / `test:qa-plan` gates check those section names) instead
   of inventing the structure:

   ```
   node scripts/qa/feature-scaffold.js --id <id> --slug <slug> --title "<task>" --risk low|high
   ```

   It writes `.agents/features/<slug>/{intent,plan,tests}.md` (+ `scope.md` when
   `--risk high`) and `.agents/qa-plans/<id>.md`, never overwriting an existing
   doc. It authors no content — the personas do.

5. **Author by dispatching each persona directly** (never via `features`), each
   with the bounded task spec (`Objective → Working tree → Owned files →
   Read-only files → Shared contracts → Done = gate → Out-of-scope`):
   `product-manager` (intent) → `system-architect` (scope, HIGH-risk only) →
   `planner` (plan) → `qa-architect` (the QA plan). Read
   `.agents/memory/model-routing.md` for the tier of each. Parallel only when
   owned files + contracts are disjoint.

6. **Integrate early**: `git fetch origin && git rebase origin/main`, then
   `npm run test:backlog` + `npm run test:concurrency` before landing.

7. **Close with one call**: `npm run finalize -- --feature <id>` (archives,
   commits, lands on main, confirms CI).

Report the picked/registered row (ID, epic, task) as the first line of your reply.
