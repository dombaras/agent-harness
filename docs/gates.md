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

## `test:diagnosis` — inquiry-loop diagnosis gate
`node scripts/qa/check-diagnosis.js [--feature <id>] [--warn] [--json]`
A declared `kind: bug | incident | fix` feature (`.agents/features/<slug>/meta.json`)
cannot finalize without a `diagnosis.md` that states the observed vs expected
behaviour, at least two candidate causes each with a discriminating test, the
candidates ruled out, an independent falsification record, and a complete
`## Outcome oracle` (red before / green after). Scope is explicit metadata, never
inferred from a diff; legacy features (no `meta.json`) and `requiresDiagnosis:
false` are never blocked. **Satisfy:** run `/diagnose <symptom>` / the `diagnose`
skill, or fill the scaffolded `diagnosis.md` before implementing; the one-release
warning mode is `AGENT_HARNESS_DIAGNOSIS=warn` (or `--warn`). **Waive:**
`requiresDiagnosis: false` in `meta.json` for a knowingly-designed change.

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
CHANGELOG line in the same commit (a docs-only `chore` commit is not enough). A
change under `bin/` or `templates/` also bumps `package.json` in the same commit —
the harness suite fails a template change that leaves the published version
unchanged.

## `test:feedback` — feedback-loop contract gate
`node scripts/qa/check-feedback.js [--policy <path>] [--ledger <dir>]`
Validates the `feedback-policy/1` document (mode, budgets, high-risk paths,
kill switch) with an auto-mode safety floor: only the `product` class may
auto-fix, and auto mode requires a non-empty high-risk list. It replays the eight
`feedback-fixtures.json` signals through the deterministic classifier, route
table, and frozen signature/marker drift guards, then checks secret redaction,
dedupe/reopen, the state machine, budgets, metrics, and the ledger shape when one
exists. A missing policy or ledger is a warning, not a failure. **Satisfy:** keep
the policy within budget and the fixture truth table correct. **Waive:** none —
the fixtures are the contract.

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

## `test:ci-policy` — Actions cost-policy gate
`node scripts/qa/check-ci-policy.js`
Fails (or warns) on the workflow *shapes* that quietly leave the GitHub Actions
free tier: a sub-hourly `cron:` (`scheduled-too-frequent`), a macOS/Windows runner
on an unfiltered `push` (`expensive-every-push`), a `-large`/`-xlarge` runner
(`larger-runner`, warn), and two expensive workflows on the same unfiltered push
(`duplicate-expensive-push`). A project with no `.github/workflows` passes.
**Satisfy:** path-filter the expensive workflow (`paths:`), widen the cron to
≥6-hourly, or move it off the push trigger; price a change first with
`npm run ci-triage -- --preflight .github/workflows/<file>.yml`.

## `test:opencode-compat` — OpenCode V2 surface gate
`node scripts/qa/check-opencode-compat.js [--root <dir>] [--json]`
The harness is OpenCode V2-only, so a surface that drifted to V1 is silently
inert. Fails on: a runtime whose major version is not 2 (when `opencode` is on
PATH); `opencode.json` missing/parse-failing or without `experimental.todo:
true`; a leftover V1 config key (`small_model`, `agent`, `permission`, `tools`);
a plugin that imports `@opencode-ai/plugin`, reads `event.properties` (V2 uses
`event.data`), or lacks `export default`; and the V1 layouts `.opencode/tools/*`
or legacy `.opencode/command/`. **Satisfy:** `agent-harness update` (the merge
migrates config, the prune removes the V1 layout) — this is the gate that would
have caught the missing `todowrite` capability. **Waive:** none; a V2-only deploy
is the contract.

## `test:prefix` — cache-prefix stability gate
`node scripts/qa/check-prefix-stability.js`
No volatile value (clock timestamp, machine path, session id) in an always-loaded
prefix file (root dispatcher, rulebook, operating rules, session-start memory).
**Satisfy:** move per-run values into handoffs/state files.

## `audit:prefix` — session-start prefix audit
`node scripts/qa/prefix-audit.js [--root <dir>] [--session <id>] [--no-store] [--json] [--budget <tokens>]`
Reports what a session pays before the first user token: the observed floor from
the local store (first assistant message `input + cache.read`), the auto-loaded
instruction files in bytes and estimated tokens (global + project `AGENTS.md` +
`instructions` entries), and the derived system + tool-schema remainder with its
share. `--no-store` keeps it usable in CI and fresh clones (static mode, exit 0);
`--budget` fails only when an observed floor exceeds the budget. This is an audit,
not a gate — `test:prefix` remains the deterministic byte/volatility gate.

---

## Non-test harness commands referenced by the rules
- `node scripts/orient.js` — one-call session orientation (tree/feature/checkpoint/board/serves/capacity/last-E2E) **plus a bounded digest of the session-start memory files** (`--brief` for session-start injection). The checkpoint line is a bounded excerpt: phase, next action, and the top-level heading outline; `checkpoint resume` itself is capped at 3 KB and never prints the whole handoff.
- `node scripts/qa/run-gates.js` — run the gate battery in ONE call (`npm run gates [-- --phase=pre-push|process|quick|all] [--base=<ref>] [--continue]`). Phases run in order, stop at the first failure, and skip a gate the project has not wired. **The pre-push hook delegates here** (`gates --phase=pre-push`), so the hook and the `gates` tool share one gate list.
- `node scripts/qa/where.js` — bounded symbol/owner lookup (`npm run where -- <term>`): index-first `file:line` hits annotated with the backlog row(s) owning each file, plus `--owner <glob>`. Use it instead of shell `grep` for locating a symbol.
- `node scripts/qa/feature-scaffold.js` — write the per-feature doc-tree skeletons (intent/scope/plan/tests) + the QA-plan stub in one call (`npm run feature:scaffold -- --id <F-n> --slug <slug> [--risk high]`), so the author personas fill a `test:product`-shaped structure instead of a blank page. Write-if-missing; authors no content.
- `node scripts/qa/session-recon.js` — tool-habit / context-hygiene recon (`npm run report:recon`).
- `node scripts/qa/ci-triage.js` — name a red Actions run for what it is (`green` / `infra-block` — no runner, a billing artifact — / `failed`, exit 0/1/2) and price a dispatch (`--preflight .github/workflows/<file>.yml`) against the recent-run median + budget (`npm run ci-triage`).
- `node scripts/wait-for.js` — bounded blocking wait (`--job`/`--ci`/`--health`/`--port`/`--file --grep`); `npm run wait`.
- `node scripts/checkpoint.js` — deterministic checkpoint (`write`/`resume`).
- `node scripts/backlog.js` — board read/write (single write path; service backend per ADR 0001).
- `node scripts/serve.js` — detached long-lived process launcher + capacity/lock gate.
- `node scripts/ship.js` / `finalize.js` — integrate, gate, land on `main`, confirm CI.
