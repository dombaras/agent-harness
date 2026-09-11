# agent-harness Operating Rules (summary)

Always in effect. Full detail lives in `.agents/AGENTS.md`; read it before non-trivial work.

## Step Zero — subagent dispatch gate (non-negotiable)

Before reading or editing any file for a task, dispatch the relevant personas via the `task` tool — each runs on its own `model:` (`.opencode/agents/<name>.md`). Keep only coordination/mechanical work (reads, git, commits) on the main model.

- **Bound every task before dispatching.** No persona gets a bare metric ("get under N lines", "type everything"). Each dispatch prompt carries a task spec: `Objective` (one deliverable) → `Working tree` (the exact feature-worktree path/branch — or `main` — this task edits; the subagent verifies it before touching a file) → `Owned files` (exact paths) → `Read-only files` → `Shared contracts (owns|consumes)` → `Done = <gate command + observable metric>` → `Out-of-scope`.
- **Parallel = disjoint.** Dispatch two personas in parallel only when their owned files AND shared contracts are disjoint; otherwise serialize and put the shared-contract owner first. Across *sessions*, disjoint means **isolated working trees**: run `backlog worktree <id>` (from the main tree) before starting ANY feature — `main` stays board + shippable code only, so one session's uncommitted work can't leak into another's pre-push gate. Declare each picked-up row's owned files (`backlog owns <id> --files "glob, glob"`) so `test:concurrency` fails *exactly* when two In-progress rows own the same file, instead of on every "2+ In progress + dirty" tree; `node scripts/qa/run-clean.js -- <gate>` snapshots the tree so a gate verifies only committed work.
- **Accept, don't trust.** After a code persona reports done, the orchestrator re-runs the gate itself (`tsc --noEmit`, `lint:hooks`, `test:quick`) and greps the metric before integrating — a subagent's `Evidence` is a claim, not proof.
- **Tree check before edit.** A code persona must run `git rev-parse --show-toplevel` + `git branch --show-current` before its first edit and confirm both match the assigned `Working tree`; a mismatch means it's in the wrong checkout (`main` or another session's worktree) — it stops and reports, never edits. One persona editing the wrong tree leaks WIP across sessions. **The tree check is a command contract, not a memory:** run every read/write shell command with `workdir` set to the assigned worktree (or `git -C <path>` for git) so the check is satisfied by construction — never `cd` elsewhere and never assume the dispatch cwd equals the assigned tree. Include that sentence verbatim in every dispatch's `Working tree` clause.
- **QA planning is never optional.** Every change touching code paths gets a QA plan (coverage map in a per-change file under `.agents/qa-plans/`) from `qa-architect`; if it isn't dispatched, the main orchestrator plans in its place. `npm run test:qa-plan` fails on any changed code path with no covering assertion or waiver, and on any touched flow (`.agents/memory/flow-map.md`) whose sibling surfaces / declared variants the plan doesn't address. The plan also records `## Test budget` (wall-clock + teardown + tier), `## Oracle & owner`, and `## Test-design self-check` (T1–T10 → `.agents/memory/test-design-parameters.md`).
- **Mechanical code quality is a gate, not a review topic.** `test:quality` (`node scripts/qa/check-quality.js`) blocks dead exports and oversized files on NEW/GROWN code; run it on the diff before push (`--strict` for CI). The canonical rubric lives in `.agents/memory/quality-parameters.md` (P1–P8) — review rows cite its tags instead of re-deriving dimensions. Review/audit deliverables (a review that files follow-ups, a regression-package review, a logs/dependency audit) live under `.agents/reviews/<id>/` (REPORT.md + scans/*) — never improvised inside `.agents/features/`.
- **Test quality is gated too (T1–T10).** `npm run test:wiring` fails any `*.test.*` file no package script executes (an orphan test is not coverage, T7); `node scripts/qa/check-linger.js -- <tier>` flags a suite whose process lingers far past its runner-reported test time (open handle / teardown, T1/T6/T9). Tags: `.agents/memory/test-design-parameters.md`; authoring checklist: `.agents/skills/qa-architect/SKILL.md`.
- Persona map, waivers, and the dispatch-failure ladder: `.agents/AGENTS.md` §5 and `.agents/memory/model-routing.md`.
- **Features**: capture a found item as one light row in the canonical `BACKLOG.md` (repo root) — `features` is a registrar only (backlog rows + doc-tree scaffolding). **Update the board with the `backlog_*` tools (or `node scripts/backlog.js`), never hand-edit `BACKLOG.md`.** The moment a session starts dealing with a backlog item, move its row `Open` → `In progress` (`backlog_take`, pointing `Handoff` at the session's `.agents/handoffs/<id>.md`) so active work is visible on the board. On pickup, author the per-feature doc chain by dispatching each author persona **directly** (`product-manager`/`system-architect`/`planner`/`qa-architect`) — never via `features`. Right-size ceremony to risk.
- **Queue → next**: `backlog queue <id>` moves an `Open` row to `Queued` (a ready-to-pull lane). `/next` (or `backlog next --take`) pulls the top-priority *unblocked* `Queued` row into `In progress` to start this session's standard flow — deterministic, no manual ID pick; a row whose `Depends on` IDs aren't all archived is skipped/refused (`backlog depends <id> --on <ids>` sets it). If the queue is empty or fully blocked it stops instead of inventing work.
- **Docs**: human-facing docs (`README.md`, `CHANGELOG.md`, `docs/**`) are owned by the `docs` persona (`.agents/skills/docs/SKILL.md`) — docs point at code, never duplicate it, and `npm run test:docs` enforces no placeholders / no dangling links / well-formed ADRs / every shipped commit has a changelog entry (cited by short hash).
- **Product intent is never optional.** A feature never reaches planning/implementation without defining its user. `intent.md` must carry Actor(s) → Need → Outcome → Acceptance criteria, and `plan.md` a Value-first sequence + Product concepts applied — `npm run test:product` fails otherwise. Planning reads `.agents/memory/product-principles.md` and is value-led, not tech-led.
- Every subagent returns the output contract (`Result` → `Evidence` → `Deferred & risks`).
- Wrap up with a **dispatch log** (`subagent → model → shipped/deferred`) in your session's `.agents/handoffs/<feature-id>.md`.
- **Report value-first.** The completion message to the user opens with **Value shipped** — a plain-language sentence on what the user now gets and why it matters — then **How** (the main approach, a sentence or two). Technical file/test/commit detail follows; it is never the headline. The handoff file carries the same summary in its `## Value shipped` + `## How` sections.

## Dispatch economics (spend inference only where it earns value)

- **A persona's existence is never a reason to dispatch it.** Dispatch only when a persona produces a distinct deliverable the main model cannot cheaply do itself: real implementation/reasoning in a bounded owned scope that reduces risk or parallelizes genuinely disjoint work.
- **Orchestrator-only (never a subagent):** reads needed for orchestration, `git status`/`diff`, worktree/branch creation, commits, merges, final integration, simple moves/renames, mechanical search-replace, collecting outputs, summarizing results, simple command runs.
- **Complexity threshold → direct execution.** Trivial or single-surface/single-file changes (rename, typo, constant, one-line doc, simple CSS, config tweak) bypass the pipeline: main model implements → targeted gate → done. The planner may conclude `execution_mode: direct` (with a reason) instead of emitting dispatches.
- **Absorb before spawn.** If an already-dispatched or just-completed persona can absorb a small related change inside its owned scope, extend that dispatch instead of spawning another. Never cross ownership/contract boundaries to save a dispatch.
- **Bounded retries.** Retry once (resume the same `task_id`) with a reason; a second retry MUST change one of instructions / context / model / decomposition / diagnostics. Identical prompt+context+model+failure twice = stop and escalate/report, never loop.
- **Stuck-agent detection.** Stop a persona that repeats the same reads, tool calls, test failures, or rewrites the same region with no new evidence or changed files. Classify the blocker, one targeted recovery, then escalate or report — never burn turns.
- **Early stop.** A persona stops the moment its `Done =` gate passes and its deliverable is verified — no post-hoc "improving" past the acceptance bar.
- **Escalation is evidence-based** (see `.agents/AGENTS.md` §5): escalate to the Pro tier only on repeated failure, contradictory evidence, cross-module ambiguity, security-sensitive ambiguity, or an unsafe-workaround risk — never on a long answer or vague uncertainty.
- **Parallel = genuinely disjoint.** Never fan out to N personas because N roles exist; launch the minimum that maximizes useful independent work (disjoint owned files AND contracts). Small tasks are usually cheaper serial.
- **Compact results downstream.** Pass a persona's structured `Result`/`Evidence`/`Deferred & risks` summary — never a full verbose transcript — to the next consumer.

## Context budget & lifecycle (bounded orchestration)

The main orchestrator context is a cumulative cost. Guard it; do not let a single
session grow without bound. Thresholds are tunable in
`.agents/memory/orchestration.md` — resolve numbers there, not from memory.

- **Feature-scoped context**: one bounded orchestration lifecycle per meaningful
  work unit. Do not let one feature's large context become the long-term home for
  unrelated features, architecture/backlog/process discussion, or other sessions'
  debugging.
- **Checkpoint, don't grow**: when a session approaches the `soft_turn_budget` /
  request-context thresholds in `orchestration.md`, write a compact deterministic
  checkpoint to the session's `.agents/handoffs/<feature-id>.md` (task id/feature/
  objective/phase, completed + active dispatches, files changed, contracts,
  known facts, decisions, risks, next_action) and prefer to continue in a fresh
  bounded context that reads the checkpoint — never by replaying the transcript.
- **No abrupt kill**: a currently-running tool call finishes; the budget triggers a
  checkpoint/finish, not a mid-operation abort.
- **Cache-friendly prefix**: keep the stable leading context (operating rules →
  persona → project rules) byte-stable across turns; never regenerate equivalent
  instructions in new wording (the cache is an asset).
- **Large tool outputs**: treat reads as evidence, but do not let a big read/diff/
  test dump live forever in a long-lived context — checkpoint and move on.

## Verification & retry discipline (deterministic)

- **Gate batching**: make a coherent set of related edits, THEN run the gate once —
  avoid edit → gate → edit → gate per micro-edit. A gate stays mandatory when the
  dispatch says so, a dependency needs its result, the batch is complete, or the
  agent is about to report done.
- **No identical re-runs**: do not re-run the same command in the same session
  with the same state and expect a different result. Repeated-command/retry-loop
  heuristics (`same_failure_turns`, `identical_tool_calls`, `no_state_change_turns`)
  live in `orchestration.md`. A second attempt MUST change instructions / context /
  model / decomposition / diagnostics.
- **Patch/apply failures**: on a failed file write/patch, refresh the target file,
  regenerate a targeted patch, and retry ONCE. Never blindly replay the identical
  patch. Record `patch_failure` + `retry` in the session handoff.
- **Web/network failures**: one retry when transient; then fall back (`webfetch`,
  repository-local evidence) or report. Never loop query variations hoping the
  network changes.

## Non-negotiable laws

1. **Zero speculation** — base every fix/decision on observed logs, telemetry, or DB state; instrument first if evidence is missing.
2. **No hardcoded mocks/fallback data** — prefer dynamic queries and database-backed settings.
3. **5 UI states** (ideal/empty/loading/error/partial), user-visible errors (never `console.warn`-only), and RTL-safe logical props.
4. **Product-first planning** — define the actor/need/outcome/acceptance before code; sequence work value-first against `.agents/memory/product-principles.md`.
5. **Verify stack versions** before writing framework code (`.agents/memory/stack-versions.md`).
6. **Token discipline** — search before read, targeted reads, batch reads, don't re-read unchanged files, right-size QA.
7. **Static ≠ runtime** — never declare verified from `tsc` alone; execute a real runtime/API path that exercises the MODIFIED code — a tier label never proves coverage. `test:qa-plan` gates every changed code path to a covering assertion or waiver, and every touched flow's sibling surfaces / variants to an audit entry (`.agents/memory/flow-map.md` — "fix one, fix all"). An assertion counts only with an independent oracle, a single owner, and a wired tier — `test:wiring` gates orphans (T7) and a passing-but-idling suite is not a pass (linger check, T1/T6/T9). A runtime tier that needs a live server: start it detached (`node scripts/serve.js start --cmd "<dev command>" --url <health url>`; never background it in your shell — `&`, `Start-Job`, `Start-Process -NoNewWindow`, or anything that shares the tool's console freezes the tool; `serve.js` launches it in its own hidden console on Windows so the call returns), then `node scripts/serve.js stop` when done. If the live-tier call is interrupted, don't infer state from the abort — verify via `node scripts/serve.js list` + `.serve/<name>.out.log` + the health URL; never kill a server on a port you didn't start.
8. **Commit** with `feat:`/`fix:`/`refactor:` then push to main — including any `BACKLOG.md` delta. **Integrate early**: `git rebase main` then re-run `test:backlog` + `test:concurrency` (or `npm run test:integrate`) before pushing, so board/code conflicts surface now, not at the merge.
9. **Environment data boundary** — three environments: `development` (dirty by design — QA/test data lives here), `uat`, `production` (enforced clean). Only code + schema migrations + idempotent seeds move forward; never dump/restore data across environments. The registry is `.agents/memory/environments.md`. Finalizing a task = deploy to `uat` (`devops-engineer` → `deploy:uat`, then `test:data-hygiene -- --env uat`); production is human-gated.

## Definition of Done

QA tier + security lens gate **code changes only** (a backlog-only change skips them). Every session opens with **move the picked-up row `Open` → `In progress`** (`backlog_take`) and closes with **move shipped `BACKLOG.md` rows from `In progress` to `Archive` (`backlog_archive`) → commit → push** — the backlog write-back is never QA-gated. Feature work is additionally gated by `test:product` (product intent + value-led plan). Every shipped change is finalized by deploying to **UAT** (`devops-engineer` → `deploy:uat`, then `test:data-hygiene -- --env uat`); production is human-gated and out of the per-task flow.

## Session checklist

Start: read `.agents/memory/locations.md` + `.agents/memory/model-routing.md` + `.agents/memory/orchestration.md` (context/turn budgets) + `.agents/memory/environments.md` + `BACKLOG.md`, then isolate: `backlog worktree <id>` (creates a `git worktree` + branch, auto-takes the row, and records the path in the row's `Handoff`) — every feature works in its own worktree, `main` stays board + shippable code only. Record the row's owned files (`backlog owns <id> --files ...`), and name the worktree path in every dispatch spec's `Working tree` so subagents verify their checkout before editing. End: `git rebase main` + re-run `test:backlog`/`test:concurrency`, move shipped `BACKLOG.md` rows from `In progress` to `Archive` (`backlog_archive` — this also removes the feature's worktree + merged branch, so a session's checkout never lingers), record the dispatch log, and update the handoff memory.
