# Agent Harness Optimization — Implementation Status (v0.1.62)

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
| Version | `0.1.62` |
| Shipped this session | `0.1.57` provider funds stop + Go-first routing; `0.1.58` upstreams LibraryOS's local `backlog unqueue`; `0.1.59` persona model re-tuning; `0.1.60` architect tier → direct DeepSeek; `0.1.61` funds guard names the failed provider/model + Zen removed from routing; `0.1.62` funds guard arms on structured failures only (doc-read false positive fixed) |
| Lint / tests | green (`npm run lint`, `npm test` — 168 pass) |
| LibraryOS | `0.1.62` deployed + pushed (harness auto-commit `443af25`); `model-routing.md` is gitignored/local-only and was updated in place; F-169 (the false-stop victim) itself shipped/archived in-session (`9d45b04`) |
| FamilyBudget | `0.1.62` deployed (local repo, no remote); routing doc update `8aee12d` |

---

## What shipped

### `0.1.64` — WSL environment hardening

Not a cost item, but recorded for continuity: with WSL2 as the primary
environment, close the Windows↔Linux boundary gaps found in review.

- **`test:prefix` now catches WSL machine paths.** The machine-specific-path
  pattern (`templates/scripts/qa/check-prefix-stability.js`) additionally flags
  `/mnt/<drive>/` mounts and `\\wsl.localhost\` / `\\wsl$\` UNC paths, so a
  per-machine path that leaks into an always-loaded file fails the gate instead
  of silently breaking prompt-cache locality. `locations.md` keeps its
  machine-path exemption.
- **LF policy across the boundary.** New repo-root `.gitattributes` pins `*.sh`
  to LF and `*.ps1` to CRLF; `mergeGitattributes` merges the same `*.sh`/`*.ps1`
  rules into each deployed project's managed section, so a Windows-side
  checkout/commit can no longer CRLF `switch-reasoning-model.sh` (which then
  fails under `bash` with `bad interpreter: ...\r`).
- **POSIX/PowerShell switch-script parity.** A test locks the `.sh` alias map,
  its find list, and the `.ps1` alias map together, and the README alias list is
  corrected (stale `zen`/`opencode`/`pickle` entries dropped).
- **`/mnt/` deploy warning.** `deploy`/`update` warns when the target is a
  Windows drive mount (slow 9p/virtio-fs I/O) and points at `~/develop`.
- **WSL runbook** in the repo `AGENTS.md` (ext4 vs `/mnt`, line endings,
  external-directory allowlist, SSH) and a README "Running on WSL2" section.
- Tests: extended the `test:prefix` and `.gitattributes` deploy tests; added a
  `isWindowsMount` unit test and the switch-script parity test.

### `0.1.62` — funds guard arms on structured failures only (doc-read false positive)

Driven by LibraryOS F-169: the picked-up row never started because the guard
paused the session on the **session-start read of `model-routing.md` itself** —
that file documents the funds rule with its literal trigger phrases
(`insufficient balance`, `insufficient funds`, `out of credits`, `usage limit
reached`, HTTP 402), and `tool.execute.after` scanned the text of every
successful tool result. Verified from `opencode.log` (`provider funds/quota
error from read — pausing for top-up`) and the session transcript; no provider
call had failed (the "unknown provider/model" was the give-away — a `read` has
no model metadata). Handoffs/plans/rulebooks that quote the rule, and the
guard's own source, re-armed it on every read/grep, so the stop recurred every
session.

- **`context-guard-core.js` gains `fundsArmText(tool, output)`** — the only
  text eligible for the funds scan. Structured failure evidence only:
  `output.error` (a failed dispatch's `Subagent failed (...): Insufficient
  balance` carries the failed model in `metadata.model`; any thrown tool error),
  or a `bash` result with a non-zero `metadata.exit`. Successful reads, greps,
  globs, dispatches, and commands are context, never evidence.
- **Plugin `tool.execute.after` uses the gate**; `logEvent` no longer swallows
  a guard-log write failure silently — it reports it (the LibraryOS
  `guard-events.jsonl` was absent while detections were firing, turning a real
  detection into an unattributable one).
- **Docs**: README + `templates/.agents/memory/model-routing.md` now state the
  structured-evidence rule and that reading a document quoting it never trips
  the stop; both project copies were updated in place (LibraryOS ignored
  local-only; FamilyBudget tracked).
- **Tests**: regression pins the exact F-169 input (model-routing.md text via
  `read`/`grep`/successful `bash`/successful `task` → no arm) and the true
  positives (real failed-dispatch shape, failed-bash output, structured
  `output.error`) — 168 pass.

### `0.1.61` — funds guard names the failing provider/model; Zen removed from routing

Two corrections from the F-166 pause (a Zen funds error the guard reported
without naming the provider):

- **Funds stop now attributes the failure.** `context-guard-core.js` gains
  `fundsText(label, where)` and `modelLabel(info)`: the injected stop names the
  observed `provider/model` (e.g. `opencode/gpt-5.6-luna`). The plugin tracks
  child→parent sessions so a **subagent** funds error arms the orchestrator's
  stop, and reads the failed dispatch's model from the task result's
  `metadata.model` (or the child assistant message's `providerID/modelID`).
  `.agents/guard-events.jsonl` funds events now carry
  `provider`/`model`/`failedSessionID`. With nothing known the generic text is
  byte-identical to the old rule.
- **Zen pay-as-you-go (`opencode/*`) is out of the policy** — OpenCode Go +
  DeepSeek direct only. Removed: the `explore` pin (`opencode/big-pickle` →
  `opencode-go/glm-5.3-flash`), the opportunistic targets
  (big-pickle/nemotron/muse → Go glm-flash), the escalation
  `opencode/gpt-5.6-sol`, the `zen`/`opencode`/`big-pickle` switch aliases, and
  every Zen line from `models.allowlist.txt`. `check-dispatch-config.js` now
  **fails** if the allowlist carries an `opencode/*` (Zen) line, so a
  regenerated allowlist cannot silently re-allow it.
- **Why the pause happened:** the failing `opencode/gpt-5.6-luna` dispatches
  predate the `0.1.57` Go-first deploy (all persona pins moved to
  `opencode-go/*` then); the only Zen left after that was `explore` and the
  machine-read/alias lists — all removed now. The `explore` pin is a
  project-owned `opencode.json` override, so the updater preserves it and it
  was re-pinned in place in both projects.
- **Deployed:** both projects on `0.1.61`; both `model-routing.md` policies
  synced; `test:dispatch` green on both (15 agents, 0 failures).

### `0.1.60` — architect tier runs direct DeepSeek (correction to 0.1.59)

User correction to the `0.1.59` re-tuning: **V4 Pro always uses the direct
DeepSeek API key**, not the OpenCode Go subscription.

- **All four V4 Pro pins → `deepseek/deepseek-v4-pro` direct** (`planner`,
  `qa-architect`, plus the pre-existing `system-architect`,
  `security-engineer`). This reverses the 0.1.57 migration for Pro only — the
  Go subscription carries the flash/content/mechanical tiers.
- **Why V4 Pro (not V4.1):** the provider catalog has no V4.1 Pro — V4.1 only
  exists as `deepseek-v4.1-flash` (Go), the engineering/coding tier. V4 Pro is
  the strongest reasoning model available, so the architect tier stays there
  until a V4.1 Pro-class model appears.
- **Policy docs updated:** `.agents/memory/model-routing.md` provider section
  (Go for flash/default, direct for V4 Pro; `escalation_models:` now
  `deepseek/deepseek-v4-pro, opencode/gpt-5.6-sol`; `fallback_models:` now the
  direct flash pair), `AGENTS.md`, `.agents/AGENTS.md`,
  `.agents/rules/00-operating.md`, `README.md`, `switch-model.md`.
- **Regression test:** architect-tier pins must be `deepseek/deepseek-v4-pro`
  and engineering pins `opencode-go/deepseek-v4.1-flash` (never Go Pro).
- `test:dispatch` green (the removed `opencode-go/deepseek-v4-pro` pin is no
  longer referenced by any routing doc).
- **Deployed** to both projects: the 4 V4 Pro agent pins + policy docs
  (`AGENTS.md`, `.agents/AGENTS.md`, `.agents/rules/00-operating.md`,
  `switch-model.md`) auto-committed (LibraryOS pushed). Routing docs updated in
  place: FamilyBudget's `model-routing.md` committed; LibraryOS's is
  gitignored/local-only and was updated in the working tree (not committed by
  the project's own design).

### `0.1.59` — persona model re-tuning (architect-tier plan/review, cheap engineering)

External review recommendation applied through the harness's own routing policy:

- **Plan/review moves to the architect tier.** `planner` and `qa-architect` →
  `opencode-go/deepseek-v4-pro` (same tier as `system-architect` /
  `security-engineer`): a planner/QA logic error invalidates the whole dispatch
  plan, so both are priced as architects rather than coders.
- **Engineering moves to the cheap frontier coder.** `frontend-engineer`,
  `mobile-engineer`, `data-engineer`, `devops-engineer`, `qa-runner` →
  `opencode-go/deepseek-v4.1-flash` (matching the already-flash
  `diagnostics-expert` and the main default) — cheaper, better cache pricing,
  and stronger on coding benchmarks than Luna.
- **Content stays on the strong generalist.** `ui-designer`, `docs`, `features`,
  `product-manager` keep `opencode-go/gpt-5.6-luna` (general text, layout,
  documentation). `product-manager` was not named in the recommendation; it was
  left unchanged rather than guessed onto the pro tier.
- **Unchanged already-correct tiers:** `system-architect` / `security-engineer`
  stay `opencode-go/deepseek-v4-pro`, `handoff` stays `opencode-go/glm-5.3-flash`.
- `.agents/memory/model-routing.md` tier table/policy updated to the new lanes
  (strongest reasoning = hard reasoning + plan/review; fast frontier = debug +
  engineering; content = strong generalist). No tooling change needed —
  `/switch-model` + `switch-reasoning-model.ps1` already rewrote exactly those
  six reasoning-tier agents.
- Tests: harness suite green; `test:dispatch` re-validates pins vs the provider
  allowlist and doc↔config drift.
- **Deployed** to both projects: updates auto-committed the 7 re-pinned agent
  files (LibraryOS pushed; FamilyBudget local-only). FamilyBudget's
  project-owned `model-routing.md` tier section was synced to the new lanes
  (committed there); LibraryOS keeps its deliberately simplified tier table —
  the concrete `model:` pins are authoritative, so nothing contradicts.

### `0.1.58` — upstream the project-local `backlog unqueue` (ownership fix)

LibraryOS's F-157 committed an `unqueue` command directly into the harness-owned
`scripts/backlog.js` (Queued → Open for re-triage, with project tests). The
`0.1.57` update correctly overwrote the harness-owned file and broke the
project's pre-push `test:quick` (`unqueue` unknown). Rather than restore a
project-local edit that every future update would clobber, the feature is now
upstreamed: `templates/scripts/backlog.js` gains `cmdUnqueue` (+ usage/help,
`formatResult`, dispatch, export) and the harness suite gains the three
behavior tests (Queued → Open priority-sorted with cells preserved; already-Open
no-op; non-Queued refusal).

### `0.1.57` — provider funds stop + OpenCode Go-first routing (field fix)

Driven by the LibraryOS F-154/F-159/F-161 pattern: subagent dispatches failed
with the provider's "Insufficient balance", the orchestrator degraded every
persona inline per the old ladder, the main turn blew the 100-step cap, and
sessions ended with "remaining: commit/push/deploy" instead of a shipped close.

- **Funds stop (policy + mechanical).** `.agents/memory/model-routing.md` gains a
  "Provider funds stop" hard rule — stop, announce the failed provider/model and
  the exact unfinished step, checkpoint, wait for the user's explicit
  top-up-complete message, resume from the checkpoint — which precedes the
  dispatch-failure ladder. `00-operating.md`, `.agents/AGENTS.md` §5, and the
  root `AGENTS.md` carry the same rule. The `context-guard` core detects
  funds/quota error text (balance/funds/credits/usage-limit/402 — deliberately
  not transient rate limits); the plugin arms a hard-stop injection from
  `tool.execute.after` (dispatch results) and `session.error`, released by the
  user's next message.
- **Go-first routing.** `opencode.json` default is now
  `opencode-go/deepseek-v4.1-flash` (`small_model` →
  `opencode-go/glm-5.3-flash`); every persona pin moves to its `opencode-go/*`
  equivalent (`opencode-go/gpt-5.6-luna`, `opencode-go/deepseek-v4-pro`,
  `opencode-go/deepseek-v4.1-flash`), and `deepseek/*` direct is the declared
  `fallback_models:` target — every fallback is announced immediately.
- **Gates + tooling.** `test:dispatch` now accepts declared
  `fallback_models:` targets; the Go catalog is in the allowlist; the
  `/switch-model` command and `switch-reasoning-model.ps1` gain
  `go`/`go-flash`/`go-pro` aliases alongside the direct aliases.
- Tests: funds detection + plugin source contract, rules/policy content,
  model-routing/config assertions (164 total, green).

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

### `0.1.54` — Phase B: provider telemetry + the session join key (R4)
The loop is closed: observed cost/tokens/turns now join to features, and
`cost per shipped feature` is a real, deterministic number.
- **`templates/scripts/qa/provider-stats.js`** (new, pure core + CLI) — reads the
  local opencode store through `opencode db --format json "<SQL>"` (no sqlite
  dependency; the CLI is located cross-platform, resolving past the Windows
  `.cmd`/`.ps1`/extensionless shims). Scoping is **worktree-aware**: the project
  is resolved through `project_directory` (which registers every
  `git_worktree` opencode has seen) plus `project.worktree`, so sessions started
  in `<repo>/../.worktrees/<repo>/<id>` match. It maps every session
  (`parent_id`, model/provider from the JSON cell, cost, input/output/
  reasoning/cache-read/cache-write tokens, assistant turns), **groups a primary
  session with its subagent child sessions** (the parent's `cost` column does
  NOT include children — measured), and detects cumulative identical tool+args
  calls with the same canonical key/exemptions as the live guard.
- **Aggregates** (pure function, exported for tests): totals, model mix,
  cache-read share of input tokens, P50/P90 cost + turns per primary session,
  top-5 primary sessions by cost, sessions over the `soft_turn_budget`, and
  loop candidates at the `identical_tool_calls` threshold — all read from
  `.agents/memory/orchestration.md` at run time (no hardcoded thresholds).
- **Fixtures**: `--export <file>` writes a `provider-stats/1` snapshot
  (`{schema, meta, sessions}`) and `--fixture <file>` reads one, so reports and
  tests run offline and deterministic.
- **`agent-report --cost --since=14d [--export <file>] [--fixture <file>]`** —
  joins each handoff's `## Session metadata` `session:` id to its provider
  group and prints cost per feature, cost per shipped feature (shipped/resolved
  outcomes), matched/unmatched counts, and provider totals. Without `--cost`
  the report is byte-for-byte the old deterministic dispatch report (no store
  access). `--json` carries the whole `provider` block.
- **`.opencode/tools/session.ts`** (new `session_info` tool) — returns the
  primary orchestrator session id (the handoff join key; walks the parent chain
  so a subagent call still reports the primary) plus observed cost/tokens/turns.
  It never fabricates: an unreachable store reports `unavailable` and still
  returns the id.
- **Handoff integration**: `session:` added to the `## Session metadata`
  template (handoffs README + handoff skill + rulebook §8 + the root summary
  bullet), with the `session_info` step in the skill procedure.
- **Field fix (latent)**: `agent-report`'s section parser required a heading to
  end after the section name, so the template headings that carry a qualifier
  (`## Session metadata (structured — …)`, `## Retries (only when …)`) never
  parsed. The parser now accepts a trailing qualifier; the new test writes the
  suffixed heading.
- `session_info` is added to the context-guard loop-exemption list (glue call).
- Tests: 4 provider-stats unit tests (since/model/percentile parsing; Windows
  shim resolution; group/cache-share/percentile/loop aggregation; worktree-aware
  collection + canonical loop keys with only hashes retained), a CLI
  fixture/export round-trip + loud-failure test, an `agent-report --cost` join
  test (subagent cost included, cost per shipped feature, `--export`), and a
  `session_info` source-contract + deploy/ownership test.

### `0.1.56` — remaining D: routing hygiene + context lifecycle mechanics (R9, R10, R11, R12, R14)
- **R9 — opportunistic tier.** `.agents/memory/model-routing.md` now documents
  the free/low-cost lane (best-effort bulk exploration/summarization only,
  mandatory fallback to the persona's normal tier, no-authoritative-output rule,
  and the no-confidential-data caveat) with a machine-readable
  `opportunistic_models:` line. The built-in `explore` agent is the reference
  pin: `opencode.json` → `agent.explore.model` (default `opencode/big-pickle`,
  ADD-ONLY merged — a project override always wins). `test:dispatch` now also
  validates every `agent.<name>.model` pin and accepts declared
  `opportunistic_models:` / `escalation_models:` targets as legal (a declared
  target without a pin is no longer reported as doc↔config drift).
- **R10 — escalation evidence.** The handoff `## Session metadata` schema gains
  `model_escalation_evidence:` (the reason, or `none`). `provider-stats`
  classifies the observed model mix by tier (`modelMix[].tier`, `tierMix`, the
  `escalation` primary-session list, opportunistic usage), reading the
  `escalation_models:` line from `model-routing.md` at run time; `agent-report
  --cost` flags a primary session observed on a pro model with no recorded
  reason (metadata line or `## Escalations` bullet). `--json` now pins
  `schema: agent-report/1`.
- **R11 — cache-prefix lint.** `test:prefix`
  (`scripts/qa/check-prefix-stability.js`) fails a clock timestamp, a
  machine-specific absolute path, or a session id in the always-loaded prefix
  (root `AGENTS.md`, the rulebook, `00-operating.md`, and the session-start
  memory reads). Bare historical dates stay legal; `BACKLOG.md`, handoffs,
  feature docs, and other memory files are out of scope — scoped to avoid false
  positives.
- **R12 — checkpoint/resume mechanics.** `scripts/checkpoint.js` writes/replaces
  the deterministic bounded-state block in `.agents/handoffs/<id>.md` (no
  timestamps, `unknown` for anything not recorded, identical rewrite is a no-op,
  changed state increments `checkpoint_count`, one block per file). The
  `checkpoint_write` / `checkpoint_resume` tools plus `/checkpoint` and
  `/resume` commands make the "fresh bounded context that reads the checkpoint"
  half of the policy mechanical; resume prints the block alone, never the
  transcript.
- **R14 — scheduled review.** `npm run report:cost`
  (`agent-report --cost --since=14d`) is documented as the monthly review in the
  `/report` command (top primary sessions by cost, >soft-budget turns, loop
  candidates, cost per shipped feature, model mix by tier, escalation-evidence
  flag); the `agent-report/1` JSON schema is pinned for stable consumption.
- Tests: model-routing content contract, `test:dispatch` declared-target vs
  stray-model behavior, provider-stats tier classification, `agent-report --cost`
  escalation flag (with/without evidence), `test:prefix` clean/volatile/date
  cases, checkpoint round-trip/idempotency/replace/loud-failure, and a
  deploy/ownership test for the new script + tools + commands + scripts.

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
- **Provider data source: `opencode db --format json`** — version-stable (per the
  session-fetch skill) and dependency-free; direct sqlite would need `node:sqlite`
  (Node 22.5+, engines say >=18) or a sqlite3 binary.
- **A feature run = primary session + descendant sessions.** Measured on real
  data: the parent's `cost` column excludes child sessions (parent $0.235 vs
  children $0.343 in F-019), so `session:` stores the primary id and both
  reports sum descendants.
- **`--since` filters on session `time_created`** — a run that started before the
  window and continued inside it is excluded (matching the original analysis
  shape); boundary distortion is documented, not hidden.
- **Loop candidates use the project's `identical_tool_calls`** (default 3) rather
  than the analysis' >=4x filter; the reported `count` makes the deeper loops
  distinguishable.
- **Incentive check**: `session: <id>` is recorded by the session that did the
  work, so the join is close to complete for new handoffs; historical handoffs
  without it are reported as unmatched, never imputed.

## What's next — measurement only

- **Measurement (start now)**: run `npm run report:cost` monthly (a 2-week window
  is the minimum before drawing conclusions). R2/R3 can be judged on
  post-`0.1.53` data; R9/R10 on post-`0.1.56` data (opportunistic usage and
  recorded escalation evidence). Use `--export` to snapshot each window and
  compare.
- **All remaining D items shipped** (R9, R10, R11, R12, R14 in `0.1.56`).
  R13 (doc truth) is refreshed by this doc + README; re-check after the next
  change to the guard thresholds.
- **Watchlist**: R2's 10–15% soft claim stays unproven until measured; R8
  (per-dispatch persona dedup) remains deferred; R1 stays dropped.

## Gotchas

- `model-routing.md` is project-owned (create-if-missing): existing deployments
  keep their copy, so the new `opportunistic_models:` / `escalation_models:`
  lines (and the R9/R10 tier classification + escalation flag in `report --cost`)
  only appear in projects that refresh that file. The `explore` opportunistic pin
  itself still arrives everywhere through the ADD-ONLY `opencode.json` merge.
- `test:prefix` treats machine paths as legal in `.agents/memory/locations.md`
  (the locations map exists to record them) but flags them in the other prefix
  files; clock timestamps and session ids are flagged everywhere.

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
- `provider-stats.js` reads the **local** opencode store. On a machine without
  opencode (CI), `agent-report --cost` fails loudly by design — use
  `--cost --fixture <snapshot>` for offline/deterministic runs.
- Windows: `where.exe opencode` lists the extensionless POSIX shim first; the
  resolver prefers the sibling `.exe` / npm-global `opencode-ai` exe, and
  `OPENCODE_BIN` overrides everything.
- Only sessions whose directory opencode registered for the project match
  (main worktree + `git_worktree` rows in `project_directory`). A session started
  from an unregistered directory will not appear — the script reports the
  resolved project ids in `meta.projectIds` so that is visible, not silent.
