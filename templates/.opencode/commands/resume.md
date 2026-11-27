---
description: Resume a bounded orchestration context from the session checkpoint — reads only the checkpoint state, never the transcript.
---

Resume the named work unit from its deterministic checkpoint.

1. **Orient in one call on the resumed feature.** The command's argument is the
   feature ID: `$ARGUMENTS`. If it is non-empty, pass it explicitly —
   `node scripts/orient.js --feature $ARGUMENTS` (or the `orient` tool with
   `feature: "$ARGUMENTS"`). An explicit ID is authoritative: never let the
   board's In-progress row (which may belong to another live session) override
   it. Only when no ID was supplied, run `node scripts/orient.js` and use its
   inference. The call returns, in a single invocation: the tree
   root + branch + HEAD + dirty count, the active feature, its checkpoint
   (phase + next action), the board In-progress + next-queued rows, owned files,
   the live `serve.js` jobs + capacity verdict, the last device-run summary, the
   harness version, **and a bounded digest of the session-start memory files**
   (each file's section index + first table). It replaces the hand-rolled
   `git rev-parse`/`branch`/`status`, `serve.js list`, `test:capacity`, and
   memory-read prologue; use the digest and open a memory file only for a fact it
   does not carry.
2. **Confirm the feature ID** (BACKLOG row ID or handoff slug). If an ID came
   with the command, that is the feature — do not re-infer it from the board.
   Otherwise use the checkout ID orient reports (branch/directory), then the
   board's single In-progress row; if it is still ambiguous, confirm the ID —
   never guess a file.
3. **Print the bounded state:**
   ```
   node scripts/checkpoint.js resume --feature <id>
   ```
   (or the `checkpoint_resume` tool). It returns at most ~3 KB: objective, phase,
   next action, the checkpoint state, and a heading outline. Treat that excerpt as
   the state of the work; open one section of the handoff only when the excerpt
   says detail is needed. It never prints the whole handoff.
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
