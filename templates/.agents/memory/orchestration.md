# Orchestration & context budget — tunable thresholds

Project-owned (like all `.agents/memory/*`). This file is the single place the
project tunes the cost/context guards the operating rules reference. The values
below are **initial experimental defaults**, not permanent truths — tune them from
post-change data, and record why when you do.

Read this file at session start alongside the other memory files. When a rule
below says "see `.agents/memory/orchestration.md`", resolve the number here.

## Orchestrator (main) context lifecycle

| Setting | Default | Meaning |
|---|---|---|
| `soft_turn_budget` | 60 | main-orchestrator turns before it must checkpoint/compact rather than keep growing |
| `checkpoint_warning_turn` | 50 | first context-pressure warning point (~50) |
| `compaction_target_turn` | 60 | prefer a checkpoint + fresh bounded context (~60) |
| `hard_safety_turn_limit` | 100 | hard runaway ceiling — stop and checkpoint, never kill a running tool call |
| `new_context_preference_turn` | 80 | strongly prefer a new bounded orchestration context (~80) |

## Request-context thresholds (observe → warn → checkpoint → intervene)

Apply where the provider exposes request-token size; otherwise treat as guidance.

| Level | Request tokens (approx) | Behavior |
|---|---|---|
| observe | 50K | record; no action |
| warn | 80K | warn / record context pressure |
| checkpoint | 120K | strong checkpoint recommendation |
| intervene | 160K+ | forced lifecycle intervention (checkpoint + fresh context) |

## Dispatch fan-out review

Review the planner's dispatch count against these bands (configurable):

| Fan-out | Policy |
|---|---|
| 1–4 | normal |
| 5–7 | planner must provide explicit decomposition justification |
| 8–9 | require explicit fan-out review before dispatch |
| 10+ | require strong evidence of independent work |

## Stuck / repeated-failure detection

Defaults for the stuck-agent and retry-loop heuristics:

| Setting | Default | Meaning |
|---|---|---|
| `same_failure_turns` | 3 | N consecutive turns with the same failure before recovery |
| `identical_tool_calls` | 3 | N identical tool calls (same tool+args) before it is a loop |
| `no_state_change_turns` | 4 | N turns with no material file/state change before stuck is declared |

## Escalation

Escalate (per `.agents/memory/model-routing.md`) only on evidence. Record every
escalation structurally in the session handoff.

## Machine-read thresholds (context-guard)

`.opencode/plugins/context-guard.ts` (core: `scripts/qa/context-guard-core.js`)
parses this file at runtime and injects nudges into the primary orchestrator
session:

- **turn bands** — `checkpoint_warning_turn`, `compaction_target_turn`,
  `new_context_preference_turn`, `hard_safety_turn_limit` (the highest value the
  current turn has reached wins; the hard band is an injected nudge, not a
  mechanical block — `agent.build.steps` already ends the turn);
- **request levels** — `observe` / `warn` / `checkpoint` / `intervene` crossings
  from provider token data are recorded (telemetry only, no injection);
- **loops** — `identical_tool_calls` arms the recovery nudge on repeated
  tool+args calls (the runtime's own `doom_loop` permission also arms it).

It appends threshold/loop events to `.agents/guard-events.jsonl` (local-only,
gitignored). Keep the table row shapes above; a missing row falls back to the
documented default. `same_failure_turns` and `no_state_change_turns` remain
advisory prose — they need worktree state the plugin does not poll.

## Policy notes

- Never destroy cache locality to shorten a prompt: keep the stable leading
  context (operating rules → persona → project rules) byte-stable between turns.
- A retry must change instructions / context / model / decomposition /
  diagnostics. Never repeat the identical failing action.
- Checkpoints are compact deterministic state (`.agents/handoffs/<feature-id>.md`
  + this repo's doc/memory), never a full transcript dump.
