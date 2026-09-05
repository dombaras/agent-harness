# {{PROJECT_NAME}} — Agent Operating Rules

The always-loaded rules summary lives in [`.agents/rules/00-operating.md`](.agents/rules/00-operating.md) (wired into `opencode.json` `instructions`). The full, canonical rulebook is [`.agents/AGENTS.md`](.agents/AGENTS.md) — read it before any non-trivial work.

It governs: Step Zero subagent dispatch, zero-speculation debugging, data integrity, UI/RTL ergonomics, stack-version discipline, token efficiency, right-sized QA tiers, and the commit-and-push gate.

- **Dispatch personas** via the `task` tool (see `.agents/rules/00-operating.md` §Step Zero); consult the relevant `.agents/skills/<persona>/SKILL.md`.
- **Features**: capture a found item as one light row in the canonical `BACKLOG.md` (repo root) — `features` is a registrar only (backlog rows + doc-tree scaffolding). Update the board with the `backlog_*` tools (or `node scripts/backlog.js`), never hand-edit `BACKLOG.md`. When a feature is picked up, author the per-feature doc chain (intent/scope/plan/tests) by dispatching each author persona **directly** (`product-manager` → intent, `system-architect` → scope, `planner` → plan, `qa-architect` → tests) — never via `features`. For an "investigate + plan" request, dispatch `planner` / `product-manager` directly.
- **Product-first planning**: planning is value-led, not tech-led — define the user (actor/need/outcome/acceptance) before code, sequence work value-first against `.agents/memory/product-principles.md`, and let `npm run test:product` enforce it.
- **Docs**: human-facing docs (`README.md`, `CHANGELOG.md`, `docs/**`) are owned by the `docs` persona — docs point at code, never duplicate it, and `npm run test:docs` enforces no placeholders / no dangling links / well-formed ADRs / every shipped commit has a changelog entry.
- **Every change touching code paths gets a QA plan** (a per-change file under `.agents/qa-plans/`) from `qa-architect` — if it isn't dispatched, the main orchestrator plans in its place. `npm run test:qa-plan` fails on any changed code path with no covering assertion or waiver, and on any touched flow (`.agents/memory/flow-map.md`) whose sibling surfaces / declared variants the plan doesn't address.
- **At session start**, read `.agents/memory/locations.md`, `.agents/memory/model-routing.md`, `.agents/memory/product-principles.md`, and `BACKLOG.md`.

> Deployed and maintained by `@dombaras/agent-harness` (`npx @dombaras/agent-harness init` / `update`). Do not hand-edit harness-owned files — regenerate them and commit the deltas.
