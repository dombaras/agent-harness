# @dombaras/agent-harness

A reusable multi-agent harness for AI-assisted development. Ships a persona
fleet (planner, engine engineer, mobile, QA architect/runner, security,
architecture, product, data, devops, handoff), operating rules, model routing,
and QA gates — then deploys them into any project.

> Extracted from a production project so the "agents / subagents / guardrails /
> personas" layer is **not** an inherent part of the app codebase. It lives in its
> own repo and is installed via `npx @dombaras/agent-harness init`.

## Why

- The agent harness is tooling, not application code. It should not be committed
  into every app repo.
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
| `.opencode/agents/*.md` | 13 persona subagent defs (with `model:` pins + `permission`/`steps`/`temperature`/`hidden`) | harness (overwrite) |
| `.agents/AGENTS.md` | full canonical operating rulebook | harness (overwrite) |
| `.agents/rules/00-operating.md` | always-loaded rules summary (wired into `opencode.json` `instructions`) | harness (overwrite) |
| `.agents/skills/*/SKILL.md` | persona instruction skills | harness (overwrite) |
| `opencode.json` | main/small model routing + `instructions` | harness (**merged**, see below) |
| `scripts/qa/*` | `test:dispatch` / `test:governance` / `test:qa-plan` gates + QA-script wiring check | harness (overwrite) |
| `.agents/memory/*` | project data (domain-map, stack-versions, handoff, locations, model-routing, history, flow-map, qa-plan) | **project** (create-if-missing) |
| `.harness.json` | deployed version + project profile + per-file checksums | harness |

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

**Flow map (`.agents/memory/flow-map.md`)** — the project-owned registry powering the
flow-closure half of `test:qa-plan`. Each user-facing flow lists the code surfaces that
implement the same behavior across codebases/layers (e.g. web component, `mobile/` sheet,
API route) plus its optional variants (e.g. `condition-selector-present` vs `-absent`). Fill
it in so a change to one surface is forced to account for all the others. If empty, the gate
warns but does not block; the guarantee only applies to registered flows.

## Model routing & enforcement

- Concrete models are set in `.opencode/agents/<name>.md` (`model:` field) and
  `opencode.json` (`model` + `small_model`).
- Personas also carry mechanical guardrails in frontmatter:
  - thinkers (`planner`, `product-manager`) → `permission: { edit: deny, bash: deny }`
  - `qa-architect`, `handoff` → `permission: { bash: deny }`
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

## QA gates

- `npm run test:dispatch` — persona model-pin preflight + persona↔skill parity + model-routing↔pin drift check.
- `npm run test:governance` — session wrap-up dispatch-log enforcement.
- `npm run test:qa-plan` — **diff-coverage + flow-closure gate**:
  every changed CODE path must have a covering assertion (or a waivered reason) in
  `.agents/memory/qa-plan.md` before a change is verified — and every touched flow
  (`.agents/memory/flow-map.md`) must have every sibling surface and declared optional
  variant addressed in the plan's `## Parallel-surface & variant audit`. Kills the
  "verified by a suite that never touched the change" failure mode: a tier label never
  proves coverage. It also makes **"Fix One, Fix All" mechanical**: a change to one
  surface (e.g. web) cannot ship while the same flow in another codebase (e.g. `mobile/`)
  silently keeps old behavior — the plan must name each sibling as covered (`->`) or
  out-of-scope (`audited: reason`, e.g. `deferred — logged in handoff.md`).
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

- Overwrites harness-owned files, preserves `.agents/memory/*`.
- Auto-wires the harness gate scripts (`test:dispatch`, `test:governance`,
  `test:qa-plan`) into the target's `package.json` (merged, add-only).
- **Auto-commits** only the harness files it changed (`chore(harness): @dombaras/agent-harness
  <old> -> <new>`) and **pushes** to origin, so the next session never sees unexplained
  modified harness files. Your unrelated uncommitted work is never staged.
  - `--no-commit` to skip commit+push, `--no-push` to commit but not push.
  - `init` never commits.
- **Non-destructive**: if a harness-owned file was modified locally since the
  last deploy (tracked by checksum in `.harness.json`), it is backed up to
  `.harness-backup/<timestamp>/` before overwrite.
- `opencode.json` is merged (project keys preserved).
- `--dry-run` previews the plan without writing.

## Develop

```bash
npm test          # node --test
npm run lint      # syntax-check the CLI + QA scripts
node bin/agent-harness.js list
node bin/agent-harness.js init --target /tmp/demo --name Demo --yes
```

Clear the data-test except keep `templates/` generic; do not commit a target
project's `.agents/memory/` into this repo.
