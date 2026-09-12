---
description: Print a deterministic agent-efficiency report from the session handoffs (dispatches, retries, escalations, work type, outcome, checkpoints) — no LLM in the loop. Add --cost for observed provider cost/tokens/turns joined via the handoff session id.
---

Run the deterministic dispatch report:

```
node scripts/agent-report.js
```

For the cost roll-up, join the handoffs to observed provider telemetry
(opencode store — never estimated):

```
node scripts/agent-report.js --cost --since=14d
```

(or `--json` for machine-readable output; add `--fixture <file>` to read a
previously exported provider snapshot and `--export <file>` to write one.)

This aggregates the `## Dispatch log` / `## Retries` / `## Escalations` /
`## Session metadata` sections across every `.agents/handoffs/*.md` and prints
dispatches by persona and model, recorded work-type/outcome/termination counts,
per-feature traces, and deterministic suggestions (duplicate personas, high
fan-out needing review, retries with no stated change).

With `--cost` it also prints observed provider totals, model mix, cache-read
share, P50/P90 cost and turns, the top primary sessions by cost, >60-turn
count, identical-call loop candidates, and cost per feature / per shipped
feature (joined via the handoff `session:` id recorded from `session_info`).

Report the numbers verbatim. Do NOT fabricate token counts or cost — without
`--cost` the handoff records no per-token telemetry; with `--cost` every number
is observed provider data. Absent metadata is simply not counted (distinct from
`unknown`, which is).
