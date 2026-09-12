# Agent Harness Optimization — Implementation Status (v0.1.51)

Tracking doc for the cost/context optimization effort. Basis:
[`docs/cost-optimization-recommendations-2026-09-12.md`](cost-optimization-recommendations-2026-09-12.md)
(R1–R14, derived from a 14-day opencode session analysis) and the local-only
inputs under `Outside advise/` (implementation plan + prompt, not committed).

Purpose: record exactly what shipped, the decisions that changed the plan, and
where to pick up next session. The harness is a **template/deploy package** —
anything marked "rule/policy" is agent-facing prose, not mechanically enforced.

---

## Status snapshot

| Item | Value |
|---|---|
| Version | `0.1.51` |
| Shipped this session | `0.1.48` → `0.1.51` (4 commits) |
| Lint / tests | green — 140/140 (`npm run lint`, `npm test`) |
| LibraryOS | `0.1.51` deployed, committed, **pushed** (`origin/main`) |
| FamilyBudget | `0.1.51` deployed + committed locally (no remote configured) |

---

## What shipped

### `0.1.48` — mechanical main-agent turn cap (the hard half of R2)
- `templates/opencode.json`: `agent.build.steps = 100` — opencode-enforced
  per-turn cap; at the limit the runtime forces a graceful summarization turn
  (never a mid-tool kill). This is the main-orchestrator hard ceiling.
- `bin/agent-harness.js`: `agent` block is deep-merged **ADD-ONLY** — a project's
  own agent config, including an overridden `steps`, always wins.
- Tests: deploy default + ADD-ONLY preservation.

### `0.1.49` — Phase D quick wins (context hygiene)
- **R6 — bounded board listing.** `backlog list --limit N` (default 40, `0` =
  all) prints true section counts + `+K row(s) omitted`; `backlog_list` tool and
  `/board` use the bounded path (no more `--full` dump).
- **R5 — qa-runner evidence off the message.** Full verbatim logs go to
  `.agents/qa-runs/<id>/evidence.txt` (new create-if-missing scaffold); the
  ≤15-line summary carries commands/exit codes, pass/fail per suite, and the
  artifact **path + sha256** (new `scripts/qa/hash-file.js`).
- **R7 — Step Zero reconciled.** `00-operating.md` no longer says "dispatch
  before reading/editing anything": the complexity threshold + dispatch
  economics are the authority. Planner can emit `execution_mode: direct`;
  `test:governance` fails a handoff with 5+ dispatch entries and no
  `## Fan-out justification` / `dispatch_justification:` line.
- `AGENTS.md`: deploy targets are now **LibraryOS + FamilyBudget** (both listed).

### `0.1.50` / `0.1.51` — fan-out gate hardening (field fix)
The new fan-out gate retroactively failed 52 historical LibraryOS handoffs and
blocked its push. Fixed:
- **`0.1.50`**: forward-only — `FANOUT_JUSTIFY_SINCE = 2026-09-12`; handoffs
  dated earlier, or undated legacy handoffs, are grandfathered.
- **`0.1.51`**: the legacy aggregate `.agents/memory/handoff.md` is exempt.
- **Lesson for any future retroactive gate**: grandfather history, or it becomes
  a push blocker. LibraryOS push is green again after the fix.

---

## Decision log (changes to the recommendations doc)

- **R1 (Zen DeepSeek guard) dropped** — user does not use `opencode/deepseek-*`;
  not worth the guard right now.
- **Order changed** from the doc's suggestion to: cap shipped → **C (plugin)**
  → B (telemetry) → remaining D. Rationale: C's mechanisms are cheap and driven
  by already-measured waste; B is the biggest lift, and its baseline can be
  backfilled **retroactively** from the session DB, so C does not need to wait.
- **R2 soft claim (10–15%) stays unproven** — cap shipped first, measure before
  claiming. The plugin's job is 50/60/80 nudges, not the 100-block (the runtime
  cap already ends the turn).
- **R8 deferred** — ~$0.2–0.7/2wk at current rates; splitting every SKILL.md
  into CORE/details invites drift.
- Keep `orchestration.md` project-owned and single-source; the plugin reads it.

## What's next — Phase C (context-guard plugin)

Planned shape (verify against opencode 1.18.30 plugin types before coding):
- New `templates/scripts/qa/context-guard-core.js` (pure, `node:test`-able) +
  `templates/.opencode/plugins/context-guard.ts` (thin hooks layer).
- Hooks available: `experimental.chat.system.transform` /
  `experimental.chat.messages.transform` (mid-session injection),
  `tool.execute.before` (block/mutate), `permission.ask` (doom_loop visibility),
  `event` (message/session events). `chat.message` fires only on new user
  messages — not usable for mid-run nudges.
- Requirements:
  - thresholds parsed from `.agents/memory/orchestration.md` (cache + invalidate
    on `file.watcher.updated`); never hardcode.
  - injected text **byte-stable within a band** (cache locality — ~97% of input
    tokens are cache reads).
  - primary sessions only (track child sessions from session events).
  - loop detector: build on the built-in `permission.doom_loop` (3 identical
    tool calls, default `ask`); exclude legitimate polling; inject the recovery
    rule (`change instructions/context/model/decomposition/diagnostics`).
  - **guard-event JSONL** (sessionID, threshold crossings, loop hits) so Phase B
    has data before full telemetry exists.
- Tests: core unit tests (band transitions, stable strings, threshold parsing,
  loop counter), plugin source-contract test, deploy test. Update
  `check-dispatch-config.js` only if needed.

## Later — Phase B (telemetry) + remaining D

- **B**: `scripts/qa/provider-stats.js` (resolve opencode DB/CLI cross-platform;
  `directory LIKE <root>%` so worktree sessions match) and
  `agent-report --cost --since=14d [--export fixture]` — totals, model mix,
  cache-read share, P50/P90, top-5 sessions, >60-turn count, loop candidates.
  No sqlite dependency (engines `>=18`); tests use a fixture export. Add
  `session: <id>` to handoff metadata + a `session_info` tool so
  cost-per-shipped-feature has a real join key.
- **D remaining**: R9 opportunistic tier (`big-pickle`, privacy caveat), R10
  escalation evidence, R11 scoped cache-prefix lint (prefix files only — avoids
  false positives), R12 `checkpoint` tool + `/resume` command, R13 doc truth
  pass (this doc included).

## Gotchas

- The version-bump test only enforces `bin/` + `templates/` changes; docs-only
  commits do not fail it. The repo workflow still bumps and deploys after every
  harness change.
- LibraryOS pre-push hook runs `test:governance` + `test:quick` (tsc,
  translations, generated client, tsx suites, backlog test) — both must be
  green before its push succeeds.
- `orchestration.md` and other `.agents/memory/*` files are project-owned
  (create-if-missing): edits to the templates only reach **new** projects;
  existing projects keep their copy.
