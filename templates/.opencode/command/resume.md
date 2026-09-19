---
description: Resume a bounded orchestration context from the session checkpoint — reads only the checkpoint state, never the transcript.
---

Resume the named work unit from its deterministic checkpoint.

1. Determine the feature ID (BACKLOG row ID or handoff slug). If the user did not
   name one, list candidates with `node scripts/checkpoint.js resume --feature <id>`
   only after confirming the ID — never guess a file.
2. Print the bounded state:
   ```
   node scripts/checkpoint.js resume --feature <id>
   ```
   (or the `checkpoint_resume` tool). Treat the printed block as the full state of
   the work: objective, phase, completed/active work, files changed, contracts,
   facts, decisions, risks, next action.
3. Do NOT replay or re-read the previous transcript/history. Read only the files
   the checkpoint's `next_action` / `active` entries require, plus the normal
   session-start memory files.
4. Continue from `next_action`. When implementation + verification are complete
   and only the finalization tail remains, do NOT checkpoint-and-stop: run
   `npm run finalize -- --feature <id>` ONCE (or `/finish <id>`) and let it run
   to completion — it archives, commits, ships, and watches to landed + UAT
   deploy in a single blocking call. Otherwise update the checkpoint
   (`checkpoint_write`) as work progresses and close the session normally
   (handoff + board write-back).

If the feature has no checkpoint, say so and STOP — do not reconstruct state by
guessing.
