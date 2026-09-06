---
description: Print a deterministic agent-efficiency report from the session handoffs (dispatches, retries, escalations) — no LLM in the loop.
---

Run the deterministic dispatch report:

```
node scripts/agent-report.js
```

(or `node scripts/agent-report.js --json` for machine-readable output).

This aggregates the `## Dispatch log` / `## Retries` / `## Escalations` sections
across every `.agents/handoffs/*.md` and prints dispatches by persona and model,
per-feature traces, and any deterministic absorb-before-spawn suggestions.

Report the numbers verbatim. Do NOT fabricate token counts or cost — the handoff
does not record per-token telemetry; that lives in the provider's session stats.
