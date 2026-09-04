---
description: Show the active BACKLOG.md rows (In Progress + Pending) via the deterministic CLI — no filtering, no editing.
---

Run the deterministic board command and show its output verbatim:

```
node scripts/backlog.js list
```

This prints the active `BACKLOG.md` rows (In Progress + Open) with no LLM
filtering or re-ordering. Do NOT summarize or transform the output — copy it
exactly. Do NOT run git, do NOT pull, and do NOT edit `BACKLOG.md` yourself:
the local file is the source of truth, and all board mutations go through the
`backlog_*` tools / `node scripts/backlog.js`.
