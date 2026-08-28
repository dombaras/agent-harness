# agent-harness

A reusable multi-agent harness for AI-assisted development. Ships a persona
fleet (planner, engine engineer, mobile, QA architect/runner, security,
architecture, product, data, devops, handoff), operating rules, model routing,
and QA gates — then deploys them into any project.

> Extracted from a production project so the "agents / subagents / guardrails /
> personas" layer is **not** an inherent part of the app codebase. It lives in its
> own repo and is installed via `npx agent-harness init`.

## Why

- The agent harness is tooling, not application code. It should not be committed
  into every app repo.
- One canonical, versioned source of truth for personas/rules/QA tiers, deployed
  on demand and updatable via `npx agent-harness update`.

## Install & initialize

```bash
# from anywhere (uses a target dir or defaults to cwd)
npx agent-harness init --target /path/to/project --name "MyApp" --domain "a widget catalog"

# non-interactive
npx agent-harness init --target . --yes
```

`init` writes:

| Path | Content | Ownership |
|---|---|---|
| `AGENTS.md` | root dispatcher | harness (overwrite) |
| `.opencode/agents/*.md` | 13 persona subagent defs (with `model:` pins) | harness (overwrite) |
| `.agents/AGENTS.md` | full operating rulebook | harness (overwrite) |
| `.agents/rules/00-operating.md` | always-loaded rules summary | harness (overwrite) |
| `.agents/skills/*/SKILL.md` | persona instruction skills | harness (overwrite) |
| `opencode.json` | main/small model routing | harness (overwrite) |
| `scripts/qa/*` | `test:dispatch` / `test:governance` gates | harness (overwrite) |
| `.agents/memory/*` | project data (domain-map, stack-versions, handoff, locations, model-routing) | **project** (create-if-missing) |
| `.harness.json` | deployed version + project profile | harness |

## Placeholders

Templates use `{{PROJECT_NAME}}` and `{{PROJECT_DOMAIN}}`; `init` substitutes
them from `--name` / `--domain` (or prompts, or `.harness.json`). Domain facts
that are genuinely project-specific (entity model, catalog sources, visibility
tiers, trust tiers) live in `.agents/memory/domain-map.md`, which `init`
scaffolds for you to fill in — the skills reference it instead of hardcoding
domain assumptions.

## Model routing

- Concrete models are set in `.opencode/agents/<name>.md` (`model:` field) and
  `opencode.json` (`model` + `small_model`).
- `.agents/skills/*/SKILL.md` carries a `model:` label only (informational).
- `npx agent-harness list` prints the persona → model mapping.
- `npm run test:dispatch` mechanically verifies model pins against
  `scripts/qa/models.allowlist.txt`.

## Update

```bash
npx agent-harness update --target /path/to/project
```

Overwrites harness-owned files, preserves `.agents/memory/*`.

## Develop

```bash
node bin/agent-harness.js list
node bin/agent-harness.js init --target /tmp/demo --name Demo --yes
```

Clear the data-test except keep `templates/` generic; do not commit a target
project's `.agents/memory/` into this repo.
