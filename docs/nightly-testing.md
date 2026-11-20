# Nightly E2E cycle

How the harness tests the day's landed code off-hours, and closes the loop on a
fix. The day loop lands features on **cheap gates**; the expensive device/Maestro
tier is deliberately not run during the day. `scripts/nightly.js` runs the full
battery overnight against a dedicated `nightly` worktree fast-forwarded to
`origin/main`, writes a report, and reconciles the backlog.

```
DAY    worktree → cheap gates → land on main → CI → UAT deploy
       (no emulator / Maestro unless the user explicitly asks)
NIGHT  local timer (device matrix)  +  cloud workflow (unit/API/routes/browser)
       → report → board reconciliation
MORNING `orient` shows the verdict; reopened + new rows are waiting
```

## Two halves

- **Local (heavy, host-bound)** — `scripts/nightly.js` on a systemd `--user`
  timer. Runs the Android device/Maestro matrix (it needs the local emulator +
  GPU), plus the project's tiers, in a `nightly` worktree. Install with
  `agent-harness install-nightly --target .` (or `bash scripts/setup-nightly.sh install`).
- **Cloud (host-independent)** — `.github/workflows/nightly.yml`: unit, DB/API,
  route, and browser tiers on a schedule. Fails loudly (the red run is the alert).

## Config — `.agents/nightly.json` (project-owned)

Seeded create-if-missing by `init`/`update`; never overwritten on deploy.

| Key | Meaning |
| --- | --- |
| `worktree` | nightly worktree path (default `<repo>/../.worktrees/<repo>/nightly`) |
| `seedCmd` | optional dev-DB seed run before the phases (development only) |
| `waitForQuietMin` | wait this long for live human sessions to end before starting |
| `stalePendingNights` | nights a `nightly:pending` row may stay unvalidated before it is flagged |
| `keepDays` | report retention under `.agents/qa-runs/nightly/` |
| `fileBacklog` | reconcile the board (`add`/`reopen`/`validate`); default `true` |
| `notify` | optional command run with the report path on completion |
| `phases[]` | ordered battery: `{name, kind, script|cmd, heavy, timeoutMin}` |

Phase `kind`s: `gate` (a package.json script; a missing one is **skipped**, never
failed), `cmd` (a shell command), `device-e2e` (the built-in
device-up → Maestro matrix → device-down sequence, included only when the tier is
present). `heavy` phases run capped through `serve.js run`.

## The bug lifecycle

A nightly failure and its fix move through the board as **one row**:

```
NIGHT N   journey J fails, no row exists
          → backlog add "[nightly:flow=J] J e2e failed"
DAY N+1   you fix J on the cheap gates (NO Maestro), finalize as usual
NIGHT N+1 reconcile (journey-level):
          J passes          → archive <id> --closed "nightly-validated <date> <report>"
          J still fails      → backlog reopen <id> --reason "nightly <date>: still failing"
          a different journey→ backlog add (a new row)
```

- The marker `[nightly:flow=<journey>]` lives in the **Task cell**, which every
  board section preserves, so the row stays on the radar through
  Open → In progress → Archive without any schema change.
- Matching is **journey-level**: one row per broken journey, reopened until
  green. A signature change on the same journey is recorded in the reopen reason
  but still reopens the same row (the fix was incomplete/regressed); a different
  journey's failure is a new row.
- **No Maestro during the day.** A device-only path is addressed in the QA plan
  as `audited: device tier deferred to nightly [nightly:flow=<journey>]` (a valid
  `audited:`/`waived:` reason). `finalize`/`ship` never demand the device tier.
- Repeated reopens escalate P2 → P1 (`[nightly:reopen=N]`); stale pending rows
  surface in `orient` and `agent-harness doctor`.

## Running and reading

```bash
npm run nightly -- run            # run the cycle now (foreground)
npm run nightly -- run --dry-run  # phase plan, no side effects
node scripts/nightly.js report    # last verdict + failures + board actions
node scripts/nightly.js status    # last run + rows awaiting validation

agent-harness install-nightly --target .          # install the timer (02:00)
agent-harness install-nightly --target . --time 01:30 --force
bash scripts/setup-nightly.sh status              # timer state + last report
bash scripts/setup-nightly.sh run-now             # run immediately
bash scripts/setup-nightly.sh uninstall
```

Artifacts: `.agents/qa-runs/nightly/<stamp>/report.json` + `report.md`, a
`latest.json` pointer, and `state.json` (reopen counts / first-seen). These are
local artifacts and are gitignored.

## WSL / host notes

- The timer needs the machine running. `Persistent=true` runs a missed cycle on
  the next boot; `install` enables `loginctl enable-linger` so the user timer
  fires without an open login session.
- A host without a `systemd --user` bus falls back to a crontab line (printed by
  `setup-nightly.sh install`).
- Nightly is the ideal time for heavy tiers: the capacity envelope
  (`.agents/memory/orchestration.md`) expects a free box, and the runner waits
  `waitForQuietMin` for live sessions before it starts.

## Related

- `docs/mobile-testing.md` — the device tier mechanics.
- `docs/ci-cd-pipeline.md` — the day-loop landing + deploy path.
