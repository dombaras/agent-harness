# @dombaras/agent-harness

A reusable multi-agent harness for AI-assisted development. Ships a persona
fleet (planner, engine engineer, mobile, QA architect/runner, security,
architecture, product, data, devops, handoff, docs), operating rules, model routing,
and QA gates — then deploys them into any project.

> Extracted from a production project so the "agents / subagents / guardrails /
> personas" layer is **not** an inherent part of the app codebase. It lives in its
> own repo and is installed via `npx @dombaras/agent-harness init`.

## Why

- The agent harness is tooling, not application code. Its source lives in the
  npm package — you deploy it with `init`/`update` rather than hand-copying it
  into every repo.
- One canonical, versioned source of truth for personas/rules/QA tiers, deployed
  on demand and updatable via `npx @dombaras/agent-harness update`.

## Install & initialize

```bash
# from anywhere (uses a target dir or defaults to cwd)
npx @dombaras/agent-harness init --target /path/to/project --name "MyApp" --domain "a widget catalog"

# non-interactive
npx @dombaras/agent-harness init --target . --yes

# preview what would change, without writing anything
npx @dombaras/agent-harness init --target . --dry-run
```

`init` writes:

| Path | Content | Ownership |
|---|---|---|
| `AGENTS.md` | root dispatcher (points to the rulebook) | harness (overwrite) |
| `BACKLOG.md` | canonical task list (Open / In progress / Frozen / Archive / Not tracking) | **project** (create-if-missing) |
| `.opencode/agents/*.md` | 15 persona subagent defs (with `model:` pins + `permission`/`steps`/`temperature`/`hidden`) | harness (overwrite) |
| `.agents/AGENTS.md` | full canonical operating rulebook | harness (overwrite) |
| `.agents/rules/00-operating.md` | always-loaded rules summary (wired into `opencode.json` `instructions`) | harness (overwrite) |
| `.agents/skills/*/SKILL.md` | persona instruction skills | harness (overwrite) |
| `.agents/features/INDEX.md` | pointer to `BACKLOG.md` (per-feature doc tree root) | **project** (create-if-missing) |
| `opencode.json` | main/small model routing + `instructions` | harness (**merged**, see below) |
| `scripts/qa/*` | `test:dispatch` / `test:governance` / `test:qa-plan` / `test:prefix` gates + QA-script wiring check | harness (overwrite) |
| `scripts/backlog.js` | deterministic `BACKLOG.md` editor (list/add/take/archive/freeze) | harness (overwrite) |
| `.opencode/tools/backlog.ts` | `backlog_*` custom tools the LLM calls (shell out to the CLI) | harness (overwrite) |
| `.opencode/plugins/backlog-notify.ts` | toast/log whenever an agent mutates the board | harness (overwrite) |
| `.opencode/plugins/context-guard.ts` | mid-session checkpoint/loop nudges read from `orchestration.md` (core: `scripts/qa/context-guard-core.js`) | harness (overwrite) |
| `.opencode/tools/session.ts` | `session_info` tool — reports the primary orchestrator session id (the handoff `session:` join key) + observed cost/tokens/turns | harness (overwrite) |
| `.opencode/tools/checkpoint.ts` | `checkpoint_write` / `checkpoint_resume` tools (shell out to `scripts/checkpoint.js`) | harness (overwrite) |
| `.opencode/command/checkpoint.md`, `.opencode/command/resume.md` | mid-session checkpoint + bounded resume-from-checkpoint commands | harness (overwrite) |
| `scripts/checkpoint.js` | deterministic checkpoint write/replace/read for one session handoff (no timestamps, `unknown` for absent state) | harness (overwrite) |
| `scripts/ship.js` | deterministic branch lander (`npm run ship`): rebase on `origin/main`, branch gates, direct fast-forward push of `HEAD:main`, then wait for green CI on the landed SHA | harness (overwrite) |
| `scripts/qa/check-prefix-stability.js` | `test:prefix` gate — fails a volatile value (clock timestamp, machine path, session id) in the always-loaded prompt prefix | harness (overwrite) |
| `.github/workflows/{ci,deploy-uat,uat-health}.yml` | CI gate, CI-triggered artifact deploy, health probe — the self-contained release cycle `ship` drives | **project** (create-if-missing) |
| `.husky/pre-push` | pre-push battery (harness process gates + project test gates) | **project** (create-if-missing) |
| `.vercelignore` | keeps worktree symlinks (`node_modules`, `prisma/generated`) out of the remote build | **project** (create-if-missing) |
| `docs/ci-cd-pipeline.md` | the pipeline reference (setup, secrets/variables, rollback) | **project** (create-if-missing) |
| `scripts/agent-report.js` | deterministic dispatch report (`--cost` joins observed provider telemetry; `--json` schema `agent-report/1`) | harness (overwrite) |
| `scripts/qa/provider-stats.js` | observed cost/token/turn telemetry from the local opencode store (no sqlite dependency) | harness (overwrite) |
| `.agents/memory/*` | project data (domain-map, stack-versions, locations, model-routing, orchestration, history, flow-map, product-principles, quality-parameters, test-design-parameters) | **project** (create-if-missing) |
| `.agents/reviews/*` | project data (durable review/audit deliverables — REPORT.md + scans, tagged by quality-parameters) | **project** (create-if-missing) |
| `.agents/handoffs/*` | project data (one session handoff file per session — sharded so concurrent sessions never collide) | **project** (create-if-missing) |
| `.agents/qa-plans/*` | project data (one QA plan file per change — sharded so concurrent sessions never collide) | **project** (create-if-missing) |
| `.harness.json` | deployed version + project profile + per-file checksums | harness |
| `.gitignore` | **project-owned** — deployment never reads or rewrites it; harness local-only artifact patterns go to the clone-local `.git/info/exclude` | project |
| `.gitattributes` | harness-managed section (`BACKLOG.md merge=backlog` — the row-aware merge driver) merged in, project entries preserved | harness (merged) |

### `opencode.json` is merged, not clobbered

The harness owns only `$schema`, `model`, `small_model`, and its own
`instructions` entry (`.agents/rules/00-operating.md`). Every other key your
project adds — `permission`, `mcp`, `plugin`, custom `instructions`, etc. — is
preserved across `init`/`update`.

## Placeholders

Templates use `{{PROJECT_NAME}}` and `{{PROJECT_DOMAIN}}`; `init` substitutes
them from `--name` / `--domain` (or prompts, or `.harness.json`). Domain facts
that are genuinely project-specific (entity model, external sources, visibility
tiers, trust tiers) live in `.agents/memory/domain-map.md`, which `init`
scaffolds for you to fill in — the skills and rules reference memory instead of
hardcoding domain assumptions.

**Features (`.agents/features/`)** — the durable, feature-centric plan of record. A
found item is captured as one light row in the canonical `BACKLOG.md` (repo root; the
single write-path for all open work: what's known, priority, evidence). When a feature
is picked up, the `features` persona authors the per-feature doc chain
(`.agents/features/<slug>/`), each layer routed to its author persona — `intent.md`
(product-manager) → `scope.md` (system-architect, HIGH-risk only) → `plan.md` (planner)
→ `tests.md` (qa-architect, points to the feature's QA plan). Ceremony is right-sized to blast
radius: trivial → none, low → single `intent.md`, high (auth/DB/public API/flow-siblings)
→ full chain. Docs live beside the code, are written-back before continuing when
implementation invalidates them, and are archived on ship. `.agents/features/INDEX.md`
is a pointer to `BACKLOG.md`. See `.agents/skills/features/SKILL.md`.

**Product-first planning (`.agents/memory/product-principles.md`)** — the project-owned
product concepts (actors, product concepts, UX heuristics, design language, key journeys,
value-maximization rules) that LEAD planning. The `planner` reads it (plus a feature's
`intent.md`) before emitting a dispatch plan and sequences work value-first — smallest
slice that delivers the core outcome first — rather than by tech dependency. `intent.md`
must define Actor(s) → Need → Outcome → Acceptance criteria, and `plan.md` a Value-first
sequence + Product concepts applied; `npm run test:product` fails a feature that reaches
planning/implementation without them (a plan with no intent, or an intent that never
names a user/need/outcome). Fill `product-principles.md` in at `init`; evolve it as the
product does — see `.agents/skills/planner/SKILL.md` and
`.agents/skills/features/SKILL.md`.

**Flow map (`.agents/memory/flow-map.md`)** — the project-owned registry powering the
flow-closure half of `test:qa-plan`. Each user-facing flow lists the code surfaces that
implement the same behavior across codebases/layers (e.g. web component, `mobile/` sheet,
API route) plus its optional variants (e.g. `condition-selector-present` vs `-absent`). Fill
it in so a change to one surface is forced to account for all the others. If empty, the gate
warns but does not block; the guarantee only applies to registered flows.

**Environment registry (`.agents/memory/environments.md`)** — the project-owned
canonical registry of the three environments: **development** (dirty by design —
QA/test data lives and dies here), **User Acceptance (`uat`)**, and **production**
(both enforced clean). The rulebook's non-negotiable law: only **code**, **schema
migrations** (`prisma migrate deploy`), and **idempotent seeds** move forward
(dev → uat → prod); **data never does** — no dump/restore across environments.
Live QA tiers target the `development` DB only. Finalizing a task means deploying
to **uat**: the Definition of Done routes it through `devops-engineer` →
`deploy:uat`, then verifies the boundary with `test:data-hygiene -- --env uat`.
Production is human-gated and out of the per-task flow. The harness scaffolds
`environments.md` (create-if-missing, project-owned) and reminds projects to wire
`deploy:uat` / `deploy:prod` / `test:data-hygiene` via `check-qa-scripts.js`.

**Orchestration & context budget (`.agents/memory/orchestration.md`)** — the
project-owned tuning file for the cost/context guards the operating rules
reference: the main-orchestrator soft turn budget / hard safety ceiling, the
request-context observe → warn → checkpoint → intervene thresholds, dispatch
fan-out review bands, and the stuck/retry-loop heuristics. Shipped with sensible
experimental defaults; tune from post-change data and record why. Scaffolded
create-if-missing (project-owned).

**Bounded orchestration & structured session telemetry** — the harness keeps the
main context from growing unbounded: one bounded orchestration lifecycle per work
unit, compact deterministic checkpoints into the session's `.agents/handoffs/<id>.md`
when a session nears its budget (see `orchestration.md`), and a fresh context that
resumes from the checkpoint instead of replaying the transcript. The
**`context-guard` plugin** makes the budgets mechanical: it parses
`orchestration.md` at runtime (thresholds are never hardcoded) and nudges the
primary orchestrator session as it crosses them — turn bands AND request-token
levels (whichever is stronger), flags repeated identical tool calls, whole turns
with no material state change, and repeated failures sharing a signature, and
records band/request/loop/no-state/failure crossings in
`.agents/guard-events.jsonl` (local-only, excluded clone-locally). At the
checkpoint band the nudge is imperative: write ONE checkpoint, then stop at the
current **phase boundary** — a fresh bounded context resumes from it. The nudge is
injected **cache-safely**: it is appended as a synthetic tail message via
`experimental.chat.messages.transform`, never written into the system prompt — a
system-prompt change on a band crossing evicts the provider's entire prompt cache
and re-bills the whole transcript at full input price (measured: every full-price
re-read landed on turn 50/60/80/100). Appending at the tail keeps the cached
prefix byte-stable. Every handoff can
carry a `## Session metadata` block (`session`, `work_type`, `outcome`,
`termination_reason`, `checkpoint_count`, `model_escalation_evidence` —
controlled vocabularies, never fabricated) that `npm run report` aggregates
deterministically per feature.
`npm run report -- --cost --since=14d` (also `npm run report:cost`) closes the
telemetry loop: the `session_info` tool returns the primary session id, and
`agent-report` joins it to observed provider data
(`scripts/qa/provider-stats.js` reads the local opencode store, including
registered git worktrees) — totals, model mix by tier, cache-read share, P50/P90
cost and turns, >60-turn sessions, identical-call loop candidates, mid-cycle
context resets (resume/checkpoint sessions), and **cost per shipped feature**
(primary session + its subagent sessions = one feature run).
A primary session observed on an `escalation_models:` model is flagged when no
`model_escalation_evidence` / `## Escalations` reason is recorded — escalation is
visible, never assumed. Nothing is inferred from text length.

**End-to-end auto-resume (`agent-harness run`)** — chains bounded orchestration
contexts so a full delivery cycle (pick → plan → implement → QA → gates → ship →
land → UAT deploy) completes without a manual resume per phase. It runs the
next-item workflow, and whenever a phase ends with the feature not landed, it
launches a fresh opencode session that resumes from the checkpoint only. It stops
on landed (archived row or shipped outcome), the phase cap, an empty queue, or a
failed phase that did not land. The decision core
(`scripts/qa/run-loop.js`) is pure and unit-tested; `--dry-run` prints the phase
plan.

## Model routing & enforcement

- Concrete models are set in `.opencode/agents/<name>.md` (`model:` field) and
  `opencode.json` (`model` + `small_model`).
- Personas also carry mechanical guardrails in frontmatter:
  - thinkers (`planner`, `product-manager`) → `edit` deny-by-default with a narrow
    artifact write grant (planner → `.agents/features/<feature>/plan.md`,
    product-manager → `.agents/features/<feature>/intent.md`, each writable in the
    main tree or the feature's `.worktrees` sibling), `bash: deny`
  - `qa-architect`, `handoff`, `docs` → `permission: { bash: deny }`
  - code personas (`frontend-engineer`, `mobile-engineer`, `ui-designer`,
    `data-engineer`, `devops-engineer`, `security-engineer`, `system-architect`,
    `diagnostics-expert`) → `permission.edit` allows everything EXCEPT
    `opencode.json`, `.harness.json`, `.opencode/**`, `.agents/**` (governance
    and harness files are read-only), plus `bash: allow`
  - deterministic personas → `temperature: 0.1`
  - all personas → a `steps:` cap (cost ceiling)
  - `planner`, `handoff` → `hidden: true`
- `.agents/skills/*/SKILL.md` carries a `model:` label only (informational).
- `npx @dombaras/agent-harness list` prints the persona → model mapping.
- `npm run test:dispatch` mechanically verifies model pins against
  `scripts/qa/models.allowlist.txt` and that `model-routing.md` does not name a
  stale model no longer pinned anywhere (doc↔config drift). Concrete IDs on the
  machine-readable `opportunistic_models:` / `escalation_models:` lines are
  legal declared targets, not drift.
- **Opportunistic tier** (`.agents/memory/model-routing.md`): free/low-cost
  models for best-effort bulk exploration/summarization, pinned through
  `opencode.json` `agent.explore.model` (default `opencode/big-pickle`) and
  ADD-ONLY overridable per project — with a mandatory fallback to the persona's
  normal tier and a no-confidential-data caveat. `report` classifies the model
  mix by tier.
- **Provider priority & fallback**: models run on the **OpenCode Go
  subscription first** (`opencode-go/*`), with **DeepSeek direct**
  (`deepseek/*`) as the pay-per-token fallback — except the **V4 Pro architect
  tier** (`planner`, `qa-architect`, `system-architect`, `security-engineer`),
  which always pins **direct `deepseek/deepseek-v4-pro`**. Every fallback is
  announced immediately (a fallback the user cannot see is a silent process
  change).
- **Provider funds stop**: a provider funds/quota error (`insufficient
  balance`/`funds`/`credits`, usage limit, HTTP 402) is a hard stop, never a
  silent inline degrade: the orchestrator announces the failed provider/model and
  the exact unfinished step, checkpoints, and waits for the user's explicit
  top-up-complete message. The `context-guard` plugin mechanically detects such
  an error from **structured failure evidence only** — a failed dispatch
  (`task` error), a non-zero-exit command, or a subagent session error — and
  injects the same stop; reading a document that merely quotes the rule (the
  session-start `model-routing.md`, a handoff, a plan) never trips it.
- **`/switch-model` command** — every deploy ships an opencode command
  (`.opencode/command/switch-model.md`) plus per-platform twins
  `scripts/switch-reasoning-model.ps1` (Windows PowerShell) and
  `scripts/switch-reasoning-model.sh` (WSL/Linux/macOS; the command invokes this
  one on POSIX). It rewrites the main `opencode.json` `model` and the six
  reasoning-tier agents (planner, system-architect, security-engineer,
  diagnostics-expert, product-manager, qa-architect) in one step — a blunt
  override of the tiered default. Aliases: `go`/`go-flash`/`go-deepseek` →
  `opencode-go/deepseek-v4.1-flash` (default, OpenCode Go), `go-pro` →
  `opencode-go/deepseek-v4-pro` (Go escalation),
  `deepseek`/`flash`/`direct` → `deepseek/deepseek-flash` (direct fallback),
  `deepseek-v4-flash` → `deepseek/deepseek-v4-flash` (legacy V4 pin),
  `pro`/`deepseek-pro`/`deepseek-v4-pro` → `deepseek/deepseek-v4-pro`
  (direct escalation), `nvidia`/`kimi`/`kimi-k3` →
  `nvidia/moonshotai/kimi-k3` (NVIDIA NIM), `nemotron`/`nemotron-ultra` →
  `nvidia/nemotron-3-ultra-550b-a55b:free` (NVIDIA NIM, free),
  `openrouter`/`or`/`minimax-m3`/`m3` → `openrouter/minimax/minimax-m3`
  (OpenRouter), or any explicit `provider/model`. Restart opencode after
  switching (config reads once).
- **`/board` command** — every deploy ships an opencode command
  (`.opencode/command/board.md`) that runs the deterministic `scripts/backlog.js
  list` and shows the active rows verbatim — no LLM filtering, no re-ordering, no
  transformation. Read-only, no git — the local file is the source of truth.

### Backlog management — fast, deterministic, no LLM in the loop

`BACKLOG.md` is the single source of truth; it is managed by a **deterministic
Node CLI** (no model round-trip) that both humans and agents share:

```bash
npm run backlog -- list              # In progress + Open, evidence on its own line (add --all for Frozen/Archive, --full to skip truncation)
npm run backlog -- add "NLI search times out" --p P2 --evidence docs/issues.md
npm run backlog -- take F-001 --handoff .agents/handoffs/F-001.md
npm run backlog -- archive F-001 --closed "shipped 2026-09-04"
npm run backlog -- freeze F-002 --why "not now" --reopen "customer asks"
```

`list` renders each row on two lines (task on top, evidence/handoff/reopen on a
labeled line below) and truncates long cells by default for scannability — pass
`--full` for the untruncated text. The `backlog_list` tool always uses `--full`
so agents see complete descriptions.

- The CLI validates the schema (`P1..P4`, non-empty evidence/handoff/reopen, `Depends on`
  references naming real rows), generates unique IDs, and sorts `Open` by priority — every
  write stays `npm run test:backlog`-green.
- **Dependencies are machine-readable**: a row's `Depends on` cell (`backlog depends <id>
  --on F-039,F-041` / `backlog add ... --depends-on ...`) lists IDs that must be archived
  first. `/next`, `take`, and `worktree` skip or refuse a row whose dependencies aren't
  archived — no more "until F-041" living in prose.
- **Isolation is a worktree per feature**: `backlog worktree <id>` (from the MAIN tree)
  creates a `git worktree` + branch and auto-takes the row. The branch is based on the
  current upstream (`origin/main`), never a stale local HEAD, and `--no-track` keeps it
  from silently tracking main. Every feature works in its own checkout — `main` stays
  board + shippable code only — so one session's uncommitted work can't leak into another's
  pre-push gate. Worktrees land in a single hidden container sibling,
  `<repo>/../.worktrees/<repo>/<id>`, so the parent folder (e.g. `C:\develop`) only ever
  holds top-level projects. Pass `--open` to launch the agent CLI *in the new worktree*
  after the board is written, so the session is root-scoped there and its lease + gates
  never land in `main`. If the worktree is instead created **mid-session** (no `--open`),
  the tools forward their session id and the CLI records the target at
  `.serve/sessions/<id>.worktree`; `backlog_*`, `checkpoint_*`, and `session_info` then
  follow the session into the worktree, and `archive` clears the pointer. `backlog archive
  <id>` removes the shipped feature's worktree + merged branch, so a session cleans up
  after itself on close.
- **Main-checkout freshness**: because a feature's commits reach `origin/main` from its own
  worktree, the MAIN checkout's board can lag origin until it is pulled. `backlog worktree`
  and `backlog archive` sync it first — fast-forwarding a clean, strictly-behind branch and
  *reporting* (never silently rewriting) a diverged one. Symmetrically, `agent-harness
  update` fast-forwards a stale target before it auto-commits and refuses to commit onto a
  diverged branch, so a harness `chore` commit can never land on a stale base and split the
  branch (`--no-fetch` skips the network step for `backlog`).
- **Row-aware merge driver**: `.gitattributes` routes `BACKLOG.md` through
  `scripts/qa/merge-backlog.js` (wired by `init`/`update`), so two sessions editing
  *disjoint* rows merge by ID instead of conflicting — concurrent take/archive no longer
  produces a `BACKLOG.md` merge conflict.
- **Owned files**: `backlog owns <id> --files "scripts/test-*.ts, scripts/qa/routes.js"`
  records the files a row owns in `.agents/memory/owned-files.md`, sharpening
  `test:concurrency` to fail *exactly* when two In-progress rows own the same file.
- **Agents use the same path** via opencode custom tools (`backlog_add`,
  `backlog_take`, `backlog_archive`, `backlog_freeze`, `backlog_depends`, `backlog_owns`,
  `backlog_worktree`, `backlog_list`) that shell
  out to the CLI — never hand-edit `BACKLOG.md`.
- A **notify plugin** (`.opencode/plugins/backlog-notify.ts`) pushes a toast +
  structured log the moment an agent mutates the board, so "an agent finished an
  item" reaches you as a notification instead of a manual refresh.

## QA gates

- `npm run test:dispatch` — persona model-pin preflight + persona↔skill parity + model-routing↔pin drift check.
- `npm run test:governance` — session wrap-up dispatch-log enforcement.
- `npm run test:backlog` — canonical single-backlog gate: `BACKLOG.md` is the one
  source of truth; status/priority enums, frozen-reopen conditions, non-empty
  priority/evidence (and non-empty task/handoff on `In progress` rows), no
  duplicate IDs, `Depends on` cells that name real rows, and `INDEX.md`/`todo.md`
  must be pointers (not live lists). Reports an over-wide row honestly ("row F-127
  has 7 cells, expected 6 — unescaped `|`") instead of surfacing a shifted cell as
  a bogus "depends on unknown row".
- `npm run test:concurrency` — cross-session working-tree guard. Fails when the
  board shows 2+ `In progress` rows while the tree has uncommitted changes; with
  owned files declared (`.agents/memory/owned-files.md`), it fails *exactly* when
  a dirty file is owned by two In-progress rows (or a tree mixes two sessions'
  WIP). The shared `BACKLOG.md` itself is treated as owned by every In-progress
  row, so a dirty board under 2+ active sessions is a hard failure. It also
  refuses two live *primary sessions* on one checkout via `.serve/sessions/`
  leases written by the context-guard plugin — liveness requires the pid **and** a
  matching process birth token (`bootId` + `/proc` starttime) **and** a fresh
  heartbeat, so a recycled pid or a closed TUI can't masquerade as a live session.
  `node scripts/qa/check-concurrency.js --prune` clears dead/recycled/stale leases
  (the plugin also sweeps at startup).
- `npm run test:integrate` — pre-push rebase check: fails when the current branch
  is behind `origin/main`, reminding you to `git rebase` and re-run the board +
  concurrency gates before pushing, so conflicts surface early.
- `npm run test:quality` — **mechanical code-quality gate on new/grown code**:
  flags dead exports (a symbol whose only reference is its own declaration) and
  files that are new or grew past the line limit (default 1000). Runs against the
  diff by default (`--paths a,b` to target files, `--base <ref>` to set the
  baseline, `--strict` for CI). Canonical rubric: `.agents/memory/quality-parameters.md`.
- `npm run test:wiring` — **orphan-test gate**: every `*.test.*` / `*.spec.*`
  file must be executed by some package script (directly, as a directory prefix,
  or via a glob). An authored test wired into no tier is neither protection nor a
  failure signal — test-design parameter T7. Default-discovery runners (`vitest
  run`, bare `node --test`, …) downgrade unwired files to warnings unless
  `--strict`; a deliberate orphan carries an auditable
  `// test-wiring-waived: reason` comment. Tags: `.agents/memory/test-design-parameters.md`.
- `npm run test:linger` — **exit-contract gate**: runs `test:quick` by default
  (or an explicit command after `--`), measures real process wall-clock, parses
  the runner's self-reported duration (`node:test` `duration_ms`, jest `Time:`,
  vitest `Duration`), and fails when the process lingers after the tests are done
  (T1/T6/T9) — the measured bug where 22 tests finished in 76 ms but the process
  exited 60.4 s later. Tune with `--max-linger <sec>` / `--ratio <x>`.
- `npm run test:prefix` — **cache-prefix stability gate**: the always-loaded
  prefix (root `AGENTS.md`, the rulebook, `00-operating.md`, and the session-start
  memory reads) must carry no per-run content — clock timestamps, machine-specific
  absolute paths, or session ids — because one changing byte breaks prompt-cache
  locality for every later turn. Bare historical dates are fine; `BACKLOG.md`,
  handoffs, and feature docs are out of scope.
- `npm run checkpoint -- write --feature <id> ...` / `resume --feature <id>` —
  deterministic bounded-state checkpoint in `.agents/handoffs/<id>.md`
  (agents: the `checkpoint_write` / `checkpoint_resume` tools, or `/checkpoint` /
  `/resume`). Rewriting identical state is a no-op; changed state increments
  `checkpoint_count`; no timestamps, `unknown` for anything not recorded.
- `npm run test:product` — **product/UX-first gate**: every feature doc in
  `.agents/features/<slug>/` must define its user before planning/implementation.
  `intent.md` must carry Actor(s) → Need → Outcome → Acceptance criteria, and `plan.md`
  a Value-first sequence + Product concepts applied; a `plan.md` with no `intent.md`
   fails (never plan around an undefined user need). Backward-compatible — no feature
   docs, gate passes.
- `npm run test:docs` — **docs-as-code gate**: `README.md` / `docs/**` must have no
  un-substituted `{{PLACEHOLDER}}` template vars, no dangling relative links, and every
  ADR (`docs/adr/*.md`) must carry Context → Decision → Consequences + a Status.
  Backward-compatible — no docs, gate passes.
- `npm run test:qa-plan` — **diff-coverage + flow-closure gate**:
  every changed CODE path must have a covering assertion (or a waivered reason) in
  a QA plan (one per-change file under `.agents/qa-plans/`) before a change is verified — and every touched flow
  (`.agents/memory/flow-map.md`) must have every sibling surface and declared optional
  variant addressed in the plan's `## Parallel-surface & variant audit`. Kills the
  "verified by a suite that never touched the change" failure mode: a tier label never
  proves coverage. It also makes **"Fix One, Fix All" mechanical**: a change to one
  surface (e.g. web) cannot ship while the same flow in another codebase (e.g. `mobile/`)
  silently keeps old behavior — the plan must name each sibling as covered (`->`) or
  out-of-scope (`audited: reason`, e.g. `deferred — logged in handoffs/`).
- `node scripts/qa/check-qa-scripts.js` — warns (or `--strict` fails) when the
  DoD-referenced runtime QA tiers aren't wired into `package.json`.

The harness ships only these gates. The runtime QA tiers (`test:quick`,
`test:routes`, `test:api`, `test:verify`, `test:security`) and their backing
scripts are **project-provided** — the rulebook references them, and
`check-qa-scripts.js` reminds you if they're missing.

## Update

```bash
npx @dombaras/agent-harness update --target /path/to/project
```

- Overwrites harness-owned files, preserves `.agents/memory/*`, `.agents/reviews/*`, `.agents/handoffs/*`, `.agents/qa-plans/*`, and `BACKLOG.md`.
- Auto-wires the harness gate scripts (`test:dispatch`, `test:governance`,
  `test:qa-plan`, `test:backlog`, `test:product`, `test:docs`, `test:quality`,
  `test:wiring`, `test:linger`, `test:prefix`) plus the `report`,
  `report:cost`, `checkpoint`, and `serve` helpers into the target's `package.json`
  (merged, add-only).
- **Auto-commits** the harness files it changed (`chore(harness): @dombaras/agent-harness
  <old> -> <new>`) and **pushes** to origin, so the next session never sees unexplained
  modified harness files. Your unrelated uncommitted work is never staged. The push
  uses `--no-verify` — a `chore(harness)` maintenance commit must not be stranded by a
  project pre-push gate that legitimately refuses a direct main push.
  - `--no-commit` to skip commit+push, `--no-push` to commit but not push.
  - `init` auto-commits + pushes by default too: it commits everything it scaffolds
    (including `.agents/memory/*`, `.agents/reviews/*`, `.agents/features/*`, `.agents/handoffs/*`, and `BACKLOG.md`) so a fresh
    project starts fully tracked and no harness file is left untracked.
  - Harness-owned paths are **force-added**, so a project that gitignores deployment
    artifacts (an inherited `.agents/` `.opencode/` `AGENTS.md` pattern) still gets the
    harness commit instead of a raw `git add` failure that silently skips it — force-added
    files are called out in the summary.
- **`[Nothing-to-Update]` confirmation**: if the target is already at this CLI's version and no
  harness-owned file changed, `update` says so explicitly, writes nothing, and makes no commit —
  a no-op is never mistaken for a sync and never churns `.harness.json`.
- **Downgrade guard**: `update` refuses to run on a target whose deployed harness is NEWER than
  this CLI (e.g. deployed from a local checkout that was never published) and tells you to publish
  that version first.
- **Published-version check**: if this CLI's version is not the latest `dist-tags.latest` on npm,
  `update` warns you — catches the "bumped the version and updated a project from a local
  checkout, but never published" gap before it silently forks the projects.
- **Non-destructive**: if a harness-owned file was modified locally since the
  last deploy (tracked by checksum in `.harness.json`), it is backed up to
  `.harness-backup/<timestamp>/` before overwrite.
- `opencode.json` is merged (project keys preserved).
- **Local-only excludes — never `.gitignore`**: the harness's local artifacts
  (`.harness-backup/`, `.backlog.lock`, `.serve/`, `.agents/guard-events.jsonl`)
  are recorded in the clone-local `.git/info/exclude` (add-only; pre-existing
  excludes preserved). That file is untracked and never pushed, so the project's
  committed `.gitignore` is **never** read or rewritten. (A pre-0.1.55 managed
  `.gitignore` section truncated project entries after its marker, silently
  un-ignoring `.env`/`data/` — FamilyBudget F-020.) New harness files are tracked
  (committed), not ignored — so they don't need a gitignore change.
- **Managed `.gitattributes` + merge driver**: the harness merges a marked section
  (`BACKLOG.md merge=backlog`) into the project's `.gitattributes` and registers the
  row-aware driver in the local `.git/config` (`merge.backlog.driver`). The driver script is
  committed; the config pointer is per-clone, so `init`/`update` (re)register it on every
  deploy.
- `--dry-run` previews the plan without writing.

### Release cycle & `doctor`

`init` seeds a working CI/CD release scaffold create-if-missing (never overwritten,
so your edits survive `update`): the CI gate, the CI-triggered artifact deploy,
the UAT health probe, `.husky/pre-push` (process gates), `.vercelignore`, and
`docs/ci-cd-pipeline.md`. The cycle is:

```
worktree → npm run ship → direct fast-forward push to main → CI → (on CI success) deploy UAT → health probe
```

`ship` runs the harness process gates itself (not just via the git hook), lands
`HEAD:main` with a direct fast-forward push (retrying after a concurrent
landing), and **waits for CI to go green on the landed SHA** — the deploy runs
only after CI succeeds. Check readiness at any time with the deterministic report:

```bash
npx @dombaras/agent-harness doctor --target /path/to/project
```

It reports git/remote/branch, `gh` + auth, the CI/deploy workflows, the pre-push
gate, the Vercel link, and the local-only ignores. Missing infrastructure is a
warning; a missing prerequisite for the cycle the harness promises is a failure.

### Backlog migration (`migrate-backlog`)

```bash
npx @dombaras/agent-harness migrate-backlog --target /path/to/project
```

Consolidates any live `.agents/features/INDEX.md` F-rows and
`.agents/memory/todo.md` list items into the canonical `BACKLOG.md`, then rewrites
both as pointers. Idempotent — re-running never duplicates rows (it only merges into
an empty board) — and never deletes a source before `BACKLOG.md` is written and
verified. Logs a summary: `N open · M frozen · K archived`.

## Develop

```bash
npm test          # node --test
npm run lint      # syntax-check the CLI + QA scripts
node bin/agent-harness.js list
node bin/agent-harness.js init --target /tmp/demo --name Demo --yes
```

### Running on WSL2

- Keep the checkout and target projects on the Linux filesystem
  (`~/develop/...`), never on `/mnt/c` — Node/npm I/O over the Windows drvfs
  mount is far slower. `init`/`update` warn when a target is on `/mnt/<drive>/`.
- `.gitattributes` pins `*.sh` to LF (and `*.ps1` to CRLF); the same rules are
  merged into every deployed project, so POSIX scripts survive a Windows-side
  checkout. See the `switch-reasoning-model.sh` POSIX twin, platform-dispatched
  by the `/switch-model` command.
- Worktrees live in a sibling container (`<repo>/../.worktrees/<repo>/<id>`), so
  allow `~/develop/**` in the global `opencode.jsonc`
  `permission.external_directory` or each worktree access prompts.

Clear the data-test except keep `templates/` generic; do not commit a target
project's `.agents/memory/` into this repo.
