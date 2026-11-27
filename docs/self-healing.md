# Self-healing loop (F-076, Phases 0–1)

The harness answers one bounded health question, builds a measured baseline, and
now turns a red signal into one deduped, classified, reproducible work item —
without repairing anything:

```sh
node scripts/heal.js status          # healthy? what is red / fixing / blocked
node scripts/heal.js watch --once    # detect & route red signals (one pass)
node scripts/heal.js watch           # resident loop (one pass every poll)
node scripts/heal.js run             # ingest KPIs + one detect pass
node scripts/heal.js report          # 14-day baseline, HHI, top burn driver
node scripts/heal.js plan            # the one permitted action per open signal
node scripts/heal.js pause|resume    # kill switch
```

## What exists now

- A local, append-only ledger under `.agents/qa-runs/heal/` in the main
  checkout (shared by worktrees). It stores KPI samples and repair items. A
  corrupt line is quarantined; retention never deletes the audit log.
- A pure decision core (`scripts/qa/heal-lib.js`, `scripts/qa/kpi-lib.js`) with
  policy validation, deterministic risk tiers T0–T3, eligibility budgets,
  breaker/error-budget freezes, the state machine, and the geometric-mean HHI.
- **Detect & route (Phase 1).** `watch` reads the configured sources (nightly
  report, gate ledger, doctor/drift), normalizes and dedupes by
  `(source, environment, signature)`, classifies the signal, selects one
  deterministic playbook or `escalate`, and writes a bounded reproduce-first
  prompt. A repeated observation updates the same item; it never adds a second.
- **One board row per signature.** The row carries a stable marker
  `[heal:<source>:<sig8>]`; a repeat links to it, and an archived signature is
  reopened rather than duplicated. `--no-board` keeps the loop ledger-only.
- `watch` is bounded: `--once` is one poll, `--max-polls` caps a resident run,
  and the kill switch is checked before every poll (a mid-run pause stops the
  loop).
- `observe` remains the default: no repair, no auto-land, no product-code write.
  `watch` works the same in `assist`/`auto` until Phase 2 adds the repair path.

## Policy

`.agents/heal.json` is project-owned: missing means `mode: off`; invalid JSON or
an unsafe value (for example `auto_merge_tiers` outside `auto_tiers`) refuses
with exit 2. `templates/.agents/heal.json` is the seeded default.

## What comes next

Phases 2–5 (bounded T0/T1 repair, deployed-repo mode, continuous improvement,
fleet governance) are tracked on the board. The loop keeps earning trust in
order: no repair, no auto-land, no telemetry before the evidence exists.
