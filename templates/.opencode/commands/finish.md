---
description: Finalize a feature in a fresh bounded context — write the changelog, then archive + commit + land on main + confirm CI.
---

Finalize the named work unit. Implementation + verification are expected to be
already complete; this context exists only to run the deterministic tail, so it
is deliberately short and cannot be starved by the implementation budget.

1. Determine the feature ID (BACKLOG row ID or handoff slug). If the user did not
   name one, derive it from the current branch (`f-<n>` -> `F-<n>`) or list
   candidates with `node scripts/checkpoint.js resume --feature <id>`. Never
   guess a file.
2. Print the bounded state:
   ```
   node scripts/checkpoint.js resume --feature <id>
   ```
3. If `CHANGELOG.md` has no entry for this change, dispatch **one** `docs`
   subagent to add it (cite the change; keep it to a line or two — the docs
   persona owns `CHANGELOG.md`). Do not re-run the doc chain or the full gates.
4. Run the deterministic finalizer **once** and let it run to completion:
   ```
   npm run finalize -- --feature <id>
   ```
   It archives the row, commits the board + CHANGELOG + handoff, then ships the
   branch (rebase, gates, direct fast-forward push to main) and waits for CI to
   go green on the landed SHA. There is no PR, label, or merge train; the deploy
   runs after CI. Exits 0 only when the change is landed and CI is green.
5. If it stops after landing before CI is confirmed (a deliberate `--no-ci-wait`
   or a timeout), check and re-run — `finalize` is idempotent:
   ```
   gh run list --workflow CI --commit <landed-sha>
   npm run finalize -- --feature <id>
   ```
6. Record the dispatch log + session metadata in the handoff and report
   value-first. "Gates green" or "pushed" is not done — only a landed change with
   green CI is.
