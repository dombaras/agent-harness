# Agent Harness — Root Code-Quality Improvement Plan (post-F-104)

> **Historical (shipped in `0.1.44`).** Kept for design rationale; M1–M7 all
> shipped (see `docs/optimization-implementation-status.md`). **Not live work.**
> Current harness open items are tracked in `docs/open-work.md`.

**Status:** implemented in **0.1.44** — see `docs/optimization-implementation-status.md`
for the standing workflow; this plan documents what shipped and why.
**Version shipped:** 0.1.44
**Input:** `.agents/features/code-quality-review/harness-root-codequality-findings.md`
(LibraryOS F-104 review session, 2026-09-09) — 7 findings + 2 appendices about the
harness itself.
**Execution venue:** this repo (`C:\develop\agent-harness`), per its AGENTS.md
workflow (bump `package.json` → `npm run lint` + `npm test` green → commit+push
`feat:/fix: … (0.1.x)` → deploy to LibraryOS via `node bin/agent-harness.js update --target C:\develop\PublicVirtualLibrary`).
**Persona model:** each workstream names the persona (from the shipped persona map,
`.templates/.agents/AGENTS.md` §5) whose standards it encodes, plus one **new
persona proposal** where the report exposes a real gap (see §New personas).
**Aim:** every change justified by token-usage ROI — fix the things that cost
sessions tokens every time they recur, before anything cosmetic.

---

## The one fact that changes the priority order

Investigation for this plan proved the F-094 fix is **not present anywhere today**:

- `sanitizeCell` (collapse control chars / whitespace in `formatRow`) was added
  **only to the deployed LibraryOS copy** (`fix(backlog) … (F-094)`, `1d2b0f9`).
- The next `agent-harness update` (`chore(harness) 0.1.40 -> 0.1.41`, `6d74030`)
  **overwrote `scripts/backlog.js` with the template version, reverting F-094.**
- Template and deployed copy are byte-identical today, and both contain the
  unsanitized `formatRow` (`return "| " + cells.join(" | ") + " |"`).
- LibraryOS's F-094 regression tests (`scripts/qa/tests/backlog.test.ts`) still
  exist but are **orphaned** (not wired into any npm script — F-117) — so the
  corruption is live and silent.

**Lesson encoded into this plan:** a fix to a deployed project copy is a fix that
will be reverted at the next update. All backlog-board fixes must land in the
**template** (`templates/scripts/**`), ship as a version bump, and carry a
harness-repo regression test (`tests/agent-harness.test.js`) so a future
re-revert cannot pass green. Milestone M1 exists to close that exact hole.

---

## Prioritized workstreams (token ROI order)

| # | Workstream | Ships as | Owner persona | Token ROI / rationale |
|---|---|---|---|---|
| M1 | Backlog write-path escaping + regression re-fix | `fix:` | features + system-architect | Every board corruption costs a session 20+ min of misleading-gate debugging (F-127/F-107/F-117 evidence). Fix once in template; regression test stops re-revert. |
| M2 | Shared board parser (dedupe `splitCells`) + honest cell-count diagnostics | `refactor:` | features (design) | One parse bug currently needs edits in 4–8 places; misleading "depends on unknown row" errors burn tokens re-deriving the real cause. |
| M3 | Handoff-argument validation in `take`/`next`/`worktree` | `fix:` | features | A literal-template handoff path cost a mid-session correction; a 5-line guard removes the whole class. |
| M4 | Canonical quality-parameters doc + `test:quality` mechanical gates | `feat:` | qa-architect (+ system-architect) | Kills per-review rubric re-derivation (3 scan agents each re-derived definitions) and mechanically blocks debt classes that recur review after review (F-068 → F-104 dead-code déjà vu). |
| M5 | `reviews/` namespace + `check-product` exclusion + changelog convention | `feat:` + `docs` persona decision | qa-architect / docs | Gives audit deliverables a validated home; stops audits improvising slugs inside the feature tree and passing `test:product` by absence. |
| M6 | Concurrency model decision (BACKLOG-as-shared-file) | `feat:`/`refactor:` (largest, defer) | system-architect | High build cost; only bite concurrent sessions. Choose warn→fail now, defer worktree-board move until F-104-class collisions recur. |
| M7 | Dispatch worktree-pin standardization | `feat:` (small, docs+rule) | planner | Third scan agent aborted once; a single standardized sentence in the task-spec contract removes the failure mode cheaply. |

M1–M3 are the same file surface (`backlog.js` + board gates) and should be built as
one coherent batch to avoid three version bumps touching the same lines.

---

## M1 — Board write-path escaping + regression re-fix

**Root problem (finding 2a + the re-revert above):** `cmdAdd` writes `task`/
`evidence` verbatim and `formatRow` joins cells with ` | ` and no per-cell
escaping, so a raw `|`, control char, or newline in a cell splits one row into
fragments. `test:backlog` then reports the *shifted* cell as a bogus "depends on
unknown row NNN" / priority / epic error.

**Changes (all under `templates/`, then bump + deploy):**
1. Re-introduce a cell sanitizer **in the shared write path**:
   `formatRow` (and any direct cell writers) escape every cell —
   collapse control chars/whitespace to a single space, strip leading markdown,
   and replace `|` with `/` (or a documented equivalent). Make it the **same**
   implementation shape the report cites from `lib/member-report-evidence.ts`
   `escapeCell()`, but live once in the board module so all callers inherit it.
2. Do **not** rely on `backlog.js add` callers to pre-escape; sanitize at write.
3. Ship the regression test **in the harness repo**
   (`tests/agent-harness.test.js`, which already exercises the deployed copy via
   `spawnSync(process.execPath, ["scripts/backlog.js", ...])`):
   - `add` with `|` in task/evidence stays one row (this is F-127's case — test
     must fail pre-fix).
   - `add` with newline in task/evidence stays one row (F-094's case — resurrect
     from the orphaned LibraryOS test).
   - `test:backlog` passes on the result.

**Token ROI:** high. One corrupt row forced `git diff BACKLOG.md` archaeology +
misleading-error decoding; the F-105 session shipped the same bug class to main.
Prevention is ~15 lines + one test.

**Owner:** features persona owns the board model/write path; system-architect
reviews the single-source module shape (M2). Author: harness maintainer.

---

## M2 — Shared board parser + honest diagnostics

**Root problem (finding 2b):** `function splitCells(row)` is copy-pasted in
`scripts/backlog.js`, `scripts/qa/check-backlog.js`, `scripts/qa/check-concurrency.js`,
`scripts/qa/merge-backlog.js`, plus the mobile mirrors. A parse fix must be
replicated in 4–8 places — which is exactly how the escape fix died once already.

**Changes:**
1. Extract one shared module, e.g. `templates/scripts/qa/board-lib.js`
   (`splitCells`, `formatRow`, cell escaping, section/row helpers used by >1
   consumer). Import from `backlog.js`, `check-backlog.js`,
   `check-concurrency.js`, `merge-backlog.js`.
2. Mobile mirror: prefer generating mobile's copy from the root module at
   deploy/init time over a second hand-maintained source (if generation is too
   heavy, add a `test:dispatch`-style guard that fails when the copies drift —
   compare hashes/`splitCells` bodies).
3. Make `check-backlog.js` **report the actual defect**: when a row's cell count
   ≠ header count, say `row F-127 has 7 cells, expected 6; unescaped '|' in column
   3 (task)` instead of letting a shifted cell surface as unknown-row/priority/
   epic errors. The report found the misleading output turned a one-line fix into
   a 20-minute repair.
4. Harness-repo regression tests: (a) `splitCells` is imported from one module
   (grep/no-duplicate assertion across the four scripts); (b) a planted 7-cell row
   makes `check-backlog.js` emit the cell-count message, not "depends on unknown
   row".

**Token ROI:** high. The misleading-error path costs tokens on every recurrence;
the duplication guarantees drift (already demonstrated: F-094 reverted in one
copy only).

**Owner:** features (board semantics + diagnostics). System-architect reviewed
module boundary (P4 one-home-per-fact).

---

## M3 — Handoff-argument validation

**Root problem (finding 3):** `backlog next --take` / `take` / `worktree` accepted
and recorded a literal `.agents/handoffs/F-<id>.md` as the Handoff cell; nothing
validated the path looked like a real `<id>.md` or would exist.

**Changes:** validate/normalize the handoff arg in the shared claim path —
must match `.agents/handoffs/F-xxx.md` for a known board ID, or auto-derive from
the row ID; fail fast otherwise (same guard class as the existing unknown-epic /
unknown-depends-on checks). Reuse the normalized value everywhere the handoff cell
is written (including the `(worktree: …)` suffix path).

**Token ROI:** medium-high. Fail-fast removes a whole mid-session repair + a board
cell that misleads later readers.

**Owner:** features.

---

## M4 — Canonical quality parameters + `test:quality` gates

**Root problem (finding 1):** no canonical definition of "quality code." The gate
suite is process-shaped only; every review (F-040/F-068/F-083/F-104/F-105)
re-invents a rubric and re-derives dimension definitions per scan agent. The same
debt classes recur because nothing mechanical blocks them at commit time.

**Changes:**
1. **Canonical quality doc** — adopt the report's Appendix B rubric (P1 dead-code
   free · P2 dependency hygiene · P3 right-sized units · P4 one home per fact ·
   P5 clean layering · P6 error & state contract · P7 type honesty · P8 consistency
   & i18n) as a shipped memory/standards file (e.g.
   `templates/.agents/memory/quality-parameters.md`) that review rows and the DoD
   checklist point to. DoD "quality lens" step references it instead of ad-hoc.
2. **Mechanical `test:quality` stage** (new `scripts/qa/check-quality.js`) run on
   new/changed code. Ship the cheap, grep-provable checks first (all proven by
   F-104 scans):
   - zero-consumer export/file scanner (symbol/file whose only reference is its own
     declaration → dead);
   - computed-then-discarded / `void x` local detector;
   - verbatim-duplicate-block detector across sibling files (byte-compare; F-104
     found the admin-route triad + 7 HMAC signers this way);
   - per-file size / single-responsibility lint (1,015-line route, 909-line screen
     are gate-visible) — align threshold with the DoD's existing ~500-line rule;
   - route-surface single-source — one file is the list of live routes; scripts
     asserting 200-vs-404 read it (F-104 found 3 stale baselines contradicting
     `routes.test.js`).
   Each check must be **opt-in by path/glob or diff-scoped** so legacy debt doesn't
   block new work — the report's intended split: gates stop *introduction*; review
   rows (F-118…F-129 pattern) clear *legacy*.
3. **Review rows reference the canonical rubric** — a review's findings cite
   P1–P8 tags instead of re-deriving dimensions, making F-068/F-083/F-104 reports
   comparable.

**Token ROI:** high over time. Kills per-review rubric re-derivation (3 scan
agents × re-derived definitions per audit) and stops recurring debt classes that
each previously cost a full review cycle to re-find. Build cost is real — scope
M4b gates incrementally: ship the scanner + size lint first, duplicate-block and
route-surface next.

**Owner:** qa-architect (gates, rubric, DoD "quality lens"); system-architect owns
P3/P4/P5 definitions (right-sized units, one-home-per-fact, layering). `docs`
persona reviews the doc home. Author: harness maintainer.

---

## M5 — `reviews/` namespace + `test:product` exclusion + changelog convention

**Root problem (findings 6 + 7):** review/audit deliverables have no canonical
home — F-104, F-040, and logs/friction audits all improvised slugs inside
`.agents/features/` and passed `test:product` only because "no intent.md/plan.md
yet" is treated as "not at planning stage". Separately, review-only ships are
`docs`/`chore` and thus changelog-invisible, so "we ran a review and filed N rows"
never appears in the human changelog.

**Changes:**
1. Add a first-class `.agents/reviews/<id>/` namespace (id from the board, e.g.
   `R-<n>` or reuse the row id) as the durable home for review findings
   (`REPORT.md` + `scans/*`). Excluded from `check-product`'s intent/plan
   expectations **by design** (explicit rule) not by absence.
2. Give review rows a stable artifact convention: rubric tags (P1–P8) → findings →
   remediation → follow-up rows, so audits become comparable. Wire the board epics
   registry (`audits-reviews` epic) to the namespace.
3. **Changelog convention decision** — choose one and document it in the `docs`
   skill: either review-only ships are changelog-exempt *by rule* (with
   `check-docs.js` comment updated to say so), or a review that files follow-ups
   appends a `docs`-type changelog line. Recommend the latter (a review that files
   N rows is a meaningful milestone the owner wants to see) — then `check-docs.js`
   must also accept `docs(chore)` commits that touch `.agents/reviews/**` or the
   board, or the reviewer appends a `feat(review)`-style changelog line. Decide,
   encode, and state in `templates/.agents/skills/docs/SKILL.md`.

**Token ROI:** medium. Removes per-audit improvisation and makes the audit
deliverable convention machine-checkable; small doc/gate changes.

**Owner:** qa-architect (namespace + artifact convention); docs persona owns the
changelog-convention decision + skill text. (If the team wants a dedicated owner
for audit lifecycle — see §New personas.)

---

## M6 — Concurrency: BACKLOG.md as the one genuinely shared file

**Root problem (finding 4):** worktrees isolate code, but `BACKLOG.md` is one
shared file every session's board tools write on `main`; two active sessions can
interleave board edits, and `test:concurrency` reported
`green (dirty tree tolerated — see warnings)` while the tree held another
session's uncommitted repairs mixed with the audit's.

**Changes (decision-first):**
1. **Now (cheap):** `test:concurrency` fails (not warns) when the shared tree is
   dirty with 2+ In-progress rows *and* `BACKLOG.md` itself is dirty — the board is
   the one file the ownership model cannot cleanly assign, so the collision it was
   built to catch becomes a hard failure for that file. Keep the precise
   owned-files attribution for everything else.
2. **Later (larger, correct):** move board writes into the feature worktree — each
   session commits its `BACKLOG.md` delta on its branch and the existing row-aware
   merge driver reconciles on integrate. Uniform isolation for code *and* board.
   Design by system-architect; only build after (1) proves insufficient or a real
   concurrent-session collision recurs.

**Token ROI:** (1) is cheap and prevents silent cross-session WIP mixing that
otherwise surfaces as confusing gate failures. (2) is a large build — defer until
evidence demands it (the "stronger fix" the report itself flags as larger).

**Owner:** system-architect (shared-file ownership model, merge driver);
features consumes. 

---

## M7 — Dispatch working-tree pin standardization

**Root problem (finding 5):** the dispatch layer cannot set a subagent's cwd, so a
scan agent dispatched to audit the f-104 worktree launched in `main`, correctly
refused to touch anything, and aborted — the tree check is self-reported
instruction, not a mechanical guarantee.

**Changes:** the dispatch *prompt contract* (task spec in the operating rules /
planner skill) standardizes one sentence: "run every read/write command with
`workdir` set to the assigned worktree (or `git -C <path>` for git)". The agents
that followed it never erred. If the tooling layer ever gains a cwd pin, add it —
until then, make the instruction a fixed clause of the dispatch template so it is
never an improvisation.

**Token ROI:** low-medium (one abort + one re-dispatch per affected session).
Cheap to ship; part of the M4 quality-doc wave since it touches the same
rule/skill text.

**Owner:** planner (dispatch-spec contract); harness maintainer edits the task-spec
template in `00-operating.md` + `planner/SKILL.md`.

---

## §New persona proposal (from the report's gaps)

The report exposes one durable role the shipped persona map does not name:
**the review/audit lifecycle owner.** Today "audits-reviews" exists only as a board
*epic key*; the actual scan/review labor is ad-hoc subagents, deliverables land in
the wrong tree, and no persona is accountable for the audit's artifact convention
or follow-up hygiene.

Proposed: **`quality-review`** persona (or fold into `qa-architect` if fan-out
stays lean) —
- owns `.agents/reviews/<id>/` artifacts + the P1–P8 rubric application;
- files follow-up rows for legacy debt found by gates (the gate stops
  introduction; the review persona triages legacy);
- is the dispatcher-facing owner M4's `test:quality` findings route to.

Decision rule: add the persona only when a real session does review work without a
home (F-104 already qualifies). If added, ship `.opencode/agents/quality-review.md`
+ `templates/.agents/skills/quality-review/SKILL.md` + a `test:dispatch` row, and
map it to the `audits-reviews` epic in the epics registry template. Otherwise
extend qa-architect's skill text to cover audit deliverables (M5 does this
regardless).

---

## Sequencing & release notes (shipped in 0.1.44)

All milestones shipped in a single version bump (`0.1.44`), since M1–M3 touch the
same files and M4/M5/M6/M7 are additive gates/docs:

| Bump | Message | Contents |
|---|---|---|
| 0.1.44 | `feat:` — harness code-quality hardening from the F-104 root findings (0.1.44) | M1 write-path escaping + F-094 re-fix · M2 shared `board-lib.js` + honest cell-count diagnostics · M3 handoff validation · M4 quality-parameters + `test:quality` · M5 `reviews/` namespace + changelog convention · M6 shared-BACKLOG hard-fail · M7 dispatch worktree-pin sentence |

Each bump: bump `package.json` → `npm run lint` + `npm test` green → commit+push
`feat:/fix: … (0.1.x)` → deploy:
`node bin/agent-harness.js update --target C:\develop\PublicVirtualLibrary`.

---

## Validation checklist (per milestone)

- [ ] Harness lint green (`npm run lint`).
- [ ] Harness tests green (`npm test`) — including the new M1/M2 regression tests
      (planted pipe row, planted newline row, splitCells single-module assertion,
      planted 7-cell row → cell-count diagnostic).
- [ ] Deployed copy regression: after `update --target`, confirm LibraryOS
      `scripts/backlog.js` + `scripts/qa/*` match the new template (the F-094
      re-revert must be impossible — regression test would fail first).
- [ ] LibraryOS pre-push gates still green in a scratch row `add`/`take`/`archive`
      cycle.

---

*Plan authored from the harness repo against the F-104 report. No harness code was
changed to produce this plan.*
