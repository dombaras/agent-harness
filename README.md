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
| `scripts/qa/*` | `test:dispatch` / `test:governance` / `test:qa-plan` gates + QA-script wiring check | harness (overwrite) |
| `scripts/backlog.js` | deterministic `BACKLOG.md` editor (list/add/take/archive/freeze) | harness (overwrite) |
| `.opencode/tools/backlog.ts` | `backlog_*` custom tools the LLM calls (shell out to the CLI) | harness (overwrite) |
| `.opencode/plugins/backlog-notify.ts` | toast/log whenever an agent mutates the board | harness (overwrite) |
| `.agents/memory/*` | project data (domain-map, stack-versions, locations, model-routing, orchestration, history, flow-map, product-principles, quality-parameters) | **project** (create-if-missing) |
| `.agents/reviews/*` | project data (durable review/audit deliverables — REPORT.md + scans, tagged by quality-parameters) | **project** (create-if-missing) |
| `.agents/handoffs/*` | project data (one session handoff file per session — sharded so concurrent sessions never collide) | **project** (create-if-missing) |
| `.agents/qa-plans/*` | project data (one QA plan file per change — sharded so concurrent sessions never collide) | **project** (create-if-missing) |
| `.harness.json` | deployed version + project profile + per-file checksums | harness |
| `.gitignore` | harness-managed section (`.harness-backup/`) merged in, project entries preserved | harness (merged) |
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
resumes from the checkpoint instead of replaying the transcript. Every handoff can
carry a `## Session metadata` block (`work_type`, `outcome`,
`termination_reason`, `checkpoint_count` — controlled vocabularies, never
fabricated) that `npm run report` aggregates deterministically per feature.

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
  stale model no longer pinned anywhere (doc↔config drift).
- **`/switch-model` command** — every deploy ships an opencode command
  (`.opencode/command/switch-model.md`) plus `scripts/switch-reasoning-model.ps1`
  that rewrites the main `opencode.json` `model` and the six reasoning-tier
  agents (planner, system-architect, security-engineer, diagnostics-expert,
  product-manager, qa-architect) in one step — a blunt override of the tiered
  default. Aliases: `deepseek`/`flash`/`direct` → `deepseek/deepseek-v4-flash`
  (default, direct API key), `pro`/`deepseek-pro` → `deepseek/deepseek-v4-pro`
  (escalation), `zen`/`opencode` → `opencode/deepseek-v4-pro` (gateway),
  `pickle` → `opencode/big-pickle`, `nvidia`/`kimi`/`kimi-k3` →
  `nvidia/moonshotai/kimi-k3` (NVIDIA NIM), `nemotron`/`nemotron-ultra` →
  `nvidia/nemotron-3-ultra-550b-a55b:free` (NVIDIA NIM, free),
  `openrouter`/`or`/`m3` → `openrouter/minimax/minimax-m3` (OpenRouter), or any
  explicit `provider/model`. Restart opencode after switching (config reads once).
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
  creates a `git worktree` + branch and auto-takes the row. Every feature works in its own
  checkout — `main` stays board + shippable code only — so one session's uncommitted work
  can't leak into another's pre-push gate. Worktrees land in a single hidden container
  sibling, `<repo>/../.worktrees/<repo>/<id>`, so the parent folder (e.g. `C:\develop`)
  only ever holds top-level projects. `backlog archive <id>` removes the shipped
  feature's worktree + merged branch, so a session cleans up after itself on close.
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
  row, so a dirty board under 2+ active sessions is a hard failure.
- `npm run test:integrate` — pre-push rebase check: fails when the current branch
  is behind `origin/main`, reminding you to `git rebase` and re-run the board +
  concurrency gates before pushing, so conflicts surface early.
- `npm run test:quality` — **mechanical code-quality gate on new/grown code**:
  flags dead exports (a symbol whose only reference is its own declaration) and
  files that are new or grew past the line limit (default 1000). Runs against the
  diff by default (`--paths a,b` to target files, `--base <ref>` to set the
  baseline, `--strict` for CI). Canonical rubric: `.agents/memory/quality-parameters.md`.
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
  `test:qa-plan`, `test:backlog`, `test:product`, `test:docs`) into the target's `package.json` (merged, add-only).
- **Auto-commits** the harness files it changed (`chore(harness): @dombaras/agent-harness
  <old> -> <new>`) and **pushes** to origin, so the next session never sees unexplained
  modified harness files. Your unrelated uncommitted work is never staged.
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
- **Managed `.gitignore`**: the harness merges a marked section (`.harness-backup/`, its
  local rollback artifacts) into the project's `.gitignore`, preserving every project entry.
  New harness files are tracked (committed), not ignored — so they don't need a gitignore
  change. If the harness ever adds a new local-only artifact, `update` re-merges the entry.
- **Managed `.gitattributes` + merge driver**: the harness merges a marked section
  (`BACKLOG.md merge=backlog`) into the project's `.gitattributes` and registers the
  row-aware driver in the local `.git/config` (`merge.backlog.driver`). The driver script is
  committed; the config pointer is per-clone, so `init`/`update` (re)register it on every
  deploy.
- `--dry-run` previews the plan without writing.

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

Clear the data-test except keep `templates/` generic; do not commit a target
project's `.agents/memory/` into this repo.
