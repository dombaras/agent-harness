# Harness field review — 2026-10-16

A review of the harness **as deployed** — what LibraryOS (39 sessions) and the
harness repo itself actually ran after the OpenCode V2 port (0.1.157–0.1.163),
read from the opencode store, `.agents/guard-events.jsonl`, and the nightly
reports, **not** from the docs. It produced findings **F-1…F-13** and a
five-workstream plan (**W1–W5**) that shipped as **0.1.164**. This file is the
durable record; the per-item shipped detail is in
[`opencode-v2-migration.md`](opencode-v2-migration.md) §21, and the outstanding
follow-ups are on [`open-work.md`](open-work.md).

Method: `opencode session export`, direct reads of the local store
(`session_v2`/`session_message`), the guard JSONL, the nightly `report.json`, and
the 2.0.31 binary (for the tool→permission-action map). Evidence pointers are
given per finding; none is a re-derivation.

## Findings

### A. V2 breakage (blocking, quality regressions)

- **F-1 — the whole measurement path was dead on V2.** `provider-stats.js`
  shelled out to `opencode db --format json`, but **V2 has no `db` subcommand**
  (it prints root help, so `report:recon` failed with `Unexpected token 'D',
  "DESCRIPTIO"`). Worse, the *store moved*: V2 sessions live in
  `session_v2` + `session_message` (with no `part` table), while every query
  targeted the V1 `session`/`message`/`part` tables — so even a fixed CLI would
  read V2 sessions as zero. Blast radius: `report:cost`, `report:recon`,
  `session_info` (the mandated handoff line), and the guard's provider view.
  Replacement path verified: `opencode debug paths` → `db <path>`,
  `opencode session export <id>`.
- **F-2 — the plugin set and the guard's root were bound to one project.** A
  session rooted in `~/develop/agent-harness` loaded **LibraryOS's** plugins and
  the context-guard wrote leases + guard events into **LibraryOS's**
  `.serve/sessions/` and `.agents/guard-events.jsonl` — **6 harness sessions**
  were mapped into that file (`directory` was captured once at plugin setup).
  Root cause: a plugin instance is loaded per *location*, but V2's event stream
  is **process-wide**, so every instance saw every session's events. Consequence:
  guard telemetry (and the live-session view `test:concurrency` /
  `worktree-prune` read) was attributed to the wrong project.
- **F-3 — the nightly failed every night on harness plumbing and lied about
  why.** Oct 15 + Oct 16 both `verdict=fail`, `device-e2e code 127`, burning
  23 and 38.6 minutes, then reopening the P1 product row **F-331**. The recorded
  reason was `tail(output, 3)` — a fragment of a Node assertion object for one
  phase and the harness's *own* advisor text for another; the real signal was
  buried in `report.json`. Root cause of the `127`: a journey `setup:` step ran
  `adb …` under a headless PATH that omitted `platform-tools`.

### B. Existing guardrails were not biting (unchanged from the prior recon)

- **F-4 — read-only shell inspection was flat.** Window Oct 1–9: `grep` 1129,
  `ls` 626, `sed` 180, `cat` 144, `find` 52; the runtime blocks fired 94× +
  107 advisories. H-23 already said "re-measure, escalate if flat" — it was flat.
- **F-5 — `gates` and `where` were ~unused.** `gates`: **12** calls vs **1539**
  hand-truncated gate bash invocations; `where`: **4** calls vs 1129 shell greps.
  Discoverability, not capability.

### C. Budgets vs field reality

- **F-6 — step limits were below what the work needs.** `Maximum steps` events
  (LibraryOS, all time): qa-architect 10, mobile-engineer 8, frontend-engineer 6,
  diagnostics-expert 5, build 5, security-engineer 3, planner 3.
- **F-7 — the thinkers could not see the diff, so they mass-read.** `qa-architect`
  denies the shell yet its job is "inspect the diff": **799 reads** / 132 greps /
  85 globs / 96 edits, zero bash — which is *why* it exhausted 20 steps. There
  was no `diff` tool in the V2 tool list.

### D. Model usage & selection

- **F-8 — the architect tier was pinned to the provider that already failed.**
  `model-routing.md` mandated "V4 Pro always runs direct", and the guard log has
  **3 `funds` events (2026-09-17), all `deepseek/deepseek-v4-pro` direct** — a
  single pay-per-token key gating the highest-value personas, while
  `opencode-go/deepseek-v4-pro` offers `#high`/`#max`.
- **F-9 — reasoning variants were left at `low`** while `high`/`max` exist, so
  the engineers dying on `Maximum steps` ran at the cheapest effort.
- **F-10 — stale model metadata.** `models.allowlist.txt`,
  `switch-reasoning-model.{sh,ps1}`, and `model-routing.md` still carried
  `deepseek/deepseek-v4-flash` (dead), and the allowlist was a pre-V2 snapshot, so
  pinning any current model failed `test:dispatch` until regenerated.

### E. MCP

- **F-11 — 28 tool schemas billed every request, never called.** `pg` (3) +
  `playwright` (25) connected fine and had **0 invocations** across LibraryOS
  history. Decision: turn them off (project-owned config).

### F. Smaller gaps fixed in the same sweep

- **F-12 — cross-repo harness edits had no sanctioned path and were blocked.**
  A LibraryOS session's `mobile-engineer` tried to edit the harness
  `templates/scripts/qa/mobile-e2e/run-maestro.js` and the main-checkout guard
  blocked it 3×. Worktree isolation is per-repo, so "isolate first" cannot help.
- **F-13 — Windows-side stray processes / no CLI-surface check.** Two
  user-visible incidents ("metro from Windows", "why don't I see this commit on
  Vercel"); `doctor` had no Windows port/process check, no CLI/store-surface
  check (which would have caught F-1), and no V2-store check.
- **Repeated small frictions:** `Grep` failures on very long lines
  ("Ripgrep JSON record exceeded 65536 bytes" ×4); `checkpoint_write` empty-id
  (already fixed, re-verified); `apply_patch` not in the `V1_ACTION` map (needed
  to confirm it is governed by `edit`); and the `no_state` stuck-nudge firing at
  **turn 5 in every V2 session** (78/143 sessions) — the orientation prologue
  read as "stuck".

**What was *not* a gap (so we don't churn):** `orient`, `wait`, `job-notify`,
the capacity envelope, the WSL/tmpfs rules, and the guard blocks themselves all
measured as adopted and effective; persona skills loaded reliably.

## Plan (shipped in 0.1.164)

- **W1 — V2 store/CLI re-port (P1).** A shared `scripts/qa/store-lib.js` resolves
  the store via `opencode debug paths` and reads **both** `session_v2` +
  `session_message` and the V1 `session`/`message`/`part` shape;
  `provider-stats.js` and `session.ts` use it; `doctor` gained a store-surface
  stanza; a fixture test covers both shapes.
- **W2 — plugin/guard root correctness (P1).** The guard binds its root to the
  **session's** location (`session.created` carries `location.directory`; unseen
  sessions are resolved from the store via `sessionDirectory`), filters the
  process-wide event stream by location, and stamps `root=<dir>` on every guard
  event. Verified in the field after deploy (no cross-project lease).
- **W3 — nightly trust (P1).** The failure reason is taken from the flow-level
  `reason` / the last real error line (never `tail(…,3)`); a device **preflight**
  asserts `adb`/`maestro`/SDK before the long run and the journey `setup:` steps
  run under a PATH that includes `platform-tools`; a harness-side failure is
  classified `harness: true` and annotates instead of reopening a product row.
- **W4 — make the guardrails bite (P2).** `gates`/`where`/`orient` surfaced where
  the model looks (the `orient` digest, `AGENTS.md`, `dev-loop`); H-23 escalated
  so a pure single-path `cat <file>` / `ls [<dir>]` blocks on **every** occurrence;
  a bounded **`diff`** tool (`scripts/qa/diff.js` + `.opencode/plugins/diff.ts`)
  gives the thinkers a change view; step budgets raised to the measured p95.
- **W5 — model routing, MCP, hygiene (P2–P3).** Architect tier →
  `opencode-go/deepseek-v4-pro#high` (direct is the announced fallback), engineers
  → `#high`, `build` → `#high`/120 steps; `models.allowlist.txt` regenerated and
  the dead `deepseek-v4-flash` aliases deleted; `apply_patch` added to the
  `V1_ACTION` map (it resolves to the `edit` action — verified on the 2.0.31
  binary); `doctor` gained a Windows stray-listener stanza; the `/tidy` command
  and the F-12 cross-repo route added; the `no_state` startup grace (F-13).

### Post-release follow-ups (not blockers)

- Re-measure `gates`/`where` adoption and `inspectTotal` after 1–2 weeks.
- Confirm the W2 root fix in the field (this doc's deploy).
- MCP off in LibraryOS `opencode.json` (project-owned; decided).
- The deferred R8 (per-dispatch persona dedup) and bounded-`explore` adoption
  remain on `open-work.md`.
