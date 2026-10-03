# ADR 0001 — Move the development board out of the code repo

- **Status:** Accepted (Phase 0 frozen contract)
- **Date:** 2026-10-03
- **Owner:** harness
- **Supersedes:** the in-repo `BACKLOG.md` model
  ([`backlog-consolidation-spec.md`](backlog-consolidation-spec.md),
  [`backlog-integrity-fixes.md`](backlog-integrity-fixes.md) are historical)

## 1. Context

Today the canonical task list is `BACKLOG.md`, a file committed on each
project's `main` and mutated by `scripts/backlog.js`. Every board edit is routed
through the **code** transaction pipeline: an exclusive `.backlog.lock`, a
network fetch, a `chore(board): …` git commit, and a push that runs the
project's full pre-push gate battery. The board is copied into every feature
worktree and reconciled row-aware (`scripts/qa/board-sync.js`,
`merge-backlog.js`).

That coupling has produced a recurring class of defects:

- **0.1.139 field bug (2026-10-03):** the superadmin Queue button timed out. The
  background `sync` fired after a prior action held `.backlog.lock` for the
  entire ~28 s `git push` (pre-push `test:quick`); the next click waited only
  `LOCK_TIMEOUT_MS = 15000` and failed with
  `backlog: timed out waiting for the board lock`.
- **F-289:** `replayBoardOnly` left a stale index and corrupted the main checkout.
- **F-296 / F-297:** `chore(board): replay local board rows` silently dropped two
  sessions' rows.
- **Noise / contention:** 126 of 1166 commits (~11 %) are `chore(board)`; the
  per-worktree board copy needs a manual refresh sweep; the dashboard reads the
  board by shelling out to node/git from the dev server.

The board is **dev-work metadata**, not application code. It should not share
the code's lock, gates, history, or worktree lifecycle.

## 2. Decision

Replace `BACKLOG.md` with a **standalone, shared, project-scoped board service**:

- **Shape B — its own small Next.js app** (reuse Next.js + Prisma + Postgres +
  the existing SSE pattern). Not embedded in any project app.
- **Shared across all harness projects**, isolated by a tenant `project` key.
- **Standalone database/schema** on the same Postgres server (logical
  separation, shared infrastructure).
- **Online-only for v1** — no offline cache or write queue.
- **Import current live rows only**; start a fresh audit log.
- The board service **runs in CI** so board gates still execute there.

## 3. Architecture

```
  opencode backlog_* tools ─┐
  npm run backlog ──────────┼─▶ scripts/backlog.js  (HTTP client, same verbs)
  nightly / orient / finalize┤        │  bearer token + project key
  context-guard plugin ─────┘        ▼
                              services/board (Next.js + Prisma) ─▶ board Postgres
  LibraryOS superadmin UI ──▶ /api/admin/backlog (proxy, superadmin auth) ─▶ board
                              services/board ──▶ SSE (live updates)
```

- **Location:** `services/board/` in the harness repo. It is **not** copied into
  projects by `init`/`update` (it is a singleton, not a template).
- **Runtime:** WSL `systemd --user` unit (same pattern as `setup-tmpfs.sh` /
  `install-nightly`); in CI a service container + a Postgres service.
- **Reuse:** Next.js route handlers, Prisma, Postgres, and the existing SSE
  pattern. The dashboard is unchanged because the service returns the exact
  `BacklogBoard` shape it consumes today.

## 4. Frozen data model

Prisma models (board database). IDs are project-scoped.

| Model | Fields |
|---|---|
| `Project` | `key` (PK, e.g. `LibraryOS`), `name`, `createdAt` |
| `Epic` | `project`, `key`, `label`, `goal` — unique (`project`,`key`) |
| `BacklogItem` | `id` (e.g. `F-321`, unique per project), `project`, `status` (`open`·`queued`·`inprogress`·`frozen`·`archive`), `priority` (`?`/`P1`..`P4`), `epic` (`?`/epic key), `task`, `evidence`, `handoff`, `worktree`, `why`, `reopen`, `closed`, `sortOrder`, `createdAt`, `updatedAt` |
| `ItemDependency` | `itemId`, `dependsOnItemId` — replaces the "Depends on" cell; cycle-checked |
| `OwnedFile` | `itemId`, `glob` — replaces `.agents/memory/owned-files.md` |
| `AuditEvent` | `project`, `actor`, `action`, `itemId`, `payload` (JSON), `ts` |

**Invariants enforced atomically on every write** (superseding
`scripts/qa/check-backlog.js`): unique ID per project; `priority` ∈
{`?`,`P1`..`P4`}; `epic` ∈ {`?`} ∪ project epics; `frozen` rows have non-empty
`why` **and** `reopen`; `open`/`queued` rows have non-empty `priority` and
`evidence` (explicit `?` allowed); no dependency cycles; dependencies reference
existing rows. Status transitions mirror the CLI (`queue` only from `open`,
`take` from `open`/`queued`, etc.).

## 5. Frozen API contract

All routes are under `/api`. Auth: `Authorization: Bearer <token>`; tenant from
the token's project (the client also sends `X-Project`; the service rejects a
mismatch). Errors: `{ "error": string }` with `400` validation / `401` auth /
`404` unknown row / `409` illegal transition.

Board read (must equal today's `backlog.js list --json` shape):

```
GET /api/board            -> BacklogBoard
GET /api/board?all=1      -> BacklogBoard plus every archive row
```

```jsonc
// BacklogBoard (superset of components/superadmin/backlog/types.ts)
{
  "epics":      [{ "key": "...", "label": "...", "goal": "..." }],
  "active":     ["..."],
  "inprogress": [{ "id": "F-1", "epic": "?", "task": "...", "handoff": "..." }],
  "queued":     [{ "id": "F-1", "priority": "P2", "epic": "?", "task": "...", "evidence": "...", "dependsOn": "" }],
  "open":       [{ "id": "F-1", "priority": "P2", "epic": "?", "task": "...", "evidence": "...", "dependsOn": "" }],
  "frozen":     [{ "id": "F-1", "epic": "?", "task": "...", "condition": "why | reopen" }],
  "archive":    [{ "id": "F-1", "epic": "?", "task": "...", "closed": "..." }]
}
```

Writes (one row per call):

| Method + path | Body | Effect |
|---|---|---|
| `POST /api/items` | `{ task, priority?, evidence?, epic?, dependsOn? }` | add to `open`; allocates next free ID |
| `POST /api/items/:id/take` | `{ handoff? }` | `open`/`queued` → `inprogress` |
| `POST /api/items/:id/queue` | — | `open` → `queued` |
| `POST /api/items/:id/unqueue` | — | `queued` → `open` |
| `POST /api/items/:id/archive` | `{ closed? }` | → `archive` |
| `POST /api/items/:id/freeze` | `{ why, reopen }` | → `frozen` |
| `POST /api/items/:id/reopen` | `{ reason?, priority? }` | → `open` |
| `POST /api/items/:id/priority` | `{ priority }` | set priority |
| `POST /api/items/:id/epic` | `{ to }` | set epic |
| `POST /api/items/:id/depends` | `{ on }` | set dependencies (`?` clears) |
| `POST /api/items/:id/owns` | `{ files }` | set owned globs (`?` clears) |
| `POST /api/items/:id/worktree` | `{ dir, branch, handoff? }` | record worktree in the row |
| `GET /api/next` | — | top unblocked `queued` row |
| `POST /api/next/take` | `{ handoff? }` | atomically claim it |
| `GET /api/epics` / `POST /api/epics` | `{ key, label, goal? }` | list / add epic |
| `GET /api/events` | — | SSE: `initial`, `backlog_changed`, `ping` |
| `GET /api/audit?limit=` | — | recent `AuditEvent`s |

Every successful write returns `{ ok: true, result, board }` (the refreshed
`BacklogBoard`) and emits one `backlog_changed` SSE event — matching the current
superadmin route's response exactly.

## 6. Auth and configuration

- Per-project bearer tokens; project key = the project's `.harness.json`
  `projectName`.
- CLI/agents read `BACKLOG_API_URL` and `BACKLOG_API_TOKEN`; `agent-harness
  install-global` seeds them into `~/.config/opencode/` (machine-level, like the
  freshness plugin). No token → the CLI/gates fail loudly (online-only).
- LibraryOS `/api/admin/backlog` keeps `requireSuperadmin` and proxies
  server-to-server with the token, so the UI's auth is unchanged.

## 7. CI

A GitHub Actions job starts Postgres + the board app, runs migrations, seeds
fixtures, and runs `test:backlog` / `test:concurrency` against it. This is what
makes board gates runnable now that the harness tree itself is gitignored in CI
(cf. H-9).

## 8. Files that change / disappear

| Action | Items |
|---|---|
| Rewrite | `templates/scripts/backlog.js` → client; `templates/.opencode/tools/backlog.ts` unchanged |
| Repoint | `templates/scripts/{orient,nightly,finalize}.js`, `templates/.opencode/plugins/context-guard.ts` |
| Fold in | `templates/scripts/qa/check-backlog.js` validation → service; `test:backlog` becomes a service integrity query |
| Rewrite | `templates/scripts/qa/check-concurrency.js` (service reads; drop the dirty-board branch) |
| Delete | repo `BACKLOG.md`, `scripts/qa/board-sync.js`, `merge-backlog.js`, `withLock`, `--defer`/`sync`, merge-driver registration in `bin/agent-harness.js`, per-worktree board copies, `.gitattributes` `BACKLOG.md merge=` lines |
| Update docs/templates | `templates/AGENTS.md`, `.agents/skills/**`, `.agents/rules/**`, `.agents/AGENTS.md`, `templates/docs/gates.md` |
| New | `services/board/`, `migrate-board`, drift-guard tests |

`worktree`/`archive` keep their local git/FS side effects; only the board
**record** moves to the service.

## 9. Migration

`agent-harness migrate-board --target <dir>` parses the project `BACKLOG.md`
(reusing `scripts/qa/board-lib.js`) and upserts epics → items → deps → owned
files through the client. Idempotent, transactional, and it prints
`N open · M queued · K in-progress · J frozen · L archived`. Parity is checked
by diffing `GET /api/board` against `backlog.js list --all --json` before the
file is deleted. `BACKLOG_BACKEND=file|service` keeps cutover reversible.

## 10. Phasing

| Phase | Work | Done when |
|---|---|---|
| **0. ADR + contract** (this doc) | freeze schema/API; record open work | ADR reviewed |
| **1. Board app** | `services/board/` over the board DB; validation, SSE, audit; `migrate-board` | parity + concurrency suite passes against a board copy |
| **2. Client** | rewrite `scripts/backlog.js`; `BACKLOG_BACKEND` flag | existing `backlog.test.ts` verbs pass against the service |
| | | **done** — `board-client.js` + service backend wired into every CLI verb; 2 harness tests (mock service) green |
| **3. Consumers + CI** | orient/nightly/finalize/context-guard; `test:backlog`, `test:concurrency`; CI job | `test:quick`/`test:backlog`/`test:concurrency` green local + CI |
| **4. Dashboard** | proxy route + SSE | superadmin queue/start/add/archive live; zero `chore(board)` commits |
| | | **done (LibraryOS)** — `lib/board-service.ts` bridge + route/stream delegation; file stays default until cutover |
| **5. Retire file model** | delete file tooling/driver/lock; migrate both projects; refresh worktrees | board drives every surface; no `BACKLOG.md` remains |

Each phase is a normal harness release (bump `package.json`, `npm run lint` +
`npm test`, deploy to LibraryOS + FamilyBudget, refresh worktrees).

## 11. Test strategy

Port `scripts/qa/tests/backlog.test.ts` and `board-sync.test.js` to a service
harness (real Postgres, ephemeral schema). Add: concurrent `add` under load (the
F-195 duplicate-ID case), atomic `next --take`, dependency-cycle rejection,
frozen-needs-reopen invariant, owned-file overlap, and a static gate that no
consumer reads `BACKLOG.md` or the old file/sync path.

## 12. Consequences and risks

- **Service up required for board gates** — by design (online-only). Mitigated by
  the CI job; an outage blocks pushes.
- **Auth distribution** to agents/CI — `install-global` + CI secrets.
- **Big-bang migration risk** — feature flag + parity diff; the file path stays
  until Phase 5.
- **Loss of `git log`/blame on the board** — `AuditEvent` replaces it.
- **Blast radius across both projects** — phase gating + deploy discipline.

## 13. Out of scope (v1)

Offline/local cache; multi-instance SSE (single instance first; Postgres
`LISTEN/NOTIFY` later); GitHub/Linear integrations; a dashboard UI redesign
(that is the project's F-321).
