# Self-healing loop (F-076, Phase 0)

The harness can now answer one bounded health question and build a measured
baseline without repairing anything:

```sh
node scripts/heal.js status          # healthy? what is red / fixing / blocked
node scripts/heal.js run             # ingest KPI samples (observe mode)
node scripts/heal.js report          # 14-day baseline, HHI, top burn driver
node scripts/heal.js pause|resume    # kill switch
```

## What exists now (Phase 0)

- A local, append-only ledger under `.agents/qa-runs/heal/` in the main
  checkout (shared by worktrees). It stores KPI samples and, in later phases,
  repair items. A corrupt line is quarantined; retention never deletes the audit
  log.
- A pure decision core (`scripts/qa/heal-lib.js`, `scripts/qa/kpi-lib.js`) with
  policy validation, deterministic risk tiers T0–T3, eligibility budgets,
  breaker/error-budget freezes, the state machine, and the geometric-mean HHI.
- `observe` is the default and writes no product code, no board row, and no
  repair item. T2/T3 paths can never be in `risk.auto_tiers`.
- `watch` (Phase 1) and `improve` (Phase 4) refuse with exit 2 rather than
  silently doing nothing.

## Policy

`.agents/heal.json` is project-owned: missing means `mode: off`; invalid JSON or
an unsafe value (for example `auto_merge_tiers` outside `auto_tiers`) refuses
with exit 2. `templates/.agents/heal.json` is the seeded default.

## What comes next

Phases 1–5 (detect & route, bounded repair, deployed-repo mode, continuous
improvement, fleet governance) are tracked on the board. Phase 0 deliberately
earns trust first: no repair, no auto-land, no telemetry.
