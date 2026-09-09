# Project Rules & Operating Guidelines

The canonical rulebook. The always-loaded summary is `.agents/rules/00-operating.md`.

## 1. Fact-Based, Zero-Guessing SDLC

- **Zero-Speculation Rule**: NEVER guess, hypothesize without evidence, or assume the root cause of an error, performance lag, or system behavior. Speculation is forbidden across all personas and workflow stages.
- **Evidence-First Engineering**: Every diagnostic conclusion, fix, architectural decision, and enhancement MUST be grounded in observable facts: live server logs, telemetry traces, database records, or verified runtime execution. Know the project's debug/log endpoints — they are (or should be) recorded in `.agents/memory/locations.md`.
- **Mandatory Telemetry Before Fixes**: If logs or telemetry are absent or insufficient, FIRST add structured instrumentation, execute or have the user reproduce, inspect the captured output, and ONLY THEN implement based on that data.
- **Authentic Runtime Execution**: Never substitute real runtime calls with ad-hoc scripts that bypass actual config, env vars, middleware, or request pipelines. Verify through the real APIs/functions the app uses.
- **Scientific Progression Gate**: A fix is not complete until live logs or automated runtime tests demonstrate the failure mode no longer occurs in real runtime conditions.

## 2. Dynamic Data & Business-Logic Integrity

- **No Hardcoded Mock Lists**: Never create hardcoded lists (fake records, mock reviews, static fallback arrays) without explicit user approval. Prefer dynamic queries and database-backed settings.
- **Environment data boundary (never leak test data forward)**: three environments — `development` (dirty by design: QA/test data lives here), `uat`, and `production` (both enforced clean). Only code, schema migrations, and idempotent seeds move FORWARD (dev → uat → prod); data never does — no `pg_dump`/restore/copy of one environment's database into another. The canonical registry is `.agents/memory/environments.md`.

## 3. UI, Mobile Ergonomics & RTL Support

- **Zero Native Popups**: Never use `Alert.alert()`, `alert()`, `confirm()`, or `prompt()`. Use inline toasts, bottom sheets, inline state transitions, or haptics.
- **Progressive Hydration & Cold-Start**: Never render empty states while waiting on async auth/sync. Hydrate from local cache so the UI renders immediately.
- **The 5 Essential UI States**: Every screen/list component must handle Ideal, Empty (with CTA), Loading (skeleton), Error (retry), and Partial/single-item states.
- **Error-Handling Contract (Mobile)**: Every `catch` block in a native screen must (1) fire an error haptic, (2) set a user-visible error state that renders inline — never `console.warn` alone, and (3) provide a retry or dismissal path. Follow the reference pattern in `.agents/skills/mobile-engineer/SKILL.md`.
- **Cross-Screen Consistency ("Fix One, Fix All")**: When you implement a UX pattern in one screen, grep for analogous screens and apply it globally; if scope is too large, log a deferred item in the handoff with exact files/patterns. A local-only fix is a regression-in-waiting. Mechanically enforced by `test:qa-plan` via `.agents/memory/flow-map.md`: a change that touches a registered flow must address EVERY sibling surface (other codebases like `mobile/`, other layers) and every declared optional variant in the QA-plan audit — covered `->`, or `audited:` with a reason (including `deferred — logged in handoff`). A sibling the plan does not name fails the gate.
- **Bidirectional & RTL**: Use logical properties (`ps-*`, `pe-*`, `ms-*`, `me-*`, `text-start`, `text-end`) never physical ones (`pl-*`, `left-*`); use inverted horizontal lists / direction-aware layout in native RTL; pass dynamic `dir` to UI primitives.
- **Legacy Pruning & Physical Walkthrough**: When introducing a new flow/paradigm, explicitly audit and PRUNE obsolete mechanisms that contradict it — never bolt new steps on top of removed ones. Trace every physical/interaction flow step-by-step from each actor's perspective to eliminate unnecessary friction.

## 4. Framework & Backend Architecture

- **Verify Stack Versions First**: Confirm versions against `.agents/memory/stack-versions.md` before writing framework-specific code. Never assume a newer/older convention.
- **Stack-Specific Gotchas**: Framework/library gotchas (async route params, strict-typing quirks, ORM generator/config layout, native runtime caveats) live in `.agents/memory/stack-versions.md` — read the relevant section before coding against that layer.
- **Privacy & Visibility Tiers**: Enforce the project's tier model (`.agents/memory/domain-map.md` §Visibility tiers) across all data-access endpoints.
- **Environments**: read `.agents/memory/environments.md` for the three environments (dev/uat/prod), their databases, deploy commands, and seed commands. Live/QA tiers target the `development` DB only.

## 5. Token Efficiency & Workflow Discipline

- **When NOT to Plan**: No heavy planning docs for simple fixes, CSS/layout tweaks, or single-file changes — execute directly.
- **Precise File Inspections**: Search first (`grep`), then read targeted line ranges — never whole 800+ line files blind. Batch independent searches/reads in parallel.
- **Don't Re-read Unchanged Files**: Edit files already in context directly.
- **Delegate Big Searches**: Use the `explore` subagent for broad multi-file exploration.
- **Prefer Memory over Re-derivation**: Persist non-obvious facts to `.agents/memory/`; read the relevant memory files before starting.
- **Locations Map**: Read `.agents/memory/locations.md` first — it is the canonical index of sessions, logs, docs, and data. Never re-hunt for a path.
- **Step Zero — Subagent & Model Routing (non-negotiable)**: Before touching code, satisfy the dispatch gate (`.agents/rules/00-operating.md` §Step Zero). Personas: `planner`, `frontend-engineer`, `mobile-engineer`, `ui-designer`, `qa-architect`, `qa-runner`, `security-engineer`, `product-manager`, `system-architect`, `diagnostics-expert`, `data-engineer`, `devops-engineer`, `handoff`, `features`, `docs`. Dispatch via the `task` tool — each runs its own `model:`. Do NOT inline persona-owned work on the main model. Read `.agents/memory/model-routing.md` at session start. Dispatch subagents in parallel only when their work is disjoint (see below).
  - **Persona map**:
    | Work area | Persona |
    |---|---|
    | Task decomposition → value-led dispatch plan (product-first) | `planner` |
    | Web app (React/Next.js/Tailwind/shadcn) | `frontend-engineer` |
    | Mobile native (Expo/React Native) | `mobile-engineer` |
    | Design system / tokens / shared components | `ui-designer` |
    | QA strategy (risk + tier + progression tests) | `qa-architect` |
    | QA execution (run tiers, data cleanup) | `qa-runner` |
    | DB schema / data model / tenancy / sync | `system-architect` |
    | Auth, secrets, input validation, deps | `security-engineer` |
    | Error / performance / API debugging | `diagnostics-expert` |
    | Features, gamification, product journeys | `product-manager` |
    | Data ingestion / entity resolution | `data-engineer` |
    | Deployment (dev→uat→prod promotion) / cron / secrets / build+release | `devops-engineer` |
    | Session wrap-up / handoff | `handoff` |
    | Feature backlog registration + doc-tree scaffolding (registrar only — not authoring) | `features` |
    | Human-facing docs (README / CHANGELOG / docs / ADRs) | `docs` |
  - **Feature docs, not ceremony**: capture a found item as one light row in
    the canonical `BACKLOG.md` (repo root). **Update the board with the `backlog_*`
    tools (or `node scripts/backlog.js`), never hand-edit `BACKLOG.md`.** `features`
    is a registrar only — it
    registers rows and scaffolds the `.agents/features/<slug>/` tree, never authors
    content. When a feature is picked up, author the doc chain by dispatching each
    author persona **directly** — `intent` (product-manager) → `scope`
    (system-architect, HIGH-risk only) → `plan` (planner) → `tests` (qa-architect).
    For an "investigate + plan" request (no code), dispatch `planner` and/or
    `product-manager` directly — never `features`. Match ceremony to blast radius:
    trivial → none, low → single `intent.md`, high (auth/DB/API/flow-siblings) →
    full chain. Write back first (update the doc before continuing when
    implementation invalidates it), archive on ship. Feature docs are durable and
    complementary to the per-session
    `.agents/qa-plans/<feature-id>.md`/`.agents/handoffs/<feature-id>.md`; the `tests` doc points to the
    feature's QA plan, never duplicates it. The moment a session starts dealing
    with a backlog item, move its `BACKLOG.md` row `Open` → `In progress` (`backlog_take`, pointing
    `Handoff` at the session's handoff file) so active work is visible on the board.
    A `Queued` row is a ready-to-pull lane: `backlog queue <id>` allocates an `Open` row
    into it, and `/next` (or `backlog next --take`) pulls the top-priority `Queued` row
    into `In progress` to start a session (empty queue = stop, never invent work).
  - **Product intent is never optional (no silent skip)**: planning is
    product-first. `intent.md` must define Actor(s) → Need → Outcome → Acceptance
    criteria, and `plan.md` a Value-first sequence + Product concepts applied, read
    against `.agents/memory/product-principles.md`. `npm run test:product` fails any
    feature doc missing these, or a `plan.md` with no `intent.md` — mirroring the
    "QA planning is never optional" ladder: `product-manager`/`planner` →
    orchestrator fallback → (never a silent skip).
  - **QA planning is never optional (no silent skip)**: every change that touches
    code paths MUST get a QA plan before it is verified. The plan is authored by
    `qa-architect` (thinker). If `qa-architect` is not dispatched — for ANY reason,
    including dispatch failure or simply not invoking it — the **main orchestrator
    performs the qa-architect role itself** and writes the same coverage plan into
    a per-change file under `.agents/qa-plans/` (one file per change, named by
    `BACKLOG.md` ID or slug — never edit another change's plan file). The QA
    plan/copy escalation ladder NEVER leaves a code change unplanned: `qa-architect` ->
    orchestrator fallback -> (never a silent skip). `npm run test:qa-plan` enforces
    that every changed code path has a covering assertion or a waivered reason.
  - **Waivers** (the only way to skip a persona): a persona may be skipped only when (a) the change is fully covered by an automated gate on push or in the QA tiers, AND (b) the skip is pre-audited in `.agents/memory/` with a cited pointer. Log every waiver as `waived: <persona>` with `reason: <gate|pointer>`.
  - **Dispatch failure ladder & bounded retries** (never silent): retry once (resume the same `task_id`); a second retry MUST materially change one of instructions / context / model / decomposition / diagnostics — identical prompt + context + model + failure repeated twice is a loop, so stop and escalate or report instead of repeating. If it still fails, do the work inline and log `degraded: <persona> model: <reason>`; never silently skip.
  - **Bound every dispatch (task spec)** — never hand a persona a bare metric ("get under N lines", "type everything"). Each dispatch prompt carries: `Objective` (one deliverable) → `Working tree` (the exact feature-worktree path/branch — or `main` — this task edits; the subagent verifies it before touching a file) → `Owned files` (exact paths) → `Read-only files` → `Shared contracts (owns|consumes)` → `Done = <gate command + observable metric>` → `Out-of-scope`.
  - **Parallel = disjoint** — run personas in parallel only when their owned files AND shared contracts are disjoint; otherwise serialize, with the shared-contract owner dispatched first.
  - **Orchestrator acceptance gate** — after a persona reports done, re-run the gate yourself (`tsc --noEmit`, `npm run lint:hooks`, `npm run test:quick`) and grep the metric before integrating or committing. A subagent's `Evidence` is a claim, not proof.
  - **No suppression shortcuts** — never accept (or produce) file-level `/* eslint-disable */`, `@ts-nocheck`, or `@ts-ignore` to hit a metric. Suppressions are line-level only and each carries a reason — a file-level disable is a rules violation, not a fix.
  - **Dispatch-value gate** — the existence of a persona is NEVER itself a reason to dispatch it. Dispatch only when the persona produces a distinct deliverable with clear ownership and a measurable `Done =` gate that the main model cannot cheaply do itself. Reads, `git status`/`diff`, worktree/branch ops, commits, merges, final integration, simple moves/search-replace, collecting outputs, summarizing results, and simple command runs are ORCHESTRATOR work — never a subagent. A dispatch that is only a repository read, a search, a git op, a trivial edit, or context the orchestrator already holds is unnecessary and must be done inline.
  - **Complexity threshold → direct execution** — trivial or single-surface/single-file changes (rename, typo, constant, one-line doc, simple CSS, config tweak) bypass planning + fan-out: main model implements → targeted gate → done. The planner may emit `execution_mode: direct` (with a reason) instead of a multi-agent dispatch — planning may REDUCE the number of agents, not just choose which to spawn.
  - **Absorb before spawn** — before a new dispatch, ask whether an already-running or just-completed persona can safely absorb the work within its owned scope and contract; extend that dispatch instead of spawning another. Never cross ownership/contract boundaries to save a dispatch.
  - **Stuck-agent detection** — stop a persona that repeats the same reads, tool calls, test failures, or rewrites the same region with no new evidence or changed files. Classify the blocker, attempt one targeted recovery, then escalate (if justified) or report the blocker — never burn more turns.
  - **Early stop** — a persona terminates as soon as its `Done =` gate passes and its deliverable is verified; it must not keep "improving" past the acceptance bar. Completion is evidence-based (the gate output), never self-reported confidence.
  - **Evidence-based escalation** — escalate a persona to the Pro tier only on: repeated failure after materially different fixes, contradictory evidence, cross-module reasoning failure, security-sensitive ambiguity, unresolved concurrency/state issues, or a genuinely-blocking workaround risk. Do NOT escalate on a long answer, technical complexity alone, a request for more context, or uncertainty without evidence. Model tiers: `.agents/memory/model-routing.md`.
  - **Compact result propagation** — when one persona's output feeds another, pass the structured `Result`/`Evidence`/`Deferred & risks` summary (or the structured facts: changed files, commands run, test results, contracts changed, blocking issue) — never a full verbose transcript — so later personas consume established facts instead of re-discovering requirements, architecture, or locations.
- **Synchronous Terminal Commands**: Prefer sync one-shot commands (build/test/lint) that return inline, over background servers/watchers. When a tier genuinely needs a live server (runtime/API tiers), start it detached with `node scripts/serve.js start --cmd "<dev command>" --url <health url>` (or `--port <n>`) — it returns immediately and records the PID under `.serve/`. Never background a long-running server in your own shell (foreground, `&`, `Start-Job`, `Start-Process -NoNewWindow`, or any launch that shares the tool's console): the tree stays attached to the tool's console, so the call hangs until you interrupt it. `serve.js` gives the server its own hidden console (Windows) / detached session (POSIX) so the tool returns, and prints a "launching" line + heartbeats while waiting (a live start is never silent). Poll the health URL/port to know it is up (never `sleep`-and-pray); on a failed start read `.serve/<name>.out.log`; stop with `node scripts/serve.js stop` / `stop-all` when the tier passes — never leave a dev server running. Never pipe a `serve` start or a long test run through a buffering filter (`| Select-Object -Last N`, redirect-to-file-then-read) — let it stream, or the run looks frozen and gets aborted mid-flight. If a live-tier call IS interrupted, don't infer the server state from the abort: verify with `node scripts/serve.js list`, `.serve/<name>.out.log`, and the health URL before continuing. Never kill a process on a port you didn't start (`node scripts/serve.js list` / port owner first) as a "leftover".
- **No Output Bloat**: Never paste large files/diffs into chat; apply edits with the edit tool, never print a code block of a change.
- **Right-Size the QA Tier**: Never run the full regression suite for a CSS/copy tweak.
- **Gate batching**: make a coherent set of related edits, THEN run the gate once — never edit → gate → edit → gate for micro-edits in the same batch. A gate stays mandatory when the dispatch says so, a dependency needs its result, the batch is complete, or the agent is about to report done. If one edit's failure blocks the batch, resolve it first — but do not re-run an unchanged gate as a ritual.
- **Repeated-command / retry-loop detection**: never re-run the same command in the same session with the same state expecting a different result. When a command would repeat (`same_failure_turns` / `identical_tool_calls` / `no_state_change_turns` — thresholds in `.agents/memory/orchestration.md`), stop, change something material (instructions / context / model / decomposition / diagnostics), or report. A gate repeated with `files_changed = 0`, the same command, and the same failure is a retry loop, not a retry.
- **Patch / file-write recovery**: on a failed patch or write, refresh the target file, regenerate a targeted patch, and retry ONCE — never blindly replay the identical patch. Record `patch_failure`/`retry` in the session handoff. On repeated failure, switch editing strategy (smaller patch, different anchor, write full file).
- **Web / network failure handling**: one retry when the failure is transient; then fall back (`webfetch`, repository-local evidence, vendor docs already in context) or report the blocker. Never loop query variations hoping the network changes. Record the failure + fallback in the handoff.
- **Context budget & checkpointing** (see also `.agents/rules/00-operating.md` §Context budget & lifecycle): the main context is a cumulative cost. One bounded orchestration context per work unit; checkpoint compact deterministic state (task/feature/objective/phase, completed + active dispatches, files changed, contracts, known facts, decisions, risks, next_action) into `.agents/handoffs/<feature-id>.md` when approaching the budgets in `.agents/memory/orchestration.md`; resume in a fresh bounded context from the checkpoint, never by replaying the transcript. Never kill a running tool call — let it finish, then checkpoint/finish. Keep the stable leading context (rules → persona → project rules) byte-stable so it stays cache-friendly.

## 6. Smart Tiered Testing & Progression Protocol

- Never run heavy regression suites blindly for small changes.
- Split QA personas: `qa-architect` (thinks — inspects the diff, audits gaps, selects the minimal tier, authors progression tests) vs `qa-runner` (does — executes the chosen tier, reports pass/fail verbatim). The thinker never runs; the doer never designs. Because `qa-architect` is `bash: deny`, an architect-authored progression is NOT verifiable until `qa-runner` load-gates it first (`node --check` for `.js` suites; load + ≥ 1 executed assertion for `.ts`) — never let an architect-authored file reach "done" on the strength of a plan alone.
- **Static ≠ Runtime rule**: never declare UI/mobile/API changes verified from static typing alone — execute a real runtime path.
- **Coverage ≠ label rule**: a tier command verifies a change ONLY when its backing suite actually exercises the changed path. A suite that touches unrelated code proves nothing about this change. `npm run test:qa-plan` mechanically asserts every changed code path is covered by the QA plan (or waivered) before verification — and, via `flow-map.md`, that every touched flow's sibling surfaces and declared optional variants are addressed in the plan's audit (the "fix one, fix all" gate: a web-only diff must still say what the mobile twin does).
- **Tiers** (commands are **project-provided** — the target project must define them; the harness ships only its own gates: `test:dispatch`, `test:governance`, `test:qa-plan`, `test:backlog`, `test:product`, `test:docs`, `test:concurrency`, `test:integrate`, `test:quality`):
  | Tier | Scope | Command |
  |---|---|---|
  | 1 | UI/CSS/mobile/copy | `npm run test:quick` |
  | 2 | Routes / page layout | `npm run test:routes` |
  | 3 | API / ORM / transactions | `npm run test:api` |
  | 4 | Data ingestion | the project's data E2E script |
  | 5 | Major release / breaking refactor | `npm run test:verify` |
  | 6 | Security / deps | `npm run test:security` |
- **Live-server tiers (3+)**: a runtime/API tier that hits real routes needs the
  dev server running. Start it detached with `node scripts/serve.js start --cmd "<dev command>" --url <health url>`
  and stop it when the tier passes (`node scripts/serve.js stop`) — see §5. Live-tier calls: never pipe a start or the
  tier run through a buffering filter (`Select-Object -Last N`) — it looks frozen and invites an abort; if a call IS
  interrupted, don't infer state — verify via `node scripts/serve.js list` + `.serve/<name>.out.log` + the health URL.
- **Live QA targets the development environment only**: runtime/API tiers and data-E2E runs execute against the dev database (`DATABASE_URL`). They never touch uat/prod; the forward boundary (`.agents/memory/environments.md`) is enforced at deploy time by `test:data-hygiene -- --env uat|prod`, not by dev-time runs.
- **Progression Workflow**: for new routes/endpoints/states, (1) author a dedicated assertion path, (2) run the targeted progression test, (3) graduate it into the permanent regression suite. A change is NOT verified if the executed tier's backing suite never exercised the modified path — author a progression test for that path first (this is the "GAP" rule).

## 7. Definition of Done & Continuous Backup

Every completed task closes with this gate. **QA gates dev work only:** steps 0-2
run when the session touched code paths — a backlog-only (or docs-only) change skips
them. Steps 3-7 are the unconditional session close; they are NOT gated by QA.

0. **Feature Completeness Gate** (code changes only):
   - [ ] Product-first: `intent.md` (actor/need/outcome/acceptance) + value-led `plan.md` present — `npm run test:product` green (feature work only).
   - [ ] 5 UI states handled on every affected screen (list them).
   - [ ] No `catch` blocks that only `console.warn` without user-facing feedback.
   - [ ] Haptic/feedback consistency for every user-initiated action.
   - [ ] RTL traced if layout touched; logical properties used.
   - [ ] Cross-screen audit if a new UX pattern was introduced.
   - [ ] No modified file over ~500 lines without extracting components.
   - [ ] No blanket file-level `eslint-disable`/`@ts-nocheck`/`@ts-ignore` suppressions (line-level only, each with a reason).
   - [ ] No dead export / oversized file introduced in NEW/GROWN code — `npm run test:quality` green on the diff (rubric: `.agents/memory/quality-parameters.md` P1/P3).
1. **QA tier** (code changes only) — `qa-architect` inspects the diff, picks the tier BY COVERAGE (not path-label), records the coverage map in a per-change plan under `.agents/qa-plans/` (one file per change — never edit another change's plan), and authors progression tests for any GAP; if `qa-architect` is not dispatched the orchestrator plans in its place. `qa-runner` executes and makes it pass (§6). A change is not verified until `npm run test:qa-plan` passes: every changed code path covered or waivered, **and** every touched flow (`.agents/memory/flow-map.md`) has every sibling surface and declared variant addressed in the plan's `## Parallel-surface & variant audit`, **AND** the executed tier exercised the modified path.
2. **Security check** (code changes only) — apply `security-engineer` when the change touches data/auth/input/secrets/deps.
3. **Backlog write-back** (always) — move every task this session shipped from `In progress` to `Archive (shipped · done)` in `BACKLOG.md` (`backlog_archive`, with date/commit), then stage it explicitly: `git add BACKLOG.md` (it starts untracked — `git commit -am` / `git commit` without `add` will NOT pick it up). The board syncs across sessions only through git, so this delta is committed with the code, never left uncommitted. (At session start, the inverse: move the picked-up row `Open` → `In progress` via `backlog_take`, pointing `Handoff` at the session's `.agents/handoffs/<id>.md`, so the board always shows what is actively being worked.)
4. **Docs write-back** (always, on ship) — dispatch the `docs` persona to keep human-facing docs in sync with this session's shipped change: append a `CHANGELOG.md` line that cites the commit short hash (`git rev-parse --short HEAD`), and update `README.md` / `docs/**` / ADRs when the change adds or renames a subsystem, flow, public API, or hard-to-reverse decision (`.agents/skills/docs/SKILL.md`). `npm run test:docs` fails on any shipped commit with no changelog entry, so a docs-only `chore`/`docs` commit is not enough — the changelog delta ships in the same commit as the code. Right-size: a copy/CSS tweak needs at most a changelog line.
5. **Commit** (always) — concise `feat:` / `fix:` / `refactor:` message, including the `BACKLOG.md` and `CHANGELOG.md` deltas.
6. **Push** (always) — `git push origin main`. **Integrate early first**: `git rebase main`, then re-run `npm run test:backlog` + `npm run test:concurrency` (or `npm run test:integrate`) before pushing, so board/code conflicts surface now instead of at the merge.
7. **Deploy to UAT** (always, after push — the finalize step) — dispatch `devops-engineer` to run the project's `deploy:uat` (build + `prisma migrate deploy` + idempotent seed) and then verify uat is clean of test-data markers (`npm run test:data-hygiene -- --env uat`). Production is human-gated and NOT part of a normal task. Never forward dev data — code + schema + idempotent seeds only (`.agents/memory/environments.md`).
- **Mechanical floor**: a pre-push hook should run `npm run test:quick` (project-provided; the harness does not install git hooks).
- **Concurrency isolation (never let a concurrent session's WIP block yours)**: the board + a shared working tree means one session's half-done files (e.g. a page referencing translation keys not yet in `messages/*.json`) can fail *another* session's push for no fault of its own. The harness ships mechanical counters:
  - `test:concurrency` (`node scripts/qa/check-concurrency.js`) fails a push when the board shows 2+ `In progress` rows while the working tree has uncommitted changes — the collision is *provable*, so it fails fast instead of surfacing as a random `check-translations`/`tsc` error. Declare each row's owned files (`.agents/memory/owned-files.md`, via `backlog owns <id> --files ...`) and the gate fails *exactly* when a dirty file is owned by two In-progress rows (or a tree mixes two sessions' WIP), instead of on every "2+ In progress + dirty" tree.
  - **Isolate per feature** with `backlog worktree <id>` (or the `backlog_worktree` tool): it creates a `git worktree` + branch for the feature and records the path in the row's `Handoff` cell. Run it from the **main** tree before starting ANY feature — `main` stays board + shippable code only, every feature works in its own checkout, and another session's WIP can't leak into your gates. Worktrees live in a hidden sibling container (`<repo>/../.worktrees/<repo>/<id>`), and `backlog archive <id>` removes a shipped feature's worktree + merged branch — so the parent folder stays clean and a session leaves nothing hanging after it closes.
  - **Row-aware merge driver**: `.gitattributes` routes `BACKLOG.md` through `scripts/qa/merge-backlog.js`, so two sessions editing *disjoint* rows merge by ID instead of conflicting (`agent-harness init/update` wires the driver).
  - **Ordering**: a row's `Depends on` cell (`backlog depends <id> --on <ids>`) makes ordering machine-readable — `/next`/`take`/`worktree` skip or refuse a row whose dependencies aren't archived.
  - **Snapshot gating**: `node scripts/qa/run-clean.js -- npm run test:quick` runs a project gate against the *committed* state (stashes + restores any dirty files), so a pre-push gate verifies *your* committed work, not the tree. Prefer this wrapper in the pre-push hook for tree-scoped gates.
- **Lean permissions**: grant only the narrowest `git`/`gh` action needed; escalate only after a command has actually failed.
- Git may not be on PATH in the default shell — use the full path (`.agents/memory/locations.md`).

## 8. Session & Traceability Discipline

- **One session = one coherent task**; keep a short checklist as the single source of truth.
- **Harness-update awareness**: `npx @dombaras/agent-harness update` auto-commits the harness files it changes as `chore(harness): @dombaras/agent-harness <old> -> <new>`. If you see such a commit (or modified `.agents/**`, `scripts/qa/**`, `AGENTS.md`, `opencode.json` you didn't touch), do NOT treat it as unexplained — run `git log -1 --stat` / `git show` to see exactly which harness files changed and why, then read the rulebook. Never guess at the cause.
- **Planned vs. Shipped**: at session end, record a "planned → shipped → deferred" delta so aspirational docs are never mistaken for reality. Always verify against live code and schema.
- **Value-first completion report**: close a session by telling the user, in plain language, **what value shipped** (what they now get / what changed for them) and the main **how** — before any file/test/technical detail. The same summary is recorded durably in the handoff's `## Value shipped` + `## How` sections.
- **Dispatch Log (mandatory)**: every wrap-up opens with `subagent → model → shipped/deferred`. An empty log is non-compliant.
- **Structured session telemetry**: every handoff records, when known and never fabricated:
  - `work_type` — one of `feature | bugfix | investigation | architecture | planning | qa | security | maintenance | process | conversation | other`.
  - `outcome` — one of `shipped | resolved | deferred | investigation-complete | abandoned | superseded | conversation-only`.
  - `termination_reason` — why the session ended (e.g. `gate-pass`, `checkpoint`, `blocked`, `escalated`, `abandoned`).
  - Retries/escalations with `attempt` numbers and reasons (see §5 bounded retries).
  - `null` / `unknown` when the runtime cannot know a value — never infer exact token/cost numbers from character counts, and never invent values.
  These feed the deterministic `npm run report` (agent-report) so feature economics are measurable without reading transcripts.
- **Persist Continuity**: use the `handoff` skill to write your session's file under `.agents/handoffs/` (one per session — never edit another session's). Project history lives in `.agents/memory/history.md`; stack facts in `.agents/memory/stack-versions.md`.
- **Pointers Map Hygiene**: record every created/discovered/changed important location (session archives, scratch scripts, logs, docs, DB targets, env files) in `.agents/memory/locations.md`.
