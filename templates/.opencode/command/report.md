---
description: Print a deterministic agent-efficiency report from the session handoffs (dispatches, retries, escalations, work type, outcome, checkpoints) — no LLM in the loop.
---

Run the deterministic dispatch report:

```
node scripts/agent-report.js
```

(or `node scripts/agent-report.js --json` for machine-readable output).

This aggregates the `## Dispatch log` / `## Retries` / `## Escalations` /
`## Session metadata` sections across every `.agents/handoffs/*.md` and prints
dispatches by persona and model, recorded work-type/outcome/termination counts,
per-feature traces, and deterministic suggestions (duplicate personas, high
fan-out needing review, retries with no stated change).

Report the numbers verbatim. Do NOT fabricate token counts or cost — the handoff
does not record per-token telemetry; that lives in the provider's session stats.
Absent metadata is simply not counted (distinct from `unknown`, which is).
