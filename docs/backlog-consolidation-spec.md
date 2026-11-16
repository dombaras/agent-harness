# Harness feature spec — canonical single-file backlog (`BACKLOG.md`)

> **Historical (shipped).** This is the 2026-08-30 spec that drove the canonical
> `BACKLOG.md` board; the capability shipped in the harness shortly after it and
> has since evolved (board hardening in `0.1.44`/`0.1.65`/`0.1.67`, merge-driver
> and worktree fixes in `0.1.68`). Kept for design rationale only — **not live
> work**. Current harness open items are tracked in `docs/open-work.md`.

> Author: LibraryOS orchestrator, 2026-08-30. For the agent implementing this in
> `opencode-agent-harness` (repo `C:\develop\agent-harness`). This spec describes a
> NEW harness capability; it does not change LibraryOS code paths.

## 1. Problem (why this exists)

The current harness convention produces **two competing "source of truth" files**
and lets open work drift into historical docs:

1. `.agents/features/INDEX.md` — shipped as a harness template, described in
   `templates/.agents/skills/features/SKILL.md` as the "collection box" / backlog.
2. `.agents/memory/todo.md` — NOT shipped by the harness; each project creates it
   ad hoc, and LibraryOS let it grow into a second backlog (sprint checklists,
   testing backlog, residuals, data/catalog follow-ups, "deferred" sections).
3. Historical/planning docs that hold open items with no canonical home:
   `antigravity-history.md` ("Open TODOs"), the roadmap
   (`brain/781a3c11…/implementation_plan.md` cut-list + UX multipliers),
   `css-interop-freeze.md` ("Rollback / future"), `issues-prelaunch-*.md`.

Concrete drift bugs this caused (observed in LibraryOS):

- **Priority vocabulary drift** — `features/SKILL.md` documents `P0..P3`
  (P0 highest), but the project actually uses `P1..P4` (P1 highest). Two
  directions, undocumented divergence.
- **Missing `frozen` status** — the ladder is `backlog → ready → in-progress →
  testing → shipped → archived`, so "parked, don't do but don't delete" items
  (F-002, F-006, F-009, F-016) had no valid state; LibraryOS invented `frozen` ad hoc.
- **No single write-path** — INDEX.md said "single source of truth is todo.md";
  todo.md said "single source of truth" too; both also duplicated the "Active/next"
  picks and the shipped history.
- **No gate** — nothing stops an agent from writing a row in the wrong file, or
  leaving an open row with no priority/evidence.

## 2. Target design

One canonical **`BACKLOG.md` at the repo root**. Everything else points to it.

Schema (see `C:\develop\PublicVirtualLibrary\BACKLOG.md` for the working reference):

```
# BACKLOG — canonical task list
  ## Active / next        (optional; the next few picks)
  ## In progress          | ID | Task | Handoff |   (active work — a session picked it up)
  ## Open                 | ID | P | Task | Evidence |   (sorted by priority)
  ## Frozen               | ID | Task | Why frozen / reopen |
  ## Archive (shipped·done) | ID | Task | Closed |
  ## Not tracking         (leave-in-place features — one prose note)
```

Rules the board must encode:

- **Status ladder** `backlog → ready → in-progress → testing → shipped → archived`
  **plus `frozen`**. `frozen` is terminal-ish (parked), and every frozen row MUST
  carry a `why` and a `reopen` condition.
- **Priority** `P1` blocking · `P2` important · `P3` nice-to-have · `P4` later.
  Reconcile the skill to this direction (or pick one direction and apply it
  everywhere — see §5 open decisions). Priority applies to open rows only.
- **Evidence** is a pointer (file/log/ticket/words), never a re-derivation. Unknown
  fields are `?`, never invented.
- **Active work is visible**: a session that starts dealing with an item moves its
  row `Open` → `In progress` (pointing `Handoff` at the session's handoff file), so
  the board always shows what is actively being worked, not just what's queued.
- **One write-path**: capture → `BACKLOG.md`; archive `shipped` rows; freeze
  don't-delete; update in the same session the work happens.
- Per-feature spec docs (`.agents/features/<slug>/` intent · scope · plan · tests)
  are UNCHANGED and still owned by the `features` persona. Only the *backlog list*
  moves from `INDEX.md` → `BACKLOG.md`.

## 3. Changes to the harness

### 3.1 Templates

- **Add** `templates/BACKLOG.md` — the canonical template with the usage header
  (status ladder incl. `frozen`, priority key, evidence rule, "single write-path"
  note) and empty Open/Frozen/Archive/Not-tracking sections.
- **Replace** `templates/.agents/features/INDEX.md` with a thin pointer:
  "The backlog lives in `BACKLOG.md`; per-feature docs still live in
  `.agents/features/<slug>/`." (Keep the file so old references don't dangle, or
  remove it and fix all references — see §5.)
- **Do NOT ship a `todo.md`.** If `init`/`update` finds an existing project
  `todo.md`, migrate it (see §3.5) and replace it with a pointer.

### 3.2 Skills

- `templates/.agents/skills/features/SKILL.md`:
  - Change the "Backlog" layer from `.agents/features/INDEX.md` → `BACKLOG.md`.
  - Add `frozen` to the documented status set, with "record why + reopen condition".
  - Reconcile the priority key to the chosen direction (§5); remove the stale
    `P0/P1/P2/P3` text.
  - Add explicit capture rules: one row in `BACKLOG.md`, evidence pointer, archive
    on ship, freeze don't-delete.
- `templates/.agents/skills/handoff/SKILL.md`: if it references `todo.md`/`INDEX.md`
  as the backlog, repoint to `BACKLOG.md`. Grep all skill + rule templates for
  `INDEX.md` and `todo.md` and update every occurrence.

### 3.3 Rules

- `templates/.agents/rules/00-operating.md` and `templates/.agents/AGENTS.md`:
  replace "capture a found item as one light row in `.agents/features/INDEX.md`"
  with `BACKLOG.md`; update the session checklist to read `BACKLOG.md` (alongside
  `locations.md` + `model-routing.md`).

### 3.4 Governance gate (new)

Add a linter (new script under `templates/scripts/qa/`, wired as `npm run
test:backlog`, and folded into the pre-push chain alongside
`test:dispatch`/`test:governance`) that asserts `BACKLOG.md` is well-formed:

- Status and priority values are from the allowed enums.
- Every `frozen` row has a non-empty reopen condition.
- Every open row has a non-empty priority and evidence cell (no `?` silently left —
  `?` is allowed but must be explicit, not blank).
- No duplicate IDs.
- `INDEX.md` and `todo.md` (if present) are pointers, not live lists (or absent).
- Only ONE canonical backlog file exists.

### 3.5 Migration path (existing deployments)

Add an idempotent migration — either a new command
`npx opencode-agent-harness migrate-backlog` or an `update` sub-step — that:

1. Reads the project's `.agents/features/INDEX.md` (F-rows), `.agents/memory/todo.md`
   (sprint/follow-up/deferred sections), and any flagged historical "Open" sections.
2. Emits a single `BACKLOG.md` with Open/Frozen/Archive sections, preserving
   shipped history in Archive and carrying frozen items with their reasons.
3. Rewrites `INDEX.md` and `todo.md` as pointers.
4. Is **idempotent** (re-run doesn't duplicate rows; stable IDs) and **never
   deletes** a source until `BACKLOG.md` has been written and verified.
5. Logs a summary: `N open · M frozen · K archived`.

## 4. Acceptance criteria

- `init` on a fresh project produces `BACKLOG.md` and no `todo.md`; `INDEX.md` is a
  pointer or absent.
- `update`/`migrate-backlog` on LibraryOS consolidates all rows with zero loss.
- `npm run test:backlog` (or `test:governance`) fails on: duplicate ID, illegal
  status/priority, frozen-without-reopen-condition, open-without-priority/evidence,
  or a live `todo.md`/`INDEX.md` that isn't a pointer.
- Every skill/rule reference to the backlog resolves to `BACKLOG.md`.

## 5. Open decisions for the implementer (confirm before coding)

1. **Location**: repo-root `BACKLOG.md` (recommended — human-visible "live tasks
   list") vs `.agents/features/BACKLOG.md` (keeps it in the features tree).
2. **Priority direction**: keep `P1`-high (recommended; matches LibraryOS usage)
   vs `P0`-high (matches the current skill text). Pick ONE, apply everywhere,
   document it in the skill.
3. **`INDEX.md` fate**: keep as a redirect pointer (recommended; least breakage) vs
   delete and fix all references.
4. **Gate home**: new `test:backlog` script vs fold into existing `test:governance`.
   Folding is simpler; a dedicated script gives clearer failure messages.

## 6. Reference

- Working consolidated board to mirror: `C:\develop\PublicVirtualLibrary\BACKLOG.md`
  (22 open, 4 frozen, 6 archived, not-tracking note).
- Harness layout: `templates/` (deployed per-project via `init`/`update`),
  `bin/agent-harness.js`, `tests/agent-harness.test.js`, `tools/`.
- Deployed (gitignored) files in LibraryOS: `AGENTS.md`, `opencode.json`,
  `.opencode/`, `.agents/AGENTS.md`, `.agents/skills/`, `.agents/rules/`,
  `.agents/memory/model-routing.md`, `scripts/qa/{check-dispatch-config.js,
  governance.js, models.allowlist.txt}` — regenerate, don't hand-edit.
