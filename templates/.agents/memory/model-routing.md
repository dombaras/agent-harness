# Model routing

This project's subagent personas run on their own models via the `model:`
frontmatter in `.opencode/agents/<name>.md`. This file documents the tiering
policy — the concrete model IDs are the source of truth in the agent files
(and `opencode.json` for the main conversation).

## Tiers (recommended — override per-project)

| Tier | Purpose |
|---|---|
| reasoning | Planning, architecture, security review, debugging, product design, QA architecture |
| general | Everyday coding, UI design, mobile native, infra/devops, data, QA execution |
| mechanical | File reads, commits, handoffs |

The harness ships a recommended concrete mapping (`reasoning` → a strong
reasoning model, `general` → a strong coder model, `mechanical` → a cheap fast
model). Change it only by editing `.opencode/agents/<name>.md` `model:` — the
`model:` label in `.agents/skills/*/SKILL.md` is informational only and does NOT
route models.

## Per-persona enforcement

In addition to `model:`, agent files carry mechanical guardrails in their
frontmatter:

- **Thinkers** (`planner`, `product-manager`) have `permission: { edit: deny, bash: deny }`.
- **`qa-architect`** has `permission: { bash: deny }` (authors tests, never runs).
- **`handoff`** has `permission: { bash: deny }`.
- **Code personas** (`frontend-engineer`, `mobile-engineer`, `ui-designer`,
  `data-engineer`, `devops-engineer`, `security-engineer`, `system-architect`,
  `diagnostics-expert`) allow `edit` everywhere except governance/harness paths
  — `opencode.json`, `.harness.json`, `.opencode/**`, `.agents/**` are denied —
  so out-of-scope edits are blocked mechanically, not just by prose.
- **Deterministic personas** (`planner`, `qa-architect`, `qa-runner`, `handoff`,
  `diagnostics-expert`) pin `temperature: 0.1`.
- **`steps:`** caps iterations per persona (cost ceiling).
- **`planner` / `handoff`** are `hidden: true` (orchestration-only, not in the
  `@` menu).

## Subagent output contract

Every subagent must return a single final message with, in order:

1. **Result** — what was shipped / decided.
2. **Evidence** — commands run or files changed with observed output.
3. **Deferred & risks** — what remains and follow-ups the orchestrator must handle.

## Dispatch failure ladder (never silent)

1. Retry once (resume the same `task_id`).
2. Degrade inline on the main model and log `degraded: <persona> model: <reason>`.
3. Never silently skip or re-scope — only waive via the explicit waiver path.

## Gates

- `npm run test:dispatch` — `scripts/qa/check-dispatch-config.js` verifies model
  pins, persona↔skill parity, the output-contract marker, and that this doc does
  not name a concrete model no longer pinned anywhere (doc↔config drift).
- `npm run test:governance` — `scripts/qa/governance.js` enforces the wrap-up
  dispatch log.
- `scripts/qa/check-qa-scripts.js` — verifies the DoD-referenced QA tier scripts
  (project-provided) are wired into `package.json`.

Run `test:dispatch` after editing any agent/skill path.

## Gotchas

- Restart the agent CLI after editing `opencode.json` or agent files (read once at startup).
