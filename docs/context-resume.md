# Context-resume safety rails

F-070 closes three ways the TUI auto-resume could spawn the wrong work.

## What auto-resume does

When a primary session in a feature worktree stops, the context guard writes
`.agents/context-resume.json`; the TUI plugin (`context-resume`) reads that
marker, checks the checkpoint advanced, and creates a fresh session seeded with
the runner's resume or finalize prompt.

## The guards

1. **Subagents never trigger a resume.** A session with a `parentID` is a child
   (QA author, explore, planner, …). Its idle event is task completion, not a
   context boundary. The TUI returns before it writes a fallback checkpoint or
   plans a resume; the pure core also ignores `idleSessionIsChild`.
2. **One live session per worktree.** The plan reads `.serve/sessions/*.json`
   for every checkout, not only `main`. If another lease has a live pid and a
   fresh heartbeat, the resume is refused. The ended session's own lease is
   excluded by id.
3. **The harness default model is explicit.** `session.create` has no model
   field, so the plugin reads the checkout's `opencode.json` (then `.opencode/`
   and the global config) and passes `{ providerID, modelID }` to
   `session.prompt`. An auto-launch no longer inherits whatever model the TUI is
   on — including free fallbacks.
4. **A finished run releases its lease.** Every observed execution end
   (`session.execution.succeeded|failed|interrupted`) clears the session's
   `.serve/sessions/<id>.json`. V2 never emits `session.deleted` for a normal
   run, so a lease cleared only on delete would keep the shared server pid and
   a fresh heartbeat "live" for the 4h window — enough to block the next
   resume's single-live-session gate.

## Code pointers

- Decision core and model parsing:
  `templates/.opencode/plugins/context-resume/resume-plan.mjs`
- TUI wiring (child guard, leases, config read):
  `templates/.opencode/plugins/context-resume/tui.tsx`
- Contract tests:
  `tests/context-resume.test.js`
- Incident evidence: F-050 duplicate finalize sessions on 2026-11-27.
