# Agent Harness Optimization — Implementation Status (v0.1.53)

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
| Version | `0.1.53` |
| Shipped this session | `0.1.53` — Phase C (context-guard plugin + core) |
| Lint / tests | green (`npm run lint`, `npm test` — 149/149) |
| LibraryOS | `0.1.53` deployed, committed, **pushed** (`origin/main`) |
| FamilyBudget | `0.1.53` deployed + committed locally (no remote configured) |

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

### `0.1.53` — Phase C: context-guard plugin (the 50/60/80 nudges + loop detector)
The thresholds were well-specified prose that nothing read. Now something does:
- **`templates/scripts/qa/context-guard-core.js`** (new) — pure, dependency-free
  CJS core so every rule is `node:test`-able:
  - parses the `orchestration.md` turn / request / stuck tables with documented
    defaults for missing rows (a hand-trimmed file still guards);
  - turn bands resolved **by threshold value** (descending), so a project can
    retune the numbers without breaking the ladder; `soft_turn_budget` is not a
    band itself (`compaction_target_turn` drives the checkpoint band);
  - **byte-stable injected text per band** — never interpolated with the turn
    count (a changing tail would break the ~97%-cache-read prefix);
  - cumulative identical tool+args counter with an order-independent key hash
    and a documented exemption list; first breach flagged once;
  - guard-event JSONL formatter.
- **`templates/.opencode/plugins/context-guard.ts`** (new) — thin hooks layer:
  - `event`: counts assistant turns per session (dedupe by message id), tracks
    child sessions from `session.created`/`session.updated` so only the primary
    orchestrator is nudged, invalidates the threshold cache on
    `file.watcher.updated` for `orchestration.md`, records `session.compacted`;
  - `tool.execute.before`: loop counts for primary sessions;
  - `experimental.chat.system.transform`: injects the band text and/or the loop
    recovery rule (deduped against the current system array so a persistent
    system prompt can never accumulate duplicates);
  - `permission.ask`: surfaces the built-in `doom_loop` decision and arms the
    recovery rule — it never overrides the permission.
- **Guard events** append to `.agents/guard-events.jsonl` (local-only, added to
  the harness-managed `.gitignore` section) — Phase B's data substrate.
- Wired: `package.json` lint check, README file table + bounded-orchestration
  section, `orchestration.md` "Machine-read thresholds" section, `00-operating.md`
  context-budget bullet.
- Tests: 7 core unit tests (parsing, retunable bands, byte-stability, turn
  counting/crossings, loop flagging, exemptions, JSONL), a plugin source-contract
  test (hooks present, no hardcoded thresholds), and a deploy test (both files
  ship, core stays harness-owned, guard log gitignored). Verified end-to-end
  locally by loading the real plugin with Node's TS type-stripping and driving
  synthetic session events.

## Decision log (changes to the recommendations doc)

- **R1 (Zen DeepSeek guard) dropped** — user does not use `opencode/deepseek-*`;
  not worth the guard right now.
- **Order changed** from the doc's suggestion to: cap shipped → **C (plugin)**
  → B (telemetry) → remaining D. Rationale: C's mechanisms are cheap and driven
  by already-measured waste; B is the biggest lift, and its baseline can be
  backfilled **retroactively** from the session DB, so C does not need to wait.
- **R2 soft claim (10–15%) stays unproven** — cap shipped first, measure before
  claiming. The plugin's job is 50/60/80 nudges, not the 100-block (the runtime
  cap already ends the turn). Discovered nuance while implementing: a hard band
  **nudge** at 100 is still injected for projects that override `steps`; it is
  not a mechanical block.
- **Request thresholds are telemetry only** — `observe/warn/checkpoint/intervene`
  request-token crossings are logged to the guard JSONL, not injected (the
  turn-band nudge is the actionable one; request-size injections would bloat).
- **Loop counting is cumulative, not consecutive** — the measured worst sessions
  ran the same tool 100–150× cumulatively; the runtime's own `doom_loop`
  (3 consecutive identical calls, `ask`) covers the immediate case and arms the
  same recovery rule.
- **`same_failure_turns` / `no_state_change_turns` stay advisory** — enforcing
  them requires polling worktree state (`git diff --quiet`) from the plugin,
  which is expensive and noisy; defer until Phase B data justifies it.
- **R8 deferred** — ~$0.2–0.7/2wk at current rates; splitting every SKILL.md
  into CORE/details invites drift.
- Keep `orchestration.md` project-owned and single-source; the plugin reads it.

## What's next — Phase B (telemetry) + remaining D

- **B**: `scripts/qa/provider-stats.js` (resolve opencode DB/CLI cross-platform;
  `directory LIKE <root>%` so worktree sessions match) and
  `agent-report --cost --since=14d [--export fixture]` — totals, model mix,
  cache-read share, P50/P90, top-5 sessions, >60-turn count, loop candidates.
  The guard JSONL now provides threshold/loop crossings without the DB. Add
  `session: <id>` to handoff metadata + a `session_info` tool so
  cost-per-shipped-feature has a real join key.
- **D remaining**: R9 opportunistic tier (`big-pickle`, privacy caveat), R10
  escalation evidence, R11 scoped cache-prefix lint (prefix files only — avoids
  false positives), R12 `checkpoint` tool + `/resume` command, R13 doc truth
  pass (this doc included), R14 scheduled review command (part of B).

## Gotchas

- The version-bump test only enforces `bin/` + `templates/` changes; docs-only
  commits do not fail it. The repo workflow still bumps and deploys after every
  harness change.
- LibraryOS pre-push hook runs `test:governance` + `test:quick` (tsc,
  translations, generated client, tsx suites, backlog test) — both must be
  green before its push succeeds.
- `orchestration.md` and other `.agents/memory/*` files are project-owned
  (create-if-missing): edits to the templates only reach **new** projects;
  existing projects keep their copy. The context-guard plugin reads whatever
  copy the project has and falls back to defaults for anything missing.
- The context-guard plugin is loaded by opencode from `.opencode/plugins/` and
  imports `../../scripts/qa/context-guard-core.js` — both paths must keep their
  relative layout when the harness adds future guard rules.
