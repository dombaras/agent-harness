# Model routing

This project's subagent personas run on their own models via the `model:`
frontmatter in `.opencode/agents/<name>.md`. This file documents the tiering
policy — the concrete model IDs are the source of truth in the agent files
(and `opencode.json` for the main conversation).

## Tiers (recommended — override per-project)

| Tier | Purpose |
|---|---|
| reasoning (hard) | System architecture, security review |
| reasoning (debug) | Error / performance / API debugging |
| reasoning (plan/review) | Planning, product design, QA architecture |
| general | Everyday coding, UI design, mobile native, infra/devops, data, QA execution, feature registrar |
| mechanical | Handoffs |

The reasoning tier is split by persona: hard reasoning (architecture, security)
keeps the strongest reasoning model; debugging runs on a fast frontier reasoning
model; plan/review runs on a strong tool-use model. The harness ships a
recommended concrete mapping for each (hard reasoning → strongest reasoning
model, debug → fast frontier reasoning model, plan/review + general → strong
coder/tool-use model, mechanical → cheap fast model). Change it only by editing
`.opencode/agents/<name>.md` `model:` — the `model:` label in
`.agents/skills/*/SKILL.md` is informational only and does NOT route models.

## Per-persona enforcement

In addition to `model:`, agent files carry mechanical guardrails in their
frontmatter:

- **Thinkers** (`planner`, `product-manager`) have `permission: { edit: deny, bash: deny }`.
- **`qa-architect`** has `permission: { bash: deny }` (authors tests, never runs).
- **`handoff`** has `permission: { bash: deny }`.
- **`features`** (Feature Registrar) has `permission: { bash: deny }` — owns `BACKLOG.md` (repo root) + `.agents/features/*` **tree structure only** (scaffolding, never doc content). It does NOT author `intent`/`scope`/`plan`/`tests` and does NOT dispatch author personas — those are dispatched by the orchestrator directly.
- **`docs`** (Documentation Keeper) has `permission: { bash: deny }` and `edit` allowing everything except harness/governance paths — owns `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `docs/**` (human-facing docs); never edits code or `.agents/**` memory.
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

## Escalation ladder (evidence-based, never by default)

Cheap/default models are the normal execution tier. Escalate a persona to a
stronger reasoning tier only on concrete evidence, in this order:

1. **Attempt** the task on its pinned (cheap) model.
2. On failure, **one targeted retry** with corrected evidence/context (see
   §Dispatch failure ladder).
3. On repeated failure, **escalate to the next tier** only when the blocker is
   one of: repeated test failures after materially different fixes, contradictory
   evidence, cross-module reasoning failure, security-sensitive ambiguity,
   unresolved concurrency/state issues, or a genuinely-blocking workaround risk.
4. **Record it** — log the escalation as `escalated: <persona> -> <tier> reason: <...>`
   in the session's dispatch log, so the cost is visible and auditable.

Do NOT escalate merely because a first attempt was imperfect, the answer was
long, the task is technically complex, the agent asked for more context, or the
agent expressed uncertainty without evidence. A strong model is a scarce
resource, not a preference.

## Role-aware context (inject the minimum sufficient context)

A persona must consume only the context its role actually needs — never every
memory artifact "because it exists". The dispatch prompt carries the persona's
required reads plus the bounded task spec; the persona's `SKILL.md` lists its
own mandatory inputs. Reference map (project may override):

| Persona (class) | Required context |
|---|---|
| planner | product-principles, feature `intent.md`, flow-map, model-routing |
| product-manager | product-principles, feature `intent.md` |
| system-architect / security-engineer | stack-versions, environments, relevant flow-map |
| frontend-engineer / mobile-engineer / ui-designer | relevant product-principles, relevant flow-map, assigned feature context |
| diagnostics-expert | locations, stack-versions, relevant flow-map |
| devops-engineer / data-engineer | environments, stack-versions, assigned task context |
| qa-architect / qa-runner | flow-map, changed-surface info, QA memory |
| docs | only the product/feature info needed to produce the requested docs |
| features / handoff | BACKLOG.md + `.agents/features/*` (features); locations (handoff) |

The rule is **minimum sufficient context, not minimum possible context** — never
drop context that is required for correctness.

## Gates

- `npm run test:dispatch` — `scripts/qa/check-dispatch-config.js` verifies model
  pins, persona↔skill parity, the output-contract marker, and that this doc does
  not name a concrete model no longer pinned anywhere (doc↔config drift).
- `npm run test:governance` — `scripts/qa/governance.js` enforces the wrap-up
  dispatch log.
- `npm run test:qa-plan` — `scripts/qa/check-qa-plan.js` enforces diff coverage:
  every changed CODE path must have a covering assertion (or a waivered reason)
  in `.agents/memory/qa-plan.md` before the change is verified.
- `scripts/qa/check-qa-scripts.js` — verifies the DoD-referenced QA tier scripts
  (project-provided) are wired into `package.json`.

Run `test:dispatch` after editing any agent/skill path, and `test:qa-plan` on any
change that touches code paths.

## Gotchas

- Restart the agent CLI after editing `opencode.json` or agent files (read once at startup).
