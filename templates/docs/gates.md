# Gate reference (`npm run <gate>`)

Every harness-shipped gate in one place: what it enforces, how to satisfy it, and
how to waive it. The gates are wired into `package.json` by `init`/`update`
(`HARNESS_SCRIPTS`) and run in the pre-push hook, in `ship`, and in CI. Read this
instead of reverse-engineering the check script — the 2026-09 LibraryOS recon
found `scripts/backlog.js` read 45× and `check-qa-plan.js` 16× for exactly this.

`agent-harness explain <gate>` prints the matching section.

**Choosing a gate:** load the `dev-loop` skill (`skill` tool → `dev-loop`) —
it carries the cheapest-scoped-check rule (`npm run gates -- --phase=quick`),
the project test-tier map in `.agents/memory/dev-loop.md`, and "read the failing
gate, don't re-run it blind". `npm run where` / the `where` tool maps a changed
path to its owning tier.

---

## `test:dispatch` — dispatch-config preflight
`node scripts/qa/check-dispatch-config.js`
Every `.opencode/agents/<name>.md` pins a `model:` that is a real, allow-listed
model (`scripts/qa/models.allowlist.txt`), and every persona referenced by the
rules exists. **Satisfy:** add a persona → give it a valid `model:`; add a model →
its provider to the allowlist. **Waive:** none — a broken dispatch target must not
ship.

## `test:governance` — session-governance gate
`node scripts/qa/governance.js`
Each session handoff opens a `## Dispatch log` (`subagent → model →
shipped/deferred`), and a log with 5+ entries carries a `## Fan-out
justification`. **Satisfy:** fill the handoff's dispatch log. **Waive:** none.

## `test:qa-plan` — diff-coverage gate
`node scripts/qa/check-qa-plan.js [--base=origin/main]`
Every changed code path has a covering assertion or a waiver in the change's
`.agents/qa-plans/<id>.md`, and every touched flow (`.agents/memory/flow-map.md`)
has its sibling surfaces + declared variants addressed in the plan's
`## Parallel-surface & variant audit`. Run scoped: `--base=origin/main` (a bare
`--base=HEAD` is an empty diff). **Satisfy:** author the plan (qa-architect, or the
orchestrator in its place). **Waive:** an explicit `audited:`/waiver line per path.

## `test:backlog` — canonical-single-backlog gate
`node scripts/qa/check-backlog.js`
The shared board service is the only source of truth (ADR 0001); when the service
backend is active the gate validates its board, otherwise it validates the legacy
`BACKLOG.md`. `.agents/features/INDEX.md` and `.agents/memory/todo.md` are
pointers, never duplicate lists. **Satisfy:** edit the board via `backlog_*` /
`node scripts/backlog.js`, never a second list.

## `test:product` — product/UX-first gate
`node scripts/qa/check-product.js`
Feature work has an `intent.md` (Actor(s) → Need → Outcome → Acceptance) and a
value-led `plan.md`; a `plan.md` with no `intent.md` fails. **Satisfy:** dispatch
`product-manager` (intent) → `planner` (plan). **Waive:** non-feature work (no
feature doc tree) is out of scope.

## `test:docs` — documentation hygiene gate
`node scripts/qa/check-docs.js`
No un-substituted `{{PLACEHOLDER}}`, no dangling links, well-formed ADRs, and every
shipped commit is cited in `CHANGELOG.md` by short hash. **Satisfy:** add the
CHANGELOG line in the same commit (a docs-only `chore` commit is not enough).

## `test:concurrency` — cross-session working-tree guard
`node scripts/qa/check-concurrency.js`
Fails when a dirty tree's files are attributed to two In-progress rows that own
the same file (the provable collision), or a tree mixes two sessions' WIP. The
live-session report is advisory. **Satisfy:** `backlog owns <id> --files "glob"`
per row, isolate with `backlog worktree <id>`. **Waive:** `--prune` clears
dead/stale leases.

## `test:integrate` — pre-push rebase check
`node scripts/qa/check-integrate.js`
Fails when the branch is behind its upstream so conflicts surface before push.
**Satisfy:** `git fetch origin && git rebase origin/main` (ship does this).

## `test:quality` — mechanical code-quality gate (NEW/CHANGED code)
`node scripts/qa/check-quality.js [--strict]`
No dead exports / oversized files introduced in NEW or GROWN code (rubric
`.agents/memory/quality-parameters.md` P1/P3/P4). **Satisfy:** extract/split on
growth; leave legacy debt alone.

## `test:wiring` — orphan-test detector
`node scripts/qa/check-test-wiring.js`
Every `*.test.*` / `*.spec.*` file is executed by some package script (T7).
**Satisfy:** wire the test into a tier script.

## `test:linger` — process-vs-tests linger detector
`node scripts/qa/check-linger.js -- <tier command>`
Flags a suite whose process lingers far past its runner-reported test time (an
open handle / teardown bug — T1/T6/T9). **Satisfy:** close pools/sockets/timers.

## `test:capacity` — machine capacity envelope gate
`node scripts/qa/check-capacity.js`
Reports free RAM / swap / PSI load / live serves and fails when the envelope
(`.agents/memory/orchestration.md`) is already exceeded. **Satisfy:** stop idle
serves (`serve.js stop-all`, `prune`).

## `test:prefix` — cache-prefix stability gate
`node scripts/qa/check-prefix-stability.js`
No volatile value (clock timestamp, machine path, session id) in an always-loaded
prefix file (root dispatcher, rulebook, operating rules, session-start memory).
**Satisfy:** move per-run values into handoffs/state files.

---

## Non-test harness commands referenced by the rules
- `node scripts/orient.js` — one-call session orientation (tree/feature/checkpoint/board/serves/capacity/last-E2E) **plus a bounded digest of the session-start memory files** (`--brief` for session-start injection).
- `node scripts/qa/run-gates.js` — run the gate battery in ONE call (`npm run gates [-- --phase=pre-push|process|quick|all] [--base=<ref>] [--continue]`). Phases run in order, stop at the first failure, and skip a gate the project has not wired. **The pre-push hook delegates here** (`gates --phase=pre-push`), so the hook and the `gates` tool share one gate list.
- `node scripts/qa/where.js` — bounded symbol/owner lookup (`npm run where -- <term>`): index-first `file:line` hits annotated with the backlog row(s) owning each file, plus `--owner <glob>`. Use it instead of shell `grep` for locating a symbol.
- `node scripts/qa/feature-scaffold.js` — write the per-feature doc-tree skeletons (intent/scope/plan/tests) + the QA-plan stub in one call (`npm run feature:scaffold -- --id <F-n> --slug <slug> [--risk high]`), so the author personas fill a `test:product`-shaped structure instead of a blank page. Write-if-missing; authors no content.
- `node scripts/qa/session-recon.js` — tool-habit / context-hygiene recon (`npm run report:recon`).
- `node scripts/wait-for.js` — bounded blocking wait (`--job`/`--ci`/`--health`/`--port`/`--file --grep`); `npm run wait`.
- `node scripts/checkpoint.js` — deterministic checkpoint (`write`/`resume`).
- `node scripts/backlog.js` — board read/write (single write path; service backend per ADR 0001).
- `node scripts/serve.js` — detached long-lived process launcher + capacity/lock gate.
- `node scripts/ship.js` / `finalize.js` — integrate, gate, land on `main`, confirm CI.
