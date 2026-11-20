---
description: Resume a bounded orchestration context from the session checkpoint — reads only the checkpoint state, never the transcript.
---

Resume the named work unit from its deterministic checkpoint.

1. **Orient in one call.** Run `node scripts/orient.js` (or the `orient` tool),
   optionally `--feature <id>`. This returns, in a single invocation: the tree
   root + branch + HEAD + dirty count, the active feature, its checkpoint
   (phase + next action), the board In-progress + next-queued rows, owned files,
   the live `serve.js` jobs + capacity verdict, the last device-run summary, the
   harness version, **and a bounded digest of the session-start memory files**
   (each file's section index + first table). It replaces the hand-rolled
   `git rev-parse`/`branch`/`status`, `serve.js list`, `test:capacity`, and
   memory-read prologue; use the digest and open a memory file only for a fact it
   does not carry.
2. **Determine the feature ID** (BACKLOG row ID or handoff slug). `orient`
   infers it from the board (single In-progress row) or the branch; if it is not
   clear, confirm the ID — never guess a file.
3. **Print the bounded state:**
   ```
   node scripts/checkpoint.js resume --feature <id>
   ```
   (or the `checkpoint_resume` tool). Treat the printed block as the full state of
   the work: objective, phase, completed/active work, files changed, contracts,
   facts, decisions, risks, next action.
4. Do NOT replay or re-read the previous transcript/history. Read only the files
   the checkpoint's `next_action` / `active` entries require, plus the normal
   session-start memory files.
5. Continue from `next_action`. When implementation + verification are complete
   and only the finalization tail remains, do NOT checkpoint-and-stop: run
   `npm run finalize -- --feature <id>` ONCE (or `/finish <id>`) and let it run
   to completion — it archives, commits, lands the branch on main, and confirms
   green CI in a single blocking call (the deploy runs after CI). Otherwise
   update the checkpoint (`checkpoint_write`) as work progresses and close the
   session normally (handoff + board write-back).

If the feature has no checkpoint, say so and STOP — do not reconstruct state by
guessing.
