# Operating Rules

The canonical operating rulebook for this project lives in [`.agents/AGENTS.md`](.agents/AGENTS.md), with an always-loaded rules summary in [`.agents/rules/00-operating.md`](.agents/rules/00-operating.md).

Read and follow it **before starting any task**. It governs:

- Debugging discipline (log-first, zero speculation)
- Data & business-logic integrity (no hardcoded mocks)
- UI/UX, mobile ergonomics, and RTL support
- Framework / backend architecture
- Token-efficiency discipline
- The QA tier system (regression + progression)
- The commit-and-push gate

Domain-specific personas live in [`.agents/skills/`](.agents/skills/) — consult the relevant one for security, architecture, frontend, QA, UI, or product work.

> This agent harness is deployed and maintained by `agent-harness` (`npx agent-harness init` / `npx agent-harness update`). Do not hand-edit the persona/skill/rules files in place — regenerate them from the harness and commit the deltas.
