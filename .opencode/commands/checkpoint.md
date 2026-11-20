---
description: Checkpoint the current work unit — write the deterministic bounded state block so a fresh session can resume without the transcript.
---

Write a checkpoint for the work unit now, using the `checkpoint_write` tool (or
`node scripts/checkpoint.js write --feature <id> ...`).

1. Name the feature: the BACKLOG row ID or handoff slug (same ID used for
   `.agents/handoffs/<id>.md`).
2. Record the compact deterministic state — never a transcript dump, never an
   invented value (omit what you don't know; the block marks it `unknown`):
   - `objective` — the single work unit's goal
   - `phase` — where the work is now
   - `completed` / `active` — finished and in-flight work (dispatches included)
   - `filesChanged` — paths touched
   - `contracts` — shared contracts in play
   - `facts` — established, evidence-backed facts
   - `decisions` — decisions taken
   - `risks` — open questions / risks
   - `nextAction` — the one next action for the resuming session
   - `session` — the `session_info` id when known
3. Do not kill a running tool call to checkpoint — let it finish first.
4. Confirm the tool reports the checkpoint written (it prints the file and
   `checkpoint_count`), then continue or finish the session per the context
   budget.
