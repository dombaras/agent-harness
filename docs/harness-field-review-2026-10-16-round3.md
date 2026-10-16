# Harness field review — round 3 (2026-10-16)

A third review of the harness **as deployed**, after `0.1.165` (which landed the
round-2 plan W6). Method is unchanged: read the opencode store
(`session_v2` / `session_message`), the guard JSONL, and the nightly reports **as
they are**, never the docs. It produced findings **F-19…F-24** and a plan
(**W7**). Durable record here; shipped detail goes to
[`opencode-v2-migration.md`](opencode-v2-migration.md) and
[`open-work.md`](open-work.md).

Everything is observed on the live box (opencode 2.0.31, 2026-10-16
~22:45 local = 19:45Z): store
`/home/ronen/.local/share/opencode/opencode.db` (**594** `session_v2` rows vs
**542** legacy `session` rows), the LibraryOS guard log (**10,348** events), the
harness repo's own guard log (**39** events), and the `2026-10-16T0348` nightly.
The whole of today's activity is in the **harness repo**; **LibraryOS has had no
session since Oct 15** (0 assistant messages after `2026-10-16T00:00Z`).

## Findings

### A. What the round-2 fixes did — and did not — reach

- **F-15 (recon reads V2) — CONFIRMED FIXED in the field.** `session-recon.js`
  now resolves `store = { flavour: "v2", sessions: "session_v2" }` for **both**
  roots and returns real numbers (`report:recon --root ~/develop/agent-harness
  --since=14d` → **bash 2312 · read 626 · task 2**, was `2 sessions / 34 parts`).
  H-41 closes; H-23 / H-39(b) are now *measurable*.

- **F-16 (the harness is unguarded) — FIXED going forward, and this session is
  the proof.** `agent-harness dogfood` was applied at **19:39:09Z**
  (`.opencode/{agents,commands,plugins,skills}` → `templates/…` symlinks +
  `.harness-dogfood`). This review session (started 19:42Z) has the guard
  (`context-guard` wrote 4 `tool-block` + 17 `reroot` + … to
  `~/develop/agent-harness/.agents/guard-events.jsonl`, all stamped
  `root=/home/ronen/develop/agent-harness`) and the tools (`orient`, `gates`,
  `where`, `diff`, `backlog_*`, `checkpoint_write`, `session_info`). The reverse
  leak is gone: the harness log contains **no** LibraryOS-session events. H-40
  closes.
  - **But every harness session before 19:39Z — including the ones that authored
    F-15…F-18 and the `0.1.165` fix — ran unguarded and toolless**: the harness
    3-day tool census is `shell 1403 · read 404 · edit 378 · grep 55 · webfetch 47
    · write 41 · bash 23 · skill 12` and **zero** `orient`/`gates`/`where`/`diff`/
    `backlog_*`. The review work was itself done under the conditions the review
    warns about.

- **F-19 (blocking, P2) — deploy ≠ activate: the live LibraryOS process predates
  both landings and nothing restarts it.** The LibraryOS `opencode` process
  (**PID 26843**, cwd `/home/ronen/develop/PublicVirtualLibrary`) started
  **2026-10-16 15:35:35+03:00 = 12:35:35Z**; `0.1.164` was committed **22:02:33
  local = 19:02Z** and `0.1.165` at **22:41 local = 19:41Z**. So for the whole
  window the live LibraryOS loop runs the **pre-fix** plugin: the LibraryOS guard
  log's last event is **19:01Z** and still carries the pre-fix shapes —
  `no_state` firing at **turn 5 / noStateTurns 4** (the F-13 false positive the
  `no_state_grace_turns:8` fix was meant to silence), and harness-repo sessions
  (`ses_eb9ea7840…`, `ses_eb9fb6a42…`) attributed into **LibraryOS's** log
  (F-2/F-16 residual). Consequence: W2 (guard root), W4 (repeat-inspect
  escalation, H-23), W5 (routing retune) and W3 (nightly trust) are all **on disk
  but not in effect** for LibraryOS. `agent-harness update`/`dogfood` write files;
  neither can restart opencode, and neither the CLI nor `doctor` tells the
  operator to. This is the same class as F-13's "why don't I see this commit on
  Vercel" — a change that is present but inert.

### B. Budgets & routing (quality / efficiency)

- **F-20 (P2) — `#high` never takes effect; no `variant: "high"` exists anywhere
  in the store.** All-time `(agent · model · variant)` census: `build
  opencode-go/deepseek-v4.1-flash default` (19,027), `mobile-engineer …-flash
  low` (1,020), `qa-architect deepseek/deepseek-v4-pro default` (579),
  `planner/qa-architect/system-architect/security-engineer deepseek/…-pro
  default` (all-time), and **`v=high` = 0**. The one fresh, post-dogfood session
  (this review; server PID 201948 restarted **19:42:20Z**, i.e. *after* the
  `opencode.json` write at 19:39:09Z) recorded `build … v=default` despite
  `opencode.json` `agents.build.model = opencode-go/deepseek-v4.1-flash#high`.
  Since `#low` **does** land (`qa-runner`, `mobile-engineer` histories), the
  suffix syntax is real — so the W5 retune (`engineers → #high`, architect tier →
  `opencode-go/deepseek-v4-pro#high`) is either **not parsed from
  `opencode.json` `agents.*.model`** or **`high` resolves to the base/default
  variant**. Either way the "engineers run at cheapest effort" (F-9) and
  "architect tier on direct Pro" (F-8) conditions are **not yet demonstrably
  fixed**, and the retune has never been observed working. Verify before
  claiming W5.

- **F-21 (P3) — the architect tier still runs direct `deepseek/deepseek-v4-pro`**
  for its entire history (1,357 assistant turns across
  `qa-architect`/`planner`/`system-architect`/`security-engineer`, all
  `v=default`), the provider with the **3 `funds` stops** (F-8). All of that is
  pre-`0.1.164` (LibraryOS has been idle since), so it is *expected* — but it
  means the F-8 fix is also **unexercised**, and a resumed LibraryOS session on
  the stale PID 26843 would keep using it.

### C. Guardrails still not biting (unchanged from F-4/F-5)

- **F-22 (P2) — `gates` / `where` / `diff` adoption is flat.** All-time LibraryOS
  harness-tool counts: `checkpoint_write 124 · session_info 123 · backlog_next
  117 · backlog_list 113 · backlog_add 69 · orient 59 · backlog_owns 41 ·
  checkpoint_resume 40 · wait 35 · gates 12 · where 4 · diff 0`. Against a
  14-day LibraryOS tool census of `bash 1156 · read 908 · grep 229 · glob 134`.
  The thinker that F-7 was about, `qa-architect`, shows
  `read 799 · grep 132 · edit 96 · glob 85 · write 54 · skill 35` and **`diff` 0,
  `orient` 1** — the W4 "give the thinkers a change view" did not change the
  behavior. `orient` is the one mover (35 of its 59 calls are in the last 14
  days). H-23 / H-39(b) remain **not moved**.

- **F-23 (P3) — the persistent efficiency loss is whole-file reads and re-run
  gates, not shell inspection.** LibraryOS 30d → 14d: shell file-inspection
  **28.0% → 11.6%** of bash (`grep` 1237 → 53, `ls` 625 → 58 — a real drop, but
  the window boundary is confounded by a work-type shift and there is **no
  post-W4 data**), while **whole-file reads stay flat (72.6% → 71.9%)** and
  in-session re-reads and guess-and-retry reads persist (`failed (guessed path)`
  149 → 35). The gate re-run cost is large and unmoved: 30d `tsc` re-run with no
  intervening edit **171×**, `test:quick` **165×**, `test:qa-plan` 77×. The
  harness's own dev loop (its only fresh data) shows the same class worse:
  `lint` re-run **51×**, whole-file reads 34.5%, orientation prologue **avg 54
  calls/session (max 127)**, hand-rolled polls **57**. Cost stays concentrated in
  long sessions (harness 14d: `>100` turns = **71.9%** of cost; LibraryOS:
  `61–80` = 40.5%).

### D. Nightly & environment

- **F-24 (P2) — the nightly is still unverified and its reasons are still
  garbage.** The last run, `2026-10-16T0348` (00:48–04:32Z), **predates** the
  `0.1.164` (19:02Z) landing, so it shows the pre-fix shape: `static-unit` reason
  = `tail(…,3)` fragment (`operator: '==', diff: 'simple' }`), `device-e2e`
  reason = the runner's own advisory (`run-detached: --wait blocks…`), `device-e2e
  code 127`, wall **224 min**. It **reopened F-332** (a product P2 row) for a
  *real* flaky test (`scripts/qa/tests/external-retry.test.ts` backoff timing) —
  W3's `harness:true` classification would not and should not suppress that, but
  the recorded reason is still useless. The timer's next run was
  **2026-10-17 02:02:55 IDT (23:02Z)** — the first run that can confirm W3.

- **F-25 (P3) — one worktree is stale.** `~/develop/.worktrees/PublicVirtualLibrary/f-343`
  is on harness **0.1.164** and **1 commit behind `origin/main`**; the other six
  worktrees (incl. `nightly`) are `0.1.165` and level. The AGENTS.md step-5
  manual sweep left it behind — a resumed f-343 session silently misses the
  `0.1.165` guard/config fixes (the F-296/F-12 staleness class).

### E. A dogfood side effect (found while writing this review)

- **F-26 (P2) — the dogfood makes `__dirname`-based tool roots land on
  `templates/`, so a harness `checkpoint_write` writes into the *shipped*
  template tree.** This review's own `checkpoint_write` created
  `templates/.agents/handoffs/harness-field-review-round3.md`. Mechanism:
  `dogfood` symlinks repo `scripts` → `templates/scripts`; `checkpoint.js` sets
  `const root = path.resolve(__dirname, "..")` (line 29), and Node **realpaths**
  the symlinked script, so `__dirname` = `.../templates/scripts` and `root` =
  `.../templates` — not the repo root. The handoff is then inside the template
  tree that `agent-harness update` ships to **every** project (the H-14/F-14
  stray-handoff class, now template-wide). Removed here; the same
  `__dirname`-based root in any other deployed script is exposed. Fix: resolve
  the root from an explicit `--root`/`process.cwd()` (the plugins already pass
  the session directory), not `__dirname`; and/or add an `update` drift guard
  that refuses to ship a file absent from the template manifest.

### What is *not* a gap (so we don't churn)

- The recon now reads the V2 store on both roots (F-15/H-41 closed).
- The dogfood guard + tools load (this session) and stamp `root=`; **no**
  cross-project leak after 19:39Z.
- Worktrees are 6/7 fresh (nightly included); MCP is **off** in LibraryOS
  (`pg`/`playwright` `enabled:false`) and `build.steps:120`.
- The `#low` variant pin works (`qa-runner`, mechanical personas), so the
  variant mechanism itself is sound.
- Read-only shell foot-guns are down in the harness session window (`pkill -f` 2
  hits, both inside the pre-`0.1.165` window; the W6.3 guard is loaded now).

## Plan (W7)

- **W7.1 — activate the deploy, and make activation visible (P1, F-19).** A
  config/plugin/model change is inert until the opencode process restarts. Have
  `agent-harness update`/`dogfood` (and `doctor`) detect that a running opencode
  process was started **before** the last harness write to that project and
  **say so loudly** ("restart opencode to load 0.1.165"), or restart it for the
  operator when no session is live. The global `harness-freshness` plugin is the
  natural owner (it already runs at session start). Add a `doctor` stanza for
  process-vs-harness age.
- **W7.2 — settle the `#high` retune (P1, F-20/F-21).** Prove or fix: does
  opencode 2.0.31 honor `#variant` in `opencode.json` `agents.*.model`? If not,
  express the effort as agent `model:` frontmatter (which works) or the correct
  V2 key; add a `test:dispatch` assertion that a `#high` pin yields a `variant`
  other than `default` in a probe, and a drift guard that no persona claims an
  unmet effort. Re-measure the engineer/architect tiers after a LibraryOS session
  on a **restarted** process.
- **W7.3 — re-target the guardrails at the real waste (P2, F-22/F-23).** The
  measurement now says LibraryOS's loss is **whole-file reads + re-run gates +
  mass-read thinkers**, not shell inspection (already 11.6%). Before any more
  escalation, re-run the H-23 re-measure on **post-`0.1.164`** data with a
  restarted LibraryOS process; if `diff`/`gates` adoption is still ~0, the lever
  is upstream of the tool (the `qa-architect`/`planner` persona prompts tell them
  to *read* — point them at `diff`/`gates`, and make `orient`'s digest the
  default prologue). Consider a gate **re-run** nudge (`gate-rerun` already
  exists: 1 event — wire it to `tsc`/`test:quick`).
- **W7.4 — confirm the nightly W3 fix (P2, F-24).** Read the next
  `2026-10-17T…` run: the failure `reason` must be a real error line (not
  `tail(…,3)`/the runner's advisory), the device preflight must catch the missing
  PATH (or the journey must pass), and `F-332` must not be reopen-churned on a
  flaky test.
- **W7.5 — give the worktree sweep teeth (P3, F-25).** The step-5 manual loop
  missed `f-343`. Either fold the sweep into `update` (fast-forward every linked
  worktree, warn instead of failing), or have `harness-freshness` flag a worktree
  that is behind `origin/main` when a session opens in it.

## Evidence index

- Store: `/home/ronen/.local/share/opencode/opencode.db` (**594** `session_v2`
  vs **542** `session`); assistant-model census paths `$.model.{id,providerID,variant}`.
- Process: `ps` — PID 26843 `opencode` cwd `~/develop/PublicVirtualLibrary`
  started `2026-10-16 15:35:35+03:00`; PID 201948 `opencode serve --service`
  started `19:42:20Z`; PID 201987 cwd `~/develop/agent-harness`.
- Commits: `411f84f` (0.1.164, `22:02:33+03:00`) · `bead0d0` (0.1.165,
  `22:41:05+03:00`).
- Recon: `node scripts/qa/session-recon.js --root {~/develop/agent-harness,
  ~/develop/PublicVirtualLibrary} --since={14d,30d}`, 2026-10-16.
- Guard logs: `~/develop/PublicVirtualLibrary/.agents/guard-events.jsonl`
  (10,348) · `~/develop/agent-harness/.agents/guard-events.jsonl` (39).
- Config: `~/develop/agent-harness/opencode.json` vs `templates/opencode.json`
  (`agents.build = opencode-go/deepseek-v4.1-flash#high`, `steps:120`);
  `~/develop/PublicVirtualLibrary/opencode.json` (MCP `enabled:false`).
- Worktrees: `git -C ~/develop/PublicVirtualLibrary worktree list` + per-worktree
  `.harness.json` (`f-343` = 0.1.164, 1 behind).
- Nightly `~/develop/PublicVirtualLibrary/.agents/qa-runs/nightly/2026-10-16T0348/`
  (`report.json` `failures[].reason`); timer next-fire `2026-10-17 02:02:55 IDT`.
