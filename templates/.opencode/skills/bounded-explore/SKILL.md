---
name: bounded-explore
description: Use before dispatching the explore subagent for broad codebase search — fixes the bounded input (paths + exact question + result budget) and the output contract (file:line pointers + a short summary, no whole-file dumps).
---

# Bounded explore dispatch

Load this before every `explore` dispatch. An unbounded explore is the most
expensive dispatch in the harness (the `0.1.120` recon measured ~465K input
tokens per call). The fix is not to stop exploring — it is to bound the ask and
the answer.

## Input contract (what the dispatch prompt must carry)

1. **Paths** — the exact directories/files to search (`app/api/**`,
   `mobile/src/screens/**`), never "the codebase". A path list is what keeps the
   subagent out of `node_modules`/build trees and unrelated surfaces.
2. **The exact question** — one answerable question ("where is the session token
   refreshed on 401?"), not a topic ("look into auth"). If you cannot phrase it
   as a question with a definite answer, do the read yourself first.
3. **Result budget** — state it in the prompt: *"return ≤ N file:line pointers
   plus a ≤ M line summary; no whole-file contents, no transcript replay."*
   Default N=20, M=15 unless the task needs more.

## Output contract (what explore must return)

- **`file:line` pointers** to the answer, each with a one-line note on why it
  matters.
- **A short summary** (≤15 lines) of the mechanism, in the reader's words.
- **No whole-file dumps, no diffs, no transcript replay.** If a full file is
  genuinely required, return its path and the relevant line range instead.

## When NOT to dispatch explore

- A known path (use `Read` with `offset`/`limit`), a single-file lookup
  (`Grep`/`Glob`), or a tracked-symbol search (`git grep -n <symbol>`) is
  orchestrator work — do it inline. Explore is for *broad, multi-file,
  question-shaped* search the main model cannot cheaply do itself.
