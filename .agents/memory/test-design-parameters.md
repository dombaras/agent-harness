# Test-design parameters — agent-harness

The canonical definition of "quality tests" for this project — the companion to
`.agents/memory/quality-parameters.md` (P1–P8, code quality). The `qa-architect`
applies these before authoring; reviews cite the T-tags instead of re-deriving
them, so test-quality findings are comparable across sessions.

A test can be green, counted as coverage, and still prove nothing — or cost far
more than it is worth. These ten parameters name the ways that happens:

| # | Parameter | Anti-pattern (what to reject) | What good looks like | Measured by |
|---|---|---|---|---|
| T1 | Exit/teardown contract | A suite passes, then the process lingers on an open handle until a timeout (e.g. 22 tests finish in 76 ms, process exits 60.4 s later) | The suite terminates inside its stated wall-clock budget; pools/handles closed in `after()` or the runner force-exits | linger detector (process wall-clock vs runner-reported `duration_ms`); QA-plan `## Test budget` |
| T2 | Independent oracle | The assertion restates the implementation's own literal/module (`SOFT_TTL_MS === 48*60*60*1000`) — a change detector that can only fail when the test is edited too | The assertion fails for a behavioral reason independent of the implementation's own literals | review; `## Oracle & owner` names the behavior it proves |
| T3 | Single owner | A new test duplicates an assertion an existing gate/preflight already runs against the real tree | The contract has exactly one owner; the plan names it (`new owner` only when none exists) | `## Oracle & owner`; grep wired tiers before authoring |
| T4 | Real exercised surface | A mount/render-only baseline (no effects, presses, or timers) is counted as coverage of a component's behavior | The assertion drives the path from the user's perspective and states what it executes | coverage map `->` entry names the executed assertion |
| T5 | Executed proof | Tier chosen by path label ("components → test:quick") though no suite imports the changed helper | Exact command + executed (non-skipped) assertion count ≥ 1 exercising the changed path | coverage map + runner `tests >= 1` report |
| T6 | Cost economics | An expensive suite sits in the per-push tier because risk coverage was the only selection criterion | Cheapest tier that still executes it; stated runtime; a total wall-clock budget for the pre-push tier | `## Test budget`; linger detector |
| T7 | Wired, not orphaned | A test file is authored but referenced by no npm script — neither protection nor failure signal | The file is executed by a named tier command and load-gated (`tests >= 1`) | `npm run test:wiring` |
| T8 | Hermetic isolation | A unit test imports real data-access/singleton modules; a side effect fires a real DB write or network call | No real data-access/network in a hermetic test; ambient env pinned to a fast-fail dummy before module load; unavoidable side effects own their teardown | review; isolation scan of test imports |
| T9 | Fail-loud AND fail-fast | Prerequisite failures throw (good), but each suite still lingers ~60 s on teardown, so a red run takes minutes | Bounded prerequisite timeout; the process exits promptly; a red run returns in seconds | linger detector |
| T10 | Value feedback & labeling | No per-suite failure telemetry; drift-guards/constant-pins counted as behavior coverage; a guard never proven to fire | Each assertion labeled `behavior`/`drift-guard`/`constant-pin`; guards carry a negative fixture that fails when the guard is removed; cheap labels stay off the per-push path | `## Oracle & owner` + `## Test-design self-check` |

## How a review uses this

- Cite the tag with evidence: `T1 [test-design] friction.test.ts lingers 60.4 s
  after 22 tests` — not a prose re-derivation of "slow teardown".
- The QA architect's 10-point checklist (`.agents/skills/qa-architect/SKILL.md`)
  is the authoring-time form of this table; the per-change QA plan records the
  outcome in `## Test budget`, `## Oracle & owner`, and
  `## Test-design self-check`.
- Mechanical coverage of this rubric: `npm run test:wiring` (T7) and the linger
  detector `node scripts/qa/check-linger.js -- <tier command>` (T1/T6/T9).

Keep this list current when the project adopts a new test-quality rule worth
enforcing project-wide — add a parameter row, don't leave it implicit.
