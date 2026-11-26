# F-051 — auto clear-resume at the context ceiling

## Actors/Who
- The person running a long feature unattended with `agent-harness run` (overnight, or a full multi-hour cycle).
- The primary orchestrator session that hits its context budget mid-feature.

## Need/Why
A bounded context is the right size for one phase, but a full cycle (plan → implement → QA → gates → ship) is several phases. Today the context guard can only *warn* the session; when the transcript reaches the ceiling, the work stops and a human has to type `/resume` for every phase. That makes unattended runs stall exactly when they are most valuable, and a manual resume invites replaying the transcript instead of reading the checkpoint.

## Outcome
When a session in a feature worktree crosses the guard's `intervene` level, the runner treats the phase exit as a **resumable context boundary** — but only if a *fresh* marker was written during the phase, for the same feature, and the checkpoint actually advanced (or records a next action). It then relaunches a fresh bounded context from the checkpoint. A reset loop is bounded (default 3 consecutive resets, `--max-context-resets`), and a phase with no recorded progress stops instead of relaunching.

## Acceptance criteria
- `agent-harness run` resumes automatically after a context boundary with a non-zero phase exit, with no manual `/resume`.
- A stale marker (written before the phase), another feature's marker, or a checkpoint that did not advance stops the loop with a reason that names the cause.
- The consecutive-reset cap stops the loop before a runaway relaunch, and the cap is configurable.
- An interactive TUI session on `main` is never auto-relaunched (the guard writes no marker there; it keeps the advisory nudge).
- `run-loop.js` stays pure and dependency-free; all decision rules are unit-tested; deployed `scripts/qa/**` stays byte-identical to `templates/scripts/qa/**`.
