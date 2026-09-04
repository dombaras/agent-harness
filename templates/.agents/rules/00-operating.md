# {{PROJECT_NAME}} Operating Rules (summary)

Always in effect. Full detail lives in `.agents/AGENTS.md`; read it before non-trivial work.

## Step Zero — subagent dispatch gate (non-negotiable)

Before reading or editing any file for a task, dispatch the relevant personas via the `task` tool — each runs on its own `model:` (`.opencode/agents/<name>.md`). Keep only coordination/mechanical work (reads, git, commits) on the main model.

- **Bound every task before dispatching.** No persona gets a bare metric ("get under N lines", "type everything"). Each dispatch prompt carries a task spec: `Objective` (one deliverable) → `Owned files` (exact paths) → `Read-only files` → `Shared contracts (owns|consumes)` → `Done = <gate command + observable metric>` → `Out-of-scope`.
- **Parallel = disjoint.** Dispatch two personas in parallel only when their owned files AND shared contracts are disjoint; otherwise serialize and put the shared-contract owner first. Across *sessions*, disjoint means **isolated working trees**: run `backlog worktree <id>` (from the main tree) before picking up a second concurrent feature so one session's uncommitted work can't leak into another's pre-push gate (`test:concurrency` fails a push when that collision is provable; `node scripts/qa/run-clean.js -- <gate>` snapshots the tree so a gate verifies only committed work).
- **Accept, don't trust.** After a code persona reports done, the orchestrator re-runs the gate itself (`tsc --noEmit`, `lint:hooks`, `test:quick`) and greps the metric before integrating — a subagent's `Evidence` is a claim, not proof.
- **QA planning is never optional.** Every change touching code paths gets a QA plan (coverage map in a per-change file under `.agents/qa-plans/`) from `qa-architect`; if it isn't dispatched, the main orchestrator plans in its place. `npm run test:qa-plan` fails on any changed code path with no covering assertion or waiver, and on any touched flow (`.agents/memory/flow-map.md`) whose sibling surfaces / declared variants the plan doesn't address.
- Persona map, waivers, and the dispatch-failure ladder: `.agents/AGENTS.md` §5 and `.agents/memory/model-routing.md`.
- **Features**: capture a found item as one light row in the canonical `BACKLOG.md` (repo root) — `features` is a registrar only (backlog rows + doc-tree scaffolding). **Update the board with the `backlog_*` tools (or `node scripts/backlog.js`), never hand-edit `BACKLOG.md`.** The moment a session starts dealing with a backlog item, move its row `Open` → `In progress` (`backlog_take`, pointing `Handoff` at the session's `.agents/handoffs/<id>.md`) so active work is visible on the board. On pickup, author the per-feature doc chain by dispatching each author persona **directly** (`product-manager`/`system-architect`/`planner`/`qa-architect`) — never via `features`. Right-size ceremony to risk.
- **Queue → next**: `backlog queue <id>` moves an `Open` row to `Queued` (a ready-to-pull lane). `/next` (or `backlog next --take`) pulls the top-priority `Queued` row into `In progress` and starts this session's standard flow — deterministic, no manual ID pick; if the queue is empty it stops instead of inventing work.
- **Docs**: human-facing docs (`README.md`, `CHANGELOG.md`, `docs/**`) are owned by the `docs` persona (`.agents/skills/docs/SKILL.md`) — docs point at code, never duplicate it, and `npm run test:docs` enforces no placeholders / no dangling links / well-formed ADRs.
- **Product intent is never optional.** A feature never reaches planning/implementation without defining its user. `intent.md` must carry Actor(s) → Need → Outcome → Acceptance criteria, and `plan.md` a Value-first sequence + Product concepts applied — `npm run test:product` fails otherwise. Planning reads `.agents/memory/product-principles.md` and is value-led, not tech-led.
- Every subagent returns the output contract (`Result` → `Evidence` → `Deferred & risks`).
- Wrap up with a **dispatch log** (`subagent → model → shipped/deferred`) in your session's `.agents/handoffs/<feature-id>.md`.

## Non-negotiable laws

1. **Zero speculation** — base every fix/decision on observed logs, telemetry, or DB state; instrument first if evidence is missing.
2. **No hardcoded mocks/fallback data** — prefer dynamic queries and database-backed settings.
3. **5 UI states** (ideal/empty/loading/error/partial), user-visible errors (never `console.warn`-only), and RTL-safe logical props.
4. **Product-first planning** — define the actor/need/outcome/acceptance before code; sequence work value-first against `.agents/memory/product-principles.md`.
5. **Verify stack versions** before writing framework code (`.agents/memory/stack-versions.md`).
6. **Token discipline** — search before read, targeted reads, batch reads, don't re-read unchanged files, right-size QA.
7. **Static ≠ runtime** — never declare verified from `tsc` alone; execute a real runtime/API path that exercises the MODIFIED code — a tier label never proves coverage. `test:qa-plan` gates every changed code path to a covering assertion or waiver, and every touched flow's sibling surfaces / variants to an audit entry (`.agents/memory/flow-map.md` — "fix one, fix all").
8. **Commit** with `feat:`/`fix:`/`refactor:` then push to main — including any `BACKLOG.md` delta.

## Definition of Done

QA tier + security lens gate **code changes only** (a backlog-only change skips them). Every session opens with **move the picked-up row `Open` → `In progress`** (`backlog_take`) and closes with **move shipped `BACKLOG.md` rows from `In progress` to `Archive` (`backlog_archive`) → commit → push** — the backlog write-back is never QA-gated. Feature work is additionally gated by `test:product` (product intent + value-led plan).

## Session checklist

Start: read `.agents/memory/locations.md` + `.agents/memory/model-routing.md` + `BACKLOG.md`, then move the picked-up row `Open` → `In progress` (`backlog_take`). If another feature is already `In progress`, isolate first: `backlog worktree <id>` (creates a `git worktree` + branch; record the path in the row's `Handoff`). End: move shipped `BACKLOG.md` rows from `In progress` to `Archive` (`backlog_archive`), record the dispatch log, and update the handoff memory.
