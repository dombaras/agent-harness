# Locations map

Canonical index of where sessions, logs, docs, and data live. Update whenever a
session creates, discovers, or changes an important location. **Read this before
reading or editing an unfamiliar path** — a guessed path is a measured waste (the
context-guard nudges a failed `read`/`edit` back here rather than letting the
agent re-hunt).

- **Repos**: 
- **Logs / telemetry**: 
- **DB / env**: 
- **Docs**: 
- **Session checkpoints / handoffs**: `.agents/handoffs/<feature-id>.md` — one per session/work unit, named for the **BACKLOG feature id** (not `next.md`/`pending.md`). Write with the `checkpoint_write` tool, load with `checkpoint_resume <feature-id>` (or `/resume`). List what exists with `Glob .agents/handoffs/*.md` before assuming a name.
- **AI session archives**: opencode: <path>; antigravity: <path>; vscode: <path> (record each front-end's session/history path — the docs reconstruction bundle reads these)
