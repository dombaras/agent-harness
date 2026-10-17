# Round-3 gaps — implementation pickup plan

**For a fresh session.** This file is self-contained: it tells you what to build,
in what order, with exact files, acceptance criteria, and the release steps. It
comes from the 2026-10-16 round-3 field review
([`harness-field-review-2026-10-16-round3.md`](harness-field-review-2026-10-16-round3.md));
the board rows are `H-44`…`H-49` in [`open-work.md`](open-work.md). Read those
two files first if you want the evidence; you do not need them to execute.

> **Do not use the `checkpoint_write` tool in this repo until T1 is fixed.** The
> dogfood makes it write into `templates/.agents/handoffs/` (a shipped tree).
> Write handoffs with the `write` tool to `.agents/handoffs/<id>.md` instead.

## State when this plan was written (2026-10-16 late / 2026-10-17)

- Harness `main` = **0.1.165** (`ddd8b3d`, the round-3 docs commit).
- LibraryOS `~/develop/PublicVirtualLibrary` is deployed at **0.1.165**; its
  **live opencode process is stale** (started before the 0.1.164/0.1.165 land).
- The harness source checkout is **dogfooded** (`.opencode/*` → `templates/*`,
  `scripts` → `templates/scripts`, `opencode.json` = template, `.harness-dogfood`
  marker). A session here gets the guard + harness tools.
- `report:recon` reads the **V2** store correctly on both roots (F-15 fixed).
- Last nightly run predates the fixes; the nightly timer fires daily ~02:00 IDT.

## How to verify the baseline before you start

```bash
cd ~/develop/agent-harness
npm run lint && npm test            # must be green before and after
node scripts/qa/session-recon.js --root ~/develop/agent-harness --since=14d
node scripts/qa/session-recon.js --root ~/develop/PublicVirtualLibrary --since=14d
ps -eo pid,lstart,etime,cmd | grep -i opencode | grep -v grep
```

---

# Build tasks (ordered)

## T1 — Fix the `checkpoint_write` template-tree bug  (`H-49`, P2)

**Why:** under the dogfood, a checkpoint created
`templates/.agents/handoffs/<feature>.md` — a file `update` would ship into every
project (the H-14/F-14 stray-handoff class, now template-wide).

**Cause:** `templates/scripts/checkpoint.js:29` —
`const root = path.resolve(__dirname, "..")`. The dogfood symlinks repo `scripts`
→ `templates/scripts`; Node **realpaths** the script, so `__dirname` is
`.../templates/scripts` and `root` becomes `.../templates`.

**Fix:**
1. In `templates/scripts/checkpoint.js`, resolve the root from an explicit
   `--root <dir>` when given, else `process.cwd()` (the plugin already spawns it
   with `cwd = session directory` — see
   `templates/.opencode/plugins/checkpoint.ts:46-48` and
   `templates/scripts/qa/tool-lib.js` `sessionRoot()`). Keep `__dirname` only as
   a last-resort fallback.
2. Audit the same pattern in every deployed script (`grep -rn "__dirname" templates/scripts/`)
   — fix anything else that derives the project root that way.
3. Add a drift guard test: a script that resolves its root via `__dirname` fails
   the test suite (or assert `checkpoint.handoffPath` honours `cwd`).
4. Optional but cheap: make `update` refuse to ship a file under
   `templates/.agents/handoffs/` (or any path absent from the template manifest).

**Acceptance:** `checkpoint_write` in the dogfooded source writes
`<repo>/.agents/handoffs/<feature>.md` (gitignored), **not**
`templates/.agents/handoffs/`; `git status templates/` stays clean.

**Test:** `npm test` (add the drift guard); manual call, then `git status`.

---

## T2 — Make a deploy activate, and say when it hasn't  (`H-44`, P1)

**Why:** `update` writes files; a running opencode keeps the old
plugins/config/routing forever. LibraryOS has run since **before** 0.1.164, so
every LibraryOS measurement is pre-fix and the user still pays for `low`-effort
engineers on the direct-Pro architect tier.

**Fix (two touch points, one mechanism):**
1. **`doctor`** (`bin/agent-harness.js`, `function doctor` ~line 1681): add a
   stanza that finds running `opencode` processes for the target (match
   `process.cwd()` / a `serve` unit) and reports `process start vs
   .harness.json`/template write time. Fail-loud line:
   `opencode (pid N) started HH:MM, before the last harness write HH:MM — restart to load <version>`.
2. **`update`** (`function update` ~line 2249): at the end, if a live opencode
   for that target predates the write, print the same warning. Do NOT restart
   automatically while a session is live.
3. **Global `harness-freshness` plugin** (`contrib/global-plugins/harness-freshness.ts`):
   it already compares versions and already says "restart opencode to load the
   updated plugins" when it *updates*. Extend it to warn when the version is
   **already current but the running process predates the last write** (the case
   that silently bit us). One `block()`/notice is enough.

**Acceptance:** after `update` (or on a session start) on a box whose opencode
predates the harness write, the operator sees an explicit "restart opencode"
notice naming pid + version. No auto-restart with a live session.

**Test:** unit-test the age comparison with a fixture (process start, write
mtime); manual check with `ps`.

---

## T3 — Diagnose, then settle the `#high` retune  (`H-45`, P1)

**Do this before T4.** No `variant:"high"` exists anywhere in the store, and a
fresh post-dogfood session still recorded `build … v=default` despite
`opencode.json` `agents.build.model = opencode-go/deepseek-v4.1-flash#high`.
`#low` *does* land (`qa-runner`), so the syntax works somewhere.

**Steps:**
1. Reproduce with a throwaway probe: a session whose agent pins
   `model: <provider>/<model>#high` in **agent frontmatter** vs the same pin in
   **`opencode.json` `agents.<name>.model`**. Compare the recorded
   `$.model.variant` in `session_message`.
2. If `opencode.json` ignores `#variant` (likely): express effort via the agent
   `model:` frontmatter, or the correct V2 key; update the template.
3. If `#high` resolves to `default` by design: record that `default` == highest
   effort and stop claiming a distinct `#high` (fix the docs, not the config).
4. Add a `test:dispatch` assertion (see `templates/scripts/qa/check-dispatch-config.js`)
   that a `#high` pin does not silently fall back to `default`, and a drift guard
   that no persona claims an unmet effort.

**Acceptance:** a probe session records a non-`default` variant for a `#high`
pin, or the docs stop claiming one. Decided in writing either way.

**Test:** the probe + `npm run test:dispatch`.

---

## T4 — Re-target the guardrails at the real waste  (`H-46`, P2)

**Do this after a restart (T2) and a fresh measurement.** Current data: shell
inspection is already 11.6% of bash; `gates`=12, `where`=4, `diff`=0 all-time;
`qa-architect` = `read 799 · grep 132 · glob 85 · diff 0`; `tsc`/`test:quick`
re-run ~170× with no intervening edit.

**Fix:**
1. **Persona prompts** — `templates/.opencode/agents/qa-architect.md` and
   `planner.md`: make `diff` the first step of "inspect the change", `gates` for
   verification, and `orient` the opener; say explicitly "do not re-read a file
   the diff already shows".
2. **Gate re-run nudge** — `templates/.opencode/plugins/context-guard.ts:917`
   already logs `gate-rerun`; wire it to `tsc`/`test:quick` (it fired once).
   Extend the existing nudge so a repeat with no edit suggests batching/the
   right tier, not a blind re-run.
3. Re-measure with `session-recon.js` (post-restart, ≥1 week) and compare
   `inspectTotal`, whole-file reads, `diff`/`gates` adoption.

**Acceptance:** `diff`/`gates` adoption rises measurably and no-edit gate re-runs
fall; no new hard block was added without data.

**Test:** `npm test`; the recon numbers in the commit message.

---

## T5 — Fold the worktree refresh into `update`  (`H-48`, P3 — verify first)

**Note:** the global `harness-freshness` plugin **already** fast-forwards a stale
worktree at session open (`harness-freshness.ts` → `stale-would-ff` / ff path).
`f-343` was stale only because no session opened there since 0.1.165.

**Decide:** is the session-open safety net enough? If yes, close H-48 as
"covered" and just fix the AGENTS.md step-5 wording. If you want deploy-time
determinism, add the ff sweep to the end of `update` (fast-forward every linked
worktree; **warn, never fail**; never `update --target <worktree>`).

**Acceptance:** after `update`, all linked worktrees are level with `origin/main`
(or the session-open path is documented as the owner).

**Test:** `git worktree list` + per-worktree `.harness.json`; `update --dry-run`
if available.

---

## T6 — Confirm the nightly trust fix  (`H-47`, P2 — verify only)

No code unless it fails. Read the next run under
`~/develop/PublicVirtualLibrary/.agents/qa-runs/nightly/<stamp>/report.json`
after the timer fires (`systemctl --user list-timers`):
- the `failures[].reason` must be a **real error line** (not `tail(…,3)`, not the
  runner's own advisory);
- the device preflight must catch a missing `platform-tools` PATH (or the run
  passes);
- `F-332` must not be churn-reopened on a flaky test.

If any fails → fix `templates/scripts/nightly.js` (it is harness-owned).

---

## T7 — Re-measure H-23 / H-39(b)  (`verify only`)

After T2 (restart) + ≥1 week: run `session-recon.js` on LibraryOS and the
harness; record `inspectTotal`, whole-file reads, `diff`/`gates`/`where`/`orient`
counts in a short note. This closes or reopens H-23/H-46.

---

# Release workflow (per code change)

1. Bump `package.json` version (docs-only commits do **not** bump; the
   version-bump test enforces code changes).
2. `npm run lint` and `npm test` green.
3. Commit + push to `main` with `feat:`/`fix:` ending in `(0.1.x)`.
4. Deploy both active projects from **this** WSL checkout:
   ```bash
   node ~/develop/agent-harness/bin/agent-harness.js update --target ~/develop/PublicVirtualLibrary
   node ~/develop/agent-harness/bin/agent-harness.js update --target /mnt/c/develop/FamilyBudget
   ```
5. **Refresh every linked worktree** (fast-forward only; never
   `update --target <worktree>`):
   ```bash
   for wt in $(git -C ~/develop/PublicVirtualLibrary worktree list --porcelain \
       | awk '/^worktree /{print $2}' | tail -n +2); do
     git -C "$wt" merge --ff-only origin/main \
       || echo "MANUAL: $wt did not fast-forward — merge origin/main by hand"
   done
   ```
6. **Restart opencode** on the box so the new plugins/config load (this is T2's
   whole point).

# Do-not-churn list

- MCP is already off in LibraryOS (`pg`/`playwright` `enabled:false`); don't
  re-add it.
- `report:recon` / `report:cost` read V2 correctly — don't "fix" the store path.
- The dogfood guard + tools are live and stamped `root=`; don't re-add a second
  guard.
- Do not add a new hard block for shell inspection: it is already 11.6%.
