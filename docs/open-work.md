# Agent Harness — open work

Canonical list of outstanding work on the harness itself. The harness has no
`BACKLOG.md` of its own, so this file is it, mirroring the board conventions
(`P1` blocking · `P2` important · `P3` nice-to-have · `P4` later; evidence is a
pointer, never a re-derivation). Shipped work is recorded in
[`optimization-implementation-status.md`](optimization-implementation-status.md);
the historical strategy docs
([`backlog-consolidation-spec.md`](backlog-consolidation-spec.md),
[`harness-code-quality-plan.md`](harness-code-quality-plan.md)) are labeled
historical.

Items marked **moved from LibraryOS** were field defects discovered in the
`PublicVirtualLibrary` project whose root cause is a harness mechanism; they
were archived on that project's board and now live here.

## Open

| ID | P | Area | Task | Evidence | Source | Status |
|---|---|---|---|---|---|---|
| H-1 | P2 | worktree / deploy | `backlog worktree` → `deploy:uat` fails at the Vercel build: the worktree's `prisma/generated` is a symlink to the main checkout and no `.vercelignore` excludes it, so the remote postinstall `prisma generate` hits `ENOTDIR mkdir '/vercel/path0/prisma/generated'` and the deployment errors (alias `ekedio-uat` unmoved). Add a tracked `.vercelignore` (`prisma/generated`, `node_modules`) or realize the generated client as a real dir in worktrees (extends the F-183 worktree bootstrap), and stop `deploy-env.js` from exiting 0 on a failed Vercel deploy (extends the F-179 false-green). | devops-engineer F-229 session 2026-09-17: worktree f-229 `deploy:uat` → vercel deploy ERROR (ENOTDIR prisma/generated); alias `ekedio-uat` unmoved; `deploy-env.js` still exited 0. Note: `scripts/deploy-env.js` is project-owned; the worktree generated-tree layout is harness `cmdWorktree` / `worktree-setup`. | moved from LibraryOS F-230 (2026-09-17) | open |
| H-2 | P2 | testing / sessions | Live QA suites flake with spurious 401s when multiple worktree sessions share one dev Postgres and the seeded SUPER_ADMIN: the single-device `UserAuth.activeSessionId` is overwritten by another session's `signSessionToken` mid-run, so an in-flight `saToken` is rejected. Isolate live tiers (per-worktree DB), serialize them, or document a quiesce requirement. | `.agents/qa-runs/f-148/evidence.txt` — `active-session-trace.log` / `session-watch.cjs`; servers :3000 (main), :3200 (f-129), :3100 (f-148) sharing one DB. Observed 4×/30s. | moved from LibraryOS F-224 (2026-09-17) | open |
| H-3 | P3 | QA tooling | `check-linger.js` reports a false LINGER on the multi-block `test:api` script — wall-clock minus the LAST runner-reported test time mis-attributes the tsc + first `node:test` block as teardown. Make the linger measurement per-block or subtract non-test overhead so a legitimate multi-block tier is not flagged. | F-129 qa-runner: `node scripts/qa/check-linger.js -- "npm run test:api"` exit 1 LINGER 33.8s over a 5s budget, while both blocks summed ~93s and real post-run overhead was ~6s; arithmetic in `.agents/qa-runs/F-129/evidence.txt`. | moved from LibraryOS F-227 (2026-09-17) | open |
| H-4 | P3 | updater | Retire the orphaned nested `mobile/` harness install: `mobile/.harness.json` (projectName "mobile", harness v0.1.27) plus `mobile/AGENTS.md`, `mobile/opencode.json`, `mobile/.opencode/**`, `mobile/.agents/**` still describe a second harness project. Its board was consolidated 2026-09-16, but the stale opencode tools/commands still tell agents to run `node scripts/backlog.js` from `mobile/` (now a dead path). Have `init`/`update` detect and clean up (or clearly warn about) nested/secondary `.harness.json` installs. | `mobile/.harness.json` (projectName "mobile", version 0.1.27, initializedAt 2026-08-30); `mobile/.opencode/tools/backlog.ts:14`, `mobile/.opencode/command/board.md:8`, `mobile/.opencode/command/next.md:7,11` reference `scripts/backlog.js`. | moved from LibraryOS F-214 (2026-09-17) | open |
| H-5 | P3 | optimization | R8 — per-dispatch persona dedup. Deferred in the cost/context optimization effort; no implementation started. | `docs/cost-optimization-recommendations-2026-09-12.md` R8; `docs/optimization-implementation-status.md` "What's next". | harness | deferred |
| H-6 | P4 | measurement | Cost/context targets are unproven until measured: run `npm run report:cost` monthly (2-week window minimum) and compare exported snapshots. R2/R3 can be judged on post-`0.1.53` data, R9/R10 on post-`0.1.56` data; R13 (doc truth) re-checked after the next guard-threshold change. | `docs/optimization-implementation-status.md` "What's next — measurement only". | harness | ongoing |

## Closed

| ID | P | Area | Task | Source | Closed |
|---|---|---|---|---|---|
| H-7 | P3 | docs | Refresh the status doc (v0.1.65 → v0.1.68) and record the skipped `0.1.66` version; label the historical strategy docs. | harness | 2026-09-17 |
| H-8 | P2 | sessions | `0.1.67` session leases had no process identity: a recycled pid or a session closed without `session.deleted` stayed "live" up to 12h and blocked `test:concurrency` (LibraryOS saw 7 "live" sessions vs 3–4 real, incl. `UU BACKLOG.md` from a concurrent merge). Fix: shared `lease-lib.js` with a birth token (`bootId` + `/proc` starttime) + heartbeat, plugin startup sweep, `check-concurrency --prune`, and `backlog worktree --open` to root a session in its worktree. | harness | 2026-09-18 |

## Not tracked here

- **npm publish** — `AGENTS.md` states publishing is optional and done on the
  user's side; the local-checkout `update`/deploy is the authoritative path, so
  the registry being behind local `package.json` is not harness open work.
