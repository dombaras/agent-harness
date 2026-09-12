# Agent Harness — Cost & Context Optimization Recommendations

Date: 2026-09-12
Status: partially implemented — see
[`docs/optimization-implementation-status.md`](optimization-implementation-status.md)
for what shipped (R2 hard cap + R2/R3 context-guard plugin as of v0.1.53,
R4 telemetry via `agent-report --cost` + the `session_info` join key as of
v0.1.54, R5–R7) and the revised order (R1 dropped; C before B).
Scope: `agent-harness` (this repo, v0.1.47 at analysis time) and the personas/config it deploys.

## Basis

Derived from a 14-day opencode session analysis (2026-08-29 → 2026-09-12)
across the three active projects (PublicVirtualLibrary, agent-harness,
FamilyBudget) joined with the repo audit of v0.1.47. Key measured facts:

| Signal | Value |
|---|---|
| Sessions analyzed | 620 |
| Spend (14d, list rates) | $41.86 incl. the Aug 27–30 Zen experiment; ~$31.91 excluding it |
| Sessions > 60 steps | 101 (16% of sessions, 51.5% of spend) |
| Sessions > 100 steps | 42 (6.8%, 32% of spend) |
| Retry loops (identical tool+args >= 4x) | 23 sessions, $4.41 (10.5% of spend) |
| Compactions | 14 total (all in one project) |
| Cache-read share of input tokens | ~97% |
| Reasoning tokens billed as output | $8.01 (19.1% of spend) |
| One-time leak: Zen-served `deepseek-v4-pro` | 1.7% of tokens, 23.8% of 14d spend while active |

The harness's budgets exist and are well specified in
`templates/.agents/memory/orchestration.md` (lines 15-19: soft 60 / warning 50 /
compaction 60 / hard 100 / new-context 80; lines 36-41: fan-out bands; lines
49-51: stuck heuristics), but nothing reads them. Enforcement is prose; the
data shows it is not being followed. The recommendations below convert the
highest-value prose into mechanics, close the telemetry loop, and remove the
one routing footgun.

## P0 — Money leaks (do first)

### R1. Remove the `zen`/`opencode` aliases from the model-switch script

- **Change:** delete or repoint the `zen` and `opencode` aliases in
  `templates/scripts/switch-reasoning-model.ps1` (lines 18-19) — they map to
  `opencode/deepseek-v4-pro`, a 4-40x markup of the same model on DeepSeek
  direct. Add a hard guard: any target matching `opencode/deepseek-*` is refused
  with a message pointing at `deepseek/deepseek-v4-pro`.
- **Also:** extend `templates/scripts/qa/check-dispatch-config.js` (which
  already validates persona pins) to fail if any deployed persona or
  `opencode.json` references a Zen DeepSeek model.
- **Evidence:** during the Aug 27–30 experiment this route consumed 1.7% of
  tokens and 23.8% of the 2-week spend; same model on DeepSeek direct would
  have cost ~$1.4 instead of $9.95.
- **Expected impact:** prevents recurrence; historically ~$8.50 per 2 weeks.
- **Acceptance:** `npm run test:dispatch` fails on a Zen DeepSeek pin; script
  refuses the alias.

### R2. Make the turn budget mechanical — add a `context-guard` plugin

- **Change:** new `templates/.opencode/plugins/context-guard.ts`, patterned
  after `templates/.opencode/plugins/backlog-notify.ts`. Count assistant steps
  per session (session events; join `step-start` parts if needed) and act on
  the values already in `orchestration.md`:
  - 50: inject checkpoint warning;
  - 60: require checkpoint + recommend fresh bounded context;
  - 80: strongly prefer new context;
  - 100: block new dispatches until a checkpoint exists.
  Do not kill running tool calls (per `00-operating.md` checkpoint rules).
- **Evidence:** sessions > 60 steps hold 51.5% of spend; > 100 steps hold 32%.
  The soft budget is currently unenforced prose, and there is no main-agent
  `steps:` cap in opencode.
- **Expected impact:** the largest structural saving, est. 10-15% overall.
- **Acceptance:** unit tests simulate step counts and assert the injected
  reminder text; a live session crossing 60 steps emits the checkpoint
  instruction.

### R3. Loop/stuck detector in the same plugin

- **Change:** track `tool + hash(args)` occurrences per session and consecutive
  no-state-change turns (worktree `git diff --quiet`); use the thresholds
  already defined in `orchestration.md` (lines 49-51: 3 / 3 / 4). On breach,
  inject the rule from `00-operating.md:32`: change instructions / context /
  model / decomposition / diagnostics, or report.
- **Evidence:** 23 sessions with identical tool+args >= 4x cost $4.41 (10.5%);
  worst sessions ran the same tool 100-150x.
- **Expected impact:** recover roughly half; ~5% of run-rate.
- **Acceptance:** detector fires on a seeded repeated-call fixture; thresholds
  read from the memory file, not hardcoded.

### R4. Close the telemetry loop — feed real cost/tokens into `agent-report.js`

- **Change:** keep the "never fabricate token/cost" invariant
  (`templates/scripts/agent-report.js:14-15, 321-326`) and instead read provider
  data: opencode session DB or `opencode export --sanitize` JSON. Join per
  session to the dispatch log. Add: cost, input/output/cache-read/reasoning
  tokens, cache-read share, turns at completion, **cost per shipped feature**,
  P50/P90 task cost, top-5 expensive sessions, sessions > 60 turns.
- **Evidence:** Phase 2/15 of `Outside advise/Implementation Plan` is
  unimplemented; without this, every optimization below is unverifiable and
  the plan's primary KPI (cost per successfully completed feature) cannot be
  computed.
- **Expected impact:** enables all future measurement; no direct saving.
- **Acceptance:** `npm run report -- --cost --since=14d` prints real numbers on
  this machine; tests use a small fixture export.

## P1 — Correctness and context quality

### R5. Fix the qa-runner evidence-vs-brevity contradiction

- **Change:** in `templates/.opencode/agents/qa-runner.md` (lines 14-15) and
  `templates/.agents/skills/qa-runner/SKILL.md`, move verbatim logs to
  `.agents/qa-runs/<id>/evidence.txt` and return path + hash in the final
  message. Keep the <= 15-line contract: commands, exit codes, pass/fail per
  suite, artifact path.
- **Evidence:** the current contract demands full commands and verbatim failure
  detail while capping the message at ~15 lines — either the cap breaks or the
  evidence is truncated, and verbose failure output is exactly what bloats main
  context.
- **Acceptance:** template + skill agree; no evidence requirement removed, only
  relocated.

### R6. Bound `backlog_list`

- **Change:** `templates/.opencode/tools/backlog.ts:31` hardcodes `--full`.
  Add `--limit` (default ~40) and return status counts + newest N, truncating
  like the human CLI (`templates/scripts/backlog.js:401-413`). Make `/board`
  use the bounded path.
- **Evidence:** every dispatch and board echo currently dumps the whole board;
  cost grows monotonically with backlog size.
- **Acceptance:** tool output is bounded on a large board fixture; counts remain
  accurate.

### R7. Reconcile Step Zero with the dispatch-value gate

- **Change:** make the complexity threshold primary; require the planner to
  emit `execution_mode: direct` or a `dispatch_justification` when fan-out
  exceeds the bands in `orchestration.md:36-41`; have
  `templates/scripts/qa/governance.js` check for the field.
- **Evidence:** `00-operating.md:7` ("dispatch before reading/editing") conflicts
  with `:27-29` and `AGENTS.md:106-107`; 84% of sessions dispatch nothing, but
  small tasks still flow through planning.
- **Acceptance:** governance gate fails a session log with unjustified
  fan-out > 4.

### R8. Deduplicate per-dispatch persona loading

- **Change:** split each `.agents/skills/*/SKILL.md` into an always-injected
  `CORE` block (scope, output contract, stop conditions) and a details section
  read on demand; stop instructing every dispatch to "read the complete
  persona instructions" when the orchestrator can pass CORE inline.
- **Evidence:** 443 dispatches in 14 days, each reloading 0.8-2.3k words
  (`qa-architect` ~2,264, `features` ~1,653, `product-manager` ~1,125).
  Negligible at DeepSeek cache prices, material on any premium model.
- **Acceptance:** persona output contracts unchanged; measured per-dispatch
  instruction bytes drop; `check-dispatch-config.js` still passes.

## P2 — Routing policy and hygiene

### R9. Add an `opportunistic` tier to `model-routing.md`

- **Change:** document a tier for free/low-cost models (big-pickle,
  nemotron-3-ultra-free, muse contributor) for explore/summarize/mechanical
  work, with mandatory fallback on failure and a "no confidential data on
  training-enabled free models" caveat.
- **Evidence:** big-pickle already absorbed 8M tokens across 34 sessions at $0
  with no recorded failures; it is an unused formal lever.
- **Acceptance:** tier documented; at least one persona (e.g. `explore`) may
  legally pin to it.

### R10. Enforce escalation evidence

- **Change:** add `model_escalation_evidence` to the handoff dispatch-log
  schema (`templates/.agents/handoffs/README.md:36-46`); report/QA flag
  sessions where a pro-tier model ran without a recorded reason from the
  evidence-based escalation list (`AGENTS.md:111`).
- **Evidence:** 137 sessions ran DeepSeek v4-pro directly in 14 days; many are
  justified, but today it is unobservable which were not.
- **Acceptance:** report shows pro sessions with/without escalation reasons.

### R11. Make cache-friendly prefixes testable

- **Change:** add a QA check that the always-loaded prefix (`AGENTS.md`,
  `00-operating.md`, memory files, session-start read order per
  `00-operating.md:98`) is byte-stable: no timestamps, per-run content, or
  non-deterministic ordering.
- **Evidence:** ~97% of tokens are cache reads; a broken prefix multiplies cost
  on any provider, and the current cache-locality rule
  (`orchestration.md:59-61`) is unverifiable.
- **Acceptance:** check fails when a dynamic value is added to a prefix file.

### R12. Checkpoint/resume automation

- **Change:** add a `checkpoint` command/tool that writes the deterministic
  state block already specified at `00-operating.md:48-53`, plus a resume flow
  that opens a fresh session and reads only the checkpoint file.
- **Evidence:** 14 compactions in 14 days; no checkpoint reader or automatic
  trigger exists, so the "fresh bounded context" half of the policy is manual.
- **Acceptance:** resume produces a bounded context from checkpoint alone.

### R13. Update stale docs and status

- **Change:** refresh `docs/optimization-implementation-status.md` and
  `README.md:117-128` to state what is now mechanically enforced (per R2/R3),
  that the main-agent `steps:` cap remains an open platform limitation, and
  that cost telemetry exists (R4). Document which `orchestration.md` values are
  machine-read vs advisory.
- **Acceptance:** status doc matches reality; no contradictory guidance.

### R14. Add a scheduled review command

- **Change:** `npm run report -- --since=14d --cost` producing top-5 expensive
  sessions, sessions > 60 turns, loop detections, cost per shipped feature,
  model mix by tier. Recommend running it monthly.
- **Evidence:** this analysis required manual DB spelunking; R4 makes it one
  command.
- **Acceptance:** command runs in CI or manually with a stable schema.

## Expected outcome

| Lever | Est. 2-week saving |
|---|---|
| R1 alias guard | ~$8.50 avoided (historical leak) |
| R2 turn budget enforcement | ~$3-4 |
| R3 loop detection | ~$2 |
| R8/R9/R10 routing hygiene | ~$1-2 |
| **Total** | **~15-25% of run-rate, no quality change** |

Reasoning-token share (19.1%) is noted but not targeted here: it is a model
behavior, not a harness defect; the existing tiering policy plus R10 is the
right control.

## Suggested implementation order

1. R1 (tiny, prevents a large loss)
2. R2 + R3 (one PR: guards plugin + tests)
3. R4 (telemetry — unlocks verification of everything else)
4. R5 + R6 (context hygiene)
5. R7, R9-R14 (policy, checks, docs)

## Assumptions and limits

- The harness is a template/deploy package and cannot change opencode runtime
  internals; no hard main-agent step cap and no per-call accounting exist
  inside the runtime. R2/R3 use plugin-visible events; R4 reads provider data.
- Savings estimates use opencode list-rate costs for the 2026-08-29 → 09-12
  window; actual invoices may differ.
- `orchestration.md` stays project-owned and remains the single source of
  truth; the plugin should read it, not duplicate its numbers.
