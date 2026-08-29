# {{PROJECT_NAME}} — Agent Operating Rules

The always-loaded rules summary lives in [`.agents/rules/00-operating.md`](.agents/rules/00-operating.md) (wired into `opencode.json` `instructions`). The full, canonical rulebook is [`.agents/AGENTS.md`](.agents/AGENTS.md) — read it before any non-trivial work.

It governs: Step Zero subagent dispatch, zero-speculation debugging, data integrity, UI/RTL ergonomics, stack-version discipline, token efficiency, right-sized QA tiers, and the commit-and-push gate.

- **Dispatch personas** via the `task` tool (see `.agents/rules/00-operating.md` §Step Zero); consult the relevant `.agents/skills/<persona>/SKILL.md`.
- **Every change touching code paths gets a QA plan** (`.agents/memory/qa-plan.md`) from `qa-architect` — if it isn't dispatched, the main orchestrator plans in its place. `npm run test:qa-plan` fails on any changed code path with no covering assertion or waiver.
- **At session start**, read `.agents/memory/locations.md` and `.agents/memory/model-routing.md`.

> Deployed and maintained by `@dombaras/agent-harness` (`npx @dombaras/agent-harness init` / `update`). Do not hand-edit harness-owned files — regenerate them and commit the deltas.
