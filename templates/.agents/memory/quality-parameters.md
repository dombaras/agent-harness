# Quality parameters — {{PROJECT_NAME}}

The canonical definition of "quality code" for this project — the rubric a
code-quality review applies and the standard the Definition-of-Done's quality
lens points at. Read it before authoring a review/report row; a review cites
these P-tags instead of re-deriving dimensions, so audits (and their follow-up
rows) become comparable across sessions.

The eight parameters, each with what "good" looks like and how it is measured:

| # | Parameter | What good looks like | Measured by |
|---|---|---|---|
| P1 | Dead-code-free | No export/symbol/file with zero consumers; no computed-then-discarded value; no orphaned script/route that "used to" matter | zero-consumer scan; `void x` / discarded-local detector; route-surface single-source |
| P2 | Dependency hygiene | Deps are used, current, and justified; no duplicate/obsolete libraries; lockfile honest | `npm audit`; dep-usage grep; package.json review |
| P3 | Right-sized units | Files/units small enough to read in one sitting; one responsibility each; extract beyond ~500 lines | per-file line-count lint; component/module boundaries in review |
| P4 | One home per fact | No copy-pasted logic — a rule/helper/schema lives once and is imported | verbatim-duplicate-block detector across sibling files |
| P5 | Clean layering | UI, API, business logic, data access separated; handlers thin; no provider/ORM logic inline in a route | layer-boundary review; route-handler size |
| P6 | Error & state contract | Every state handled (ideal/empty/loading/error/partial); user-visible errors; no silent `catch`; no 500 leaking internals | code review; runtime assertions on error paths |
| P7 | Type honesty | No file-level suppressions (`@ts-nocheck`, blanket `eslint-disable`); no loose `any` seams | suppression scan; type-strictness review |
| P8 | Consistency & i18n | One pattern per concern; RTL-safe; no hardcoded strings where `t()` applies | cross-surface audit; i18n-parity guard |

## How a review uses this

- A review's findings cite the tag: `W2.1 [P4] admin community summary duplicated
  across 3 routes` — not a prose re-definition of "duplication".
- The "fix one, fix all" rule still applies: a finding names every surface that
  carries the defect (web / mobile / scripts), per `.agents/memory/flow-map.md`.
- Mechanical, provable parameters (P1 zero-consumer, P3 size, P4 duplicate
  blocks) are enforced by the `test:quality` gate on NEW/CHANGED code, so debt
  is not *introduced*; this rubric lets review rows clear *legacy* debt.

Keep this list current when the project adopts a new quality rule worth
enforcing project-wide — add a parameter row, don't leave it implicit.
