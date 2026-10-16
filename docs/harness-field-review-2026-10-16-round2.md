# Harness field review — round 2 (2026-10-16)

A second review of the harness **as deployed**, after the `0.1.164` land (which
shipped the first field review, findings F-1…F-13 / plan W1–W5). Method is the
same: read the opencode store (`session_v2` / `session_message`), the guard
JSONL, and the nightly reports **as they are**, never the docs. It produced
findings **F-15…F-18** and a plan (**W6**). This file is the durable record; the
shipped detail, once landed, goes to
[`opencode-v2-migration.md`](opencode-v2-migration.md) and
[`open-work.md`](open-work.md).

Everything here is observed on the live box (opencode 2.0.31, 2026-10-16
~22:20 local): store `/home/ronen/.local/share/opencode/opencode.db` (593
`session_v2` rows vs 542 legacy `session` rows), the LibraryOS guard log
(10,348 events), the harness repo's own guard log, and the `2026-10-16T0348`
nightly.

## Findings

### A. The V2 store re-port is incomplete — the recon still reads V1 (blocking)

- **F-15 — `session-recon.js` (`report:recon`) reads the frozen V1 store, so
  every tool-habit measurement is stale.** On the live V2 store the recon
  resolves `store = { flavour: "v1", sessions: "session" }` and reads tool parts
  from `part`. Proof, run from the deployed LibraryOS copy:

  ```text
  node scripts/qa/session-recon.js --root ~/develop/agent-harness --since=7d
    Tool calls: bash 23 · read 2 · task 0          # reality: 2,230 tool calls
  node … --json | meta.store
    { flavour: "v1", sessions: "session" }          # should be session_v2
  ```

  The harness has **19 sessions** in that window (Oct 14 + Oct 16) with **2,251**
  tool calls (`session_message` census: `shell` 1,316, `read` 378, `edit` 343 …);
  the recon reports **2 sessions / 34 parts**. The legacy tables are frozen at
  **2026-10-14 17:32** (`session` max `time_created`) and `part` at **17:37**,
  while `session_v2` runs to **2026-10-16 22:13** — so the recon can only ever
  see pre-V2 history.

  Root cause (two coupled choices):
  1. `provider-stats.js` `collectStats()` treats **any** passed `runDb` as
     "tests, therefore V1": `const store = opts.runDb ? (opts.store || { flavour:
     "v1", sessions: "session", messages: "message", parts: "part" }) : storeLib.openStore(…)`
     (lines 634–639). `session-recon.js:358` passes a **runtime** `runDb`
     (`PS.runDbJson`), so it is misclassified as V1 and never detects the store.
     `provider-stats.js`'s own CLI and `agent-report.js:383` call `collectStats`
     **without** `runDb`, which is why `report:cost` correctly reports
     `flavour: v2` and only the recon regressed.
  2. `readReconPartsSql()` hardcodes `FROM part … json_extract(data,'$.tool')`
     (line 330–337) — V2 parts live in `session_message.data.content[]`
     (`json_each(m.data,'$.content')`, `$.name`), as `provider-stats.js` already
     does for V2.

  Impact: `report:recon` is the measurement instrument for **H-23** and the
  `0.1.164` follow-up **H-39(b)** ("re-measure `gates`/`where` adoption and
  `inspectTotal` after 1–2 weeks"). Those re-measurements are **invalid on V2**,
  and the W4 guardrail efficacy is **unmeasured** — not, as a first read
  suggested, "shell file-inspection down to 11.6 % of bash"; that 11.6 % was
  computed from the V1 mirror. The earlier session's "F-1 verified: the recon
  reads the V2 store" was a false green: the V1 mirror still had rows, so the
  numbers looked plausible.

  The unit tests miss it because they inject a `parts` array (or a V2 `store`)
  directly and never call `collectRecon()` end-to-end against the live schema.

### B. The harness repo itself is unguarded and toolless (F-16)

- **F-16 — `~/develop/agent-harness` has no `.opencode/`, so harness-dev
  sessions load no harness tooling.** opencode loads only the global
  `harness-freshness.ts` (`opencode.log` "loading plugin"); there is no
  context-guard instance, no lease, no guard telemetry, and none of the harness
  tools (`orient`, `session_info`, `checkpoint_write`, `backlog_*`, `gates`,
  `where`). The tool census proves it: harness sessions Oct 14–16 (2,230 calls)
  use `shell`/`read`/`edit`/`grep`/`webfetch` **only**, whereas LibraryOS (V1
  window) shows `checkpoint_write` 124, `session_info` 123, `backlog_*` 299,
  `apply_patch` 92. Harness sessions get guard treatment **only** when a deployed
  project's plugin instance is co-loaded (V2's event stream is process-wide) —
  the residual of F-2. Tracked as **H-40**.

### C. Agent foot-guns and config drift

- **F-17 — `pkill -f <pattern>` self-matches and kills the agent's own shell.**
  `ses_ec4193c1…` has **two** `finish:"error" ("Step interrupted")` turns from
  `pkill -f "port 4744"` matching the agent's own `bash -c` line, plus a
  third in `ses_ec4fae833…`; one instance also killed the shared opencode
  service mid-session (a restart, losing in-flight work). The agent learned it
  the hard way — its own text: *"I must NOT use pkill with a pattern that
  appears in my own command line. Use the recorded PID instead."* Neither the
  rules, `dev-loop`, nor the guard warn about it.

- **F-18 — the harness repo's own `opencode.json` is stale vs
  `templates/opencode.json`.** The root copy has no `build.model` and
  `build.steps: 100`; the template sets `build.model =
  opencode-go/deepseek-v4.1-flash#high` and `steps: 120`. Assistant messages in
  harness sessions carry `{"id":"deepseek-v4.1-flash","providerID":"opencode-go",
  "variant":"default"}`, so the `0.1.164` W5 routing retune (engineers → `#high`)
  does **not** apply to the harness's own dev sessions — they run the cheapest
  effort and 100 steps, the exact F-9/F-6 conditions the retune was meant to fix.

### What is *not* a gap (so we don't churn)

- `report:cost` / `agent-report` detect V2 correctly (`flavour: "v2"`).
- MCP is off in both projects (`LibraryOS` `mcp.pg`/`mcp.playwright`
  `enabled:false`; FamilyBudget has no `mcp` block).
- No `Maximum steps` finishes in the recent window; the guard log is clean
  (no fund stops, no cross-project leak post-restart).
- The nightly reports a **real** failure reason now — but the last runs
  (`2026-10-16T0348`) predate `0.1.164` (committed 22:02), so F-3 is **not yet
  field-verified**; the report still shows the `tail(…,3)` fragment
  (`operator: '==', diff: 'simple' }`) and the runner's own advisory for
  `device-e2e`, i.e. the pre-fix shape.

## Plan (W6)

- **W6.1 — finish the V2 store re-port for the recon (P2, F-15).** Make
  `collectStats` detect the flavour from the query **regardless of `runDb`** (or
  accept an explicit `store`), and read recon tool parts via the flavour
  (`json_each(m.data,'$.content')` / `$.name` on V2, `part` on V1) — reuse
  `provider-stats.js`'s V2 parts SQL. Add a `collectRecon()` test against a
  **V2** store (not an injected `parts` array) so the gap cannot recur, and a
  drift guard that the recon never hardcodes `FROM part`. Then run the real
  H-23 / H-39(b) re-measure.
- **W6.2 — guard the harness's own dev loop (P2, F-16 / H-40).** Decide and
  implement: self-deploy the harness into its repo root (`.gitignore` already
  ignores root `/.opencode/`, `/.agents/`, `opencode.json`, `AGENTS.md`) or ship
  `context-guard` as a global plugin, so a harness session is guarded and has
  the tools even standalone.
- **W6.3 — the `pkill` self-match (P3, F-17).** A `dev-loop` + rule note ("kill
  by recorded PID; never `pkill -f` a pattern that appears in your own command
  line") and, optionally, a `context-guard` advisory when a `pkill -f <pat>`
  command's pattern also appears in that command.
- **W6.4 — refresh the harness's own opencode config (P3, F-18).** Bring root
  `opencode.json` to the template values (`build#high`, `steps` 120) so
  harness-dev sessions get the retune — or, if W6.2 self-deploys, have the
  deploy own it.

## Evidence index

- Store: `/home/ronen/.local/share/opencode/opencode.db` (593 `session_v2` vs
  542 `session`; V1 freeze `2026-10-14 17:32`).
- `templates/scripts/qa/session-recon.js:330–337,358`;
  `templates/scripts/qa/provider-stats.js:634–639,238–256`.
- Recon runs (harness 7d; LibraryOS 14d) 2026-10-16.
- `opencode.log` plugin load (`/home/ronen/.local/share/opencode/log/opencode.log`).
- Guard logs: `~/develop/PublicVirtualLibrary/.agents/guard-events.jsonl`,
  `~/develop/agent-harness/.agents/guard-events.jsonl`.
- Sessions `ses_ec4193c1fffe7YXke0LwsfujOD`, `ses_ec4fae833ffeuiZLYjewFisGkf`.
- Nightly `~/develop/PublicVirtualLibrary/.agents/qa-runs/nightly/2026-10-16T0348/`.
