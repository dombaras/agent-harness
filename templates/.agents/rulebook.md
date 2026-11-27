# Project Rules & Operating Guidelines

The canonical rulebook. It carries the durable **standards**; the always-on digest
is the root `AGENTS.md`, and the operating mechanics (dispatch economics, bounded
retries, context budget, capacity guards, session checklist) live in
`.agents/rules/00-operating.md`. Read both first — this file is the detail of
record for the rules they point at, not a second copy of either.

## 1. Fact-Based, Zero-Guessing SDLC

- **Zero-Speculation Rule**: NEVER guess, hypothesize without evidence, or assume the root cause of an error, performance lag, or system behavior. Speculation is forbidden across all personas and workflow stages.
- **Evidence-First Engineering**: Every diagnostic conclusion, fix, architectural decision, and enhancement MUST be grounded in observable facts: live server logs, telemetry traces, database records, or verified runtime execution. Know the project's debug/log endpoints — they are (or should be) recorded in `.agents/memory/locations.md`.
- **Mandatory Telemetry Before Fixes**: If logs or telemetry are absent or insufficient, FIRST add structured instrumentation, execute or have the user reproduce, inspect the captured output, and ONLY THEN implement based on that data.
- **Authentic Runtime Execution**: Never substitute real runtime calls with ad-hoc scripts that bypass actual config, env vars, middleware, or request pipelines. Verify through the real APIs/functions the app uses.
- **Scientific Progression Gate**: A fix is not complete until live logs or automated runtime tests demonstrate the failure mode no longer occurs in real runtime conditions.

## 2. Dynamic Data & Business-Logic Integrity

- **No Hardcoded Mock Lists**: Never create hardcoded lists (fake records, mock reviews, static fallback arrays) without explicit user approval. Prefer dynamic queries and database-backed settings.
- **Environment data boundary**: three environments — `development` (dirty by design: QA/test data lives here), `uat`, and `production` (both enforced clean). Only code, schema migrations, and idempotent seeds move FORWARD (dev → uat → prod); data never does — no `pg_dump`/restore/copy of one environment's database into another. Registry: `.agents/memory/environments.md`; promotion and QA rules: §7.

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

## 5. Dispatch Standards & Workflow Discipline

Operating mechanics live in `.agents/rules/00-operating.md` (§Step Zero,
§Dispatch economics, §Context budget & lifecycle, §Machine capacity, §Verification
& retry discipline). This section is the detail of record those point at, plus the
gotchas that do not belong in a digest.

- **Step Zero — subagent & model routing (non-negotiable)**: Dispatch the relevant persona via the `subagent` tool — each runs its own `model:`. Do NOT inline persona-owned work on the main model. Read `.agents/memory/model-routing.md` at session start; trivial or single-surface/single-file changes execute directly (00-operating §Dispatch economics).
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
- **Tier the change before dispatching (T0-T3)**: T0 one-file mechanical → direct; T1 one surface/<=3 files → direct + QA plan; T2 multi-file or one contract → one persona; T3 2+ surfaces or schema/auth/security/public API → several personas + architect/security/QA. `node scripts/qa/dispatch-tier.js --objective "<task>" --files a,b` is the mechanical classifier; policy, gates, and the no-dispatch rule: 00-operating §Dispatch economics.
- **Waivers** (the only way to skip a persona): a persona may be skipped only when (a) the change is fully covered by an automated gate on push or in the QA tiers, AND (b) the skip is pre-audited in `.agents/memory/` with a cited pointer. Log every waiver as `waived: <persona>` with `reason: <gate|pointer>`.
- **Evidence-based escalation**: escalate to the Pro tier only on repeated failure after materially different fixes, contradictory evidence, cross-module reasoning failure, security-sensitive ambiguity, unresolved concurrency/state issues, or a genuinely-blocking workaround risk. Do NOT escalate on a long answer, technical complexity alone, a request for more context, or uncertainty without evidence. Model tiers: `.agents/memory/model-routing.md`.
- **Dispatch failure ladder**: a provider funds/quota error is a STOP, not a failure to work around — announce the failed provider/model and the exact unfinished step, checkpoint, and wait for the user's explicit top-up-complete message; never retry, degrade inline, or silently skip. Any other failure gets one retry with a materially changed input (instructions / context / model / decomposition / diagnostics); after that, do the work inline and log `degraded: <persona> model: <reason>`. Provider priority and model tiers: `.agents/memory/model-routing.md`; full ladder: 00-operating §Dispatch economics.
- **No suppression shortcuts**: never accept (or produce) file-level `/* eslint-disable */`, `@ts-nocheck`, or `@ts-ignore` to hit a metric. Suppressions are line-level only and each carries a reason — a file-level disable is a rules violation, not a fix.
- **No output bloat**: never paste large files/diffs into chat; apply edits with the edit tool, never print a change as a code block.
- **Repeated-command / retry-loop detection**: never re-run the same command in the same session with the same state expecting a different result. When a command would repeat (`same_failure_turns` / `identical_tool_calls` / `no_state_change_turns` — thresholds in `.agents/memory/orchestration.md`), stop, change something material, or report. A gate repeated with `files_changed = 0`, the same command, and the same failure is a retry loop, not a retry.
- **Read narrowly**: search first (`Grep`/`Glob`, `npm run search`), then read a targeted `offset`/`limit` range — never read a big file blind. Batch independent reads/searches in parallel; do not re-read a file already in context (use `offset`/`limit` or `Grep` for the changed lines). Tool mechanics: 00-operating §Non-negotiable laws (law 6).
- **Long-lived processes**: start a dev server, emulator, Metro, or Maestro driver detached through `node scripts/serve.js start --cmd "<command>" [--url <health url> | --port <n>] [--name <label>]`; poll it with `node scripts/wait-for.js` (never `sleep`-and-pray), read `.serve/<name>.out.log` on failure, and `serve.js stop`/`stop-all` when the tier passes. Never background a long-lived process in your own shell — the tree stays attached to the tool's console and the call hangs. A bare `setsid bash -c '… > log 2>&1' &` is NOT detached (the wrapper keeps the tool's socket open); if you must launch by hand, redirect the wrapper's own fds: `setsid sh -c 'exec <command>' </dev/null >log 2>&1 &`. Anti-pattern and recovery: `.agents/skills/mobile-engineer/SKILL.md`, `docs/mobile-testing.md`.
- **Wedged launch**: never kill a running tool call — let it finish, then checkpoint/finish — except a confirmed wedged launch (the command's shell has exited yet a detached descendant holds the tool's output socket, so the call can never return). Interrupt it, then verify state (`serve.js list`, `.serve/<name>.out.log`, `adb devices`, the health URL/port) before continuing; never wait indefinitely or infer state from the abort.
- **Capacity classification**: heavy tiers are classified by **program** (`scripts/qa/command-classifier.js`), not by a device serial or artifact path in the arguments; one live `--group` (device tier's emulator + dev server) counts as ONE tier. Diagnose a failed device step with `node scripts/qa/mobile-e2e/ui-dump.js`, never a hand-rolled `adb`/`python` probe. Envelope and guards: 00-operating §Machine capacity; details: `docs/wsl-optimizations.md`.
- **MCP servers are context + RAM, so scope them per agent, dev-only**: deny the server's tools globally (a `<server>_*` rule in `permissions`) and re-enable only for the persona that needs live external state; point any DB server at the **development** database only. Do not enable GitHub MCP. Details: `docs/mcp-integrations.md`.
- **Prefer memory over re-derivation**: persist non-obvious facts to `.agents/memory/`, and check `.agents/memory/locations.md` (or `Glob`) before reading an unknown path — never guess a path.

## 6. Smart Tiered Testing & Progression Protocol

- Never run heavy regression suites blindly for small changes.
- **Split QA personas**: `qa-architect` (thinks — inspects the diff, audits gaps, selects the minimal tier, authors progression tests) vs `qa-runner` (does — executes the chosen tier, reports pass/fail verbatim). The thinker never runs; the doer never designs. Because `qa-architect` denies the `shell` action, an architect-authored progression is NOT verifiable until `qa-runner` load-gates it first (`node --check` for `.js` suites; load + ≥ 1 executed assertion for `.ts`) — never let an architect-authored file reach "done" on the strength of a plan alone.
- **Static ≠ runtime**: never declare UI/mobile/API changes verified from static typing alone — execute a real runtime path that exercises the MODIFIED code.
- **Coverage ≠ label**: a tier command verifies a change ONLY when its backing suite actually exercises the changed path. `npm run test:qa-plan` mechanically asserts every changed code path is covered by the QA plan (or waivered) — and, via `flow-map.md`, that every touched flow's sibling surfaces and declared optional variants are addressed in the plan's audit.
- **Test quality & economics rule (T1–T10)**: coverage without test quality produces suites that are green, prove little, and cost a lot. Every proposed assertion must pass the architect's 10-point test-design checklist — independent oracle, executed proof (command + executed assertion count ≥ 1), single owner (no duplicate of an existing gate), hermetic isolation, exit contract + wall-clock budget, cheapest tier that still executes it, wired (not orphaned), a `behavior`/`drift-guard`/`constant-pin` label, a negative fixture for guard claims, and bounded fail-fast prerequisites. Mechanically: `npm run test:wiring` fails any `*.test.*` file no package script executes (T7), and `node scripts/qa/check-linger.js -- <tier command>` fails a suite whose process wall-clock grossly exceeds its runner-reported test time (T1/T6/T9). Tag definitions: `.agents/memory/test-design-parameters.md`; checklist: `.agents/skills/qa-architect/SKILL.md`.
- **Tiers** (commands are **project-provided** — the target project must define them; the harness ships only its own gates: `test:dispatch`, `test:governance`, `test:qa-plan`, `test:backlog`, `test:product`, `test:docs`, `test:concurrency`, `test:integrate`, `test:quality`, `test:wiring`, `test:linger`, `test:prefix`):
  | Tier | Scope | Command |
  |---|---|---|
  | 1 | UI/CSS/mobile/copy | `npm run test:quick` |
  | 2 | Routes / page layout | `npm run test:routes` |
  | 3 | API / ORM / transactions | `npm run test:api` |
  | 4 | Data ingestion | the project's data E2E script |
  | 5 | Major release / breaking refactor | `npm run test:verify` |
  | 6 | Security / deps | `npm run test:security` |
- **Live-server tiers (3+)**: a runtime/API tier that hits real routes needs the dev server running; start it detached and stop it when the tier passes (see §5, 00-operating §Machine capacity). Never pipe a live start or tier run through a buffering filter — it looks frozen and invites an abort.
- **The expensive device/Maestro tier is NIGHTLY, not part of the day loop.** The day loop lands on cheap gates (`test:quick` / `test:api` / `test:routes` / the project's web E2E); it must NOT boot the emulator or run the Maestro matrix by default. `scripts/nightly.js` (installed as a systemd `--user` timer by `agent-harness install-nightly`) runs the full battery off-hours against a `nightly` worktree fast-forwarded to `origin/main`, then reconciles the board: a failing journey with no row → `backlog add "[nightly:flow=<journey>] …"`; a shipped (archived, pending-validation) row whose journey now passes → `backlog archive <id> --closed "nightly-validated …"`; a still-failing journey → `backlog reopen <id>` (journey-level; one row per broken journey, reopened until green). A device-only path is therefore addressed in the QA plan as `audited: device tier deferred to nightly [nightly:flow=<journey>]` — a valid `audited:`/`waived:` reason, not a silent skip. Run a device tier in-session only when the user explicitly asks. See `docs/nightly-testing.md`.
- **Live QA targets the development environment only**: runtime/API tiers and data-E2E runs execute against the dev database (`DATABASE_URL`). They never touch uat/prod; the forward boundary (§2, `.agents/memory/environments.md`) is enforced at deploy time by `test:data-hygiene -- --env uat|prod`.
- **Progression Workflow**: for new routes/endpoints/states, (1) author a dedicated assertion path, (2) run the targeted progression test, (3) graduate it into the permanent regression suite. A change is NOT verified if the executed tier's backing suite never exercised the modified path — author a progression test for that path first (the "GAP" rule).

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
1. **QA tier** (code changes only) — `qa-architect` inspects the diff, picks the tier BY COVERAGE (not path-label), records the coverage map in a per-change plan under `.agents/qa-plans/` (one file per change — never edit another change's plan), and authors progression tests for any GAP; if `qa-architect` is not dispatched, the orchestrator plans in its place. `qa-runner` executes and makes it pass (§6). A change is not verified until `npm run test:qa-plan` passes (every changed code path covered or waivered; every touched flow's sibling surfaces and variants addressed in `## Parallel-surface & variant audit`; the executed tier exercised the modified path) and `npm run test:wiring` is green. The plan also carries `## Test budget`, `## Oracle & owner`, and `## Test-design self-check` (T1–T10).
2. **Security check** (code changes only) — apply `security-engineer` when the change touches data/auth/input/secrets/deps.
3. **Backlog write-back** (always) — move every task this session shipped from `In progress` to `Archive (shipped · done)` (`backlog_archive`, with date/commit), then stage it explicitly: `git add BACKLOG.md` (a bare `git commit -am` will not pick up an untracked board). At session start, the inverse: `backlog_take` moves the picked-up row `Open` → `In progress` with `Handoff` pointing at the session's handoff file. The board syncs across sessions only through git, so these deltas ship with the code.
4. **Docs write-back** (always, on land) — keep `CHANGELOG.md` current with a line citing the commit short hash (`git rev-parse --short HEAD`), and update `README.md` / `docs/**` / ADRs when the change adds or renames a subsystem, flow, public API, or hard-to-reverse decision (`.agents/skills/docs/SKILL.md`). `npm run test:docs` fails a shipped commit with no changelog entry, so the changelog delta ships in the same commit as the code. A copy/CSS tweak needs at most a changelog line.
5. **Commit** (always) — concise `feat:` / `fix:` / `refactor:` message including the `BACKLOG.md` and `CHANGELOG.md` deltas.
6. **Land the branch** (always) — `npm run finalize -- --feature <id>` (or `npm run ship`) integrates on `origin/main`, runs the branch gates (including the harness process gates when no pre-push hook is installed), lands with a **direct fast-forward push to `main`**, then waits for **CI to go green on the landed SHA**. There is no PR, no landing label, and no merge train; a concurrent landing is resolved by re-fetch + rebase + retry. `--no-ci-wait` is a pause, not a completion.
7. **Deploy to UAT** (CI-owned) — the `CI` workflow completing on `main` triggers `.github/workflows/deploy-uat.yml`, which deploys the landed SHA to `uat` as a prebuilt artifact, runs `prisma migrate deploy` + idempotent seed + alias/parity/smoke verification, then `npm run test:data-hygiene -- --env uat`. A local `deploy:uat` is the emergency path only; production is human-gated. Never forward dev data — code + schema + idempotent seeds only (§2, `.agents/memory/environments.md`).
- **Mechanical floor**: a pre-push hook should run `npm run test:quick` (project-provided; the harness does not install git hooks).
- **Concurrency isolation (never let a concurrent session's WIP block yours)**:
  - `test:concurrency` (`node scripts/qa/check-concurrency.js`) fails a push when the board shows 2+ `In progress` rows while the working tree has uncommitted changes. Declare each row's owned files (`backlog owns <id> --files ...`; `.agents/memory/owned-files.md`) so it fails *exactly* when a dirty file is owned by two In-progress rows. The live-session lease report (`.serve/sessions/`, written by the context-guard plugin) is **advisory** — a clean tree never fails a push. `--prune` clears dead/recycled/stale leases.
  - **Isolate per feature** with `backlog worktree <id>` (or the `backlog_worktree` tool) from the **main** tree before starting ANY feature: it creates a `git worktree` + branch and records the path in the row's `Handoff`. `main` stays board + shippable code only. `--open` launches the agent CLI inside the worktree. Worktrees live under `<repo>/../.worktrees/<repo>/<id>`; `backlog archive <id>` removes a shipped feature's worktree + merged branch, and `backlog worktree-prune` converges the set (removes clean merged worktrees, keeps unmerged or dirty ones).
  - **Row-aware merge driver**: `.gitattributes` routes `BACKLOG.md` through `scripts/qa/merge-backlog.js`, so two sessions editing *disjoint* rows merge by ID instead of conflicting (`agent-harness init/update` wires the driver). A row's `Depends on` cell (`backlog depends <id> --on <ids>`) makes ordering machine-readable — `/next`/`take`/`worktree` skip or refuse a row whose dependencies aren't archived.
  - **Snapshot gating**: `node scripts/qa/run-clean.js -- npm run test:quick` runs a project gate against the *committed* state (stashes + restores dirty files), so a pre-push gate verifies your committed work, not the tree.
- **Lean permissions**: grant only the narrowest `git`/`gh` action needed; escalate only after a command has actually failed.
- Git may not be on PATH in the default shell — use the full path (`.agents/memory/locations.md`).

## 8. Session & Traceability Discipline

- **Harness-update awareness**: `npx opencode-agent-harness update` auto-commits the harness files it changes as `chore(harness): opencode-agent-harness <old> -> <new>`. If you see such a commit (or modified `.agents/**`, `scripts/qa/**`, `AGENTS.md`, `opencode.json` you didn't touch), do NOT treat it as unexplained — run `git log -1 --stat` / `git show` to see exactly which harness files changed and why, then read the rulebook. Never guess at the cause.
- **Harness-owned files are fixed upstream, never in this project**: `scripts/qa/**`, `scripts/*.js`, `.opencode/**`, `.agents/skills/**`, `.agents/rules/**`, `.agents/rulebook.md` (and its tiny `.agents/AGENTS.md` shim), `AGENTS.md`, and opencode config are copied from the harness `templates/` on every `update`. Make a needed change in the harness repo's `templates/` (with a drift-guard test when it is a gate/QA script), release it, and re-run `update` — do NOT hand-edit the deployed copy. **Route (F-12):** a session rooted in this project cannot edit another checkout (the main-checkout guard blocks it, and worktree isolation is per-repo); make the fix from a session rooted in the harness checkout itself, then `agent-harness update .`, and record the harness gap on the board. Since harness `0.1.100`, `update` **fails closed** on a hand-edited harness file; `--accept-harness` overwrites deliberately after a backup and rolls back if `test:quick` goes red (the F-289 incident: a project-side `board-sync.js` fix silently reverted by the next deploy).
- **Planned vs. Shipped**: at session end, record a "planned → shipped → deferred" delta so aspirational docs are never mistaken for reality. Always verify against live code and schema.
- **Value-first completion report**: close a session by telling the user, in plain language, **what value shipped** and the main **how**, before any file/test/technical detail; record the same summary in the handoff's `## Value shipped` + `## How`. Full guidance: root `AGENTS.md` and 00-operating §Step Zero.
- **Explain at the reader's level**: write for someone who knows the product but not the codebase. Lead with observable behavior in plain terms; name a code identifier only when precision needs it, and gloss it on first use. Stay concrete and technical — never make an internal symbol the subject of a sentence. Full guidance: 00-operating §Step Zero.
- **Dispatch Log (mandatory)**: every wrap-up opens with `subagent → model → shipped/deferred`; a log with 5+ entries also needs a `## Fan-out justification`. An empty log is non-compliant.
- **Structured session telemetry**: every handoff records, when known and never fabricated:
  - `session` — the primary orchestrator session id from the `session_info` tool. This is the join key for `npm run report -- --cost`, which attaches observed provider cost/tokens/turns (primary + subagent sessions) to the feature.
  - `work_type` — one of `feature | bugfix | investigation | architecture | planning | qa | security | maintenance | process | conversation | other`.
  - `outcome` — one of `shipped | resolved | deferred | investigation-complete | abandoned | superseded | conversation-only`.
  - `termination_reason` — why the session ended (e.g. `gate-pass`, `checkpoint`, `blocked`, `escalated`, `abandoned`).
  - `model_escalation_evidence` — when the primary session ran on an `escalation_models:` model (`.agents/memory/model-routing.md`), the reason (or `none`). `npm run report -- --cost` flags a pro-model primary session with no recorded evidence.
  - Retries/escalations with `attempt` numbers and reasons.
  - `null` / `unknown` when the runtime cannot know a value — never infer exact token/cost numbers from character counts, and never invent values.
  These feed the deterministic `npm run report` (agent-report) so feature economics are measurable without reading transcripts; `--cost` reads only observed provider data from the opencode store.
- **Persist continuity & checkpoint**: use the `handoff` skill to write your session's file under `.agents/handoffs/` (one per session — never edit another session's). At the `orchestration.md` budget bands, write the bounded state block with `checkpoint_write`/`/checkpoint` and resume with `/resume` — never replay the transcript. Project history lives in `.agents/memory/history.md`; stack facts in `.agents/memory/stack-versions.md`.
- **Pointers Map Hygiene**: record every created/discovered/changed important location (session archives, scratch scripts, logs, docs, DB targets, env files) in `.agents/memory/locations.md`.
