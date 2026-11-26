# F-053 — diagnosis

status: confirmed
symptom: ci-red-clean-checkout
confidence: high
owner: harness-repo
falsifier: orchestrator (evidence below)

## Observed vs expected

- Observed: `npm test` on GitHub Actions run 45895333772 (commit b513264) failed with
  `ENOENT: no such file or directory, open '.../.opencode/plugins/context-resume/index.ts'`
  at `tests/context-resume.test.js:206`.
- Expected: the context-resume source-contract test reads the deployed plugin copies and
  passes on every clean checkout of a landed commit.
- Reported by / evidence pointer: `gh run view 45895333772 --log-failed`, jobs test (22) and test (24).

## Evidence

| # | Evidence | Source (file:line / command / log) | Supports |
|---|---|---|---|
| 1 | Commit b513264 contains no deployed context-resume copies | `git ls-tree -r --name-only b513264 .opencode/plugins/context-resume/` (empty) | candidate 1 |
| 2 | The same commit contains the template copies | `git show --stat b513264` lists `templates/.opencode/plugins/context-resume/*` | candidate 1 |
| 3 | The test read the working tree, not the index | `tests/context-resume.test.js:203-210` at b513264 | candidate 1 |
| 4 | A local checkout of b513264 had the copies untracked | `git status` / `ls .opencode/plugins/context-resume` before d055956 | candidate 1 |
| 5 | d055956 commits the deployed copies and CI is green | `git ls-tree -r d055956 .opencode/...` (3 files); run 45895797728 all jobs success | confirmation |

## Candidate causes

| # | Cause | Likelihood | Discriminating test | Result |
|---|---|---|---|---|
| 1 | The finalize commit b513264 shipped templates but never committed the deployed copies; the local test passed on an untracked deployed copy | high | `git ls-tree -r b513264 .opencode/plugins/context-resume/` vs `git ls-tree -r d055956 ...` | confirmed |
| 2 | CI's checkout deleted or failed to materialize files that were committed (sparse checkout / workflow cleanup) | low | inspect the commit object itself: a tracked path exists in the tree regardless of checkout behavior | ruled out |

## Ruled out

| Cause | Why ruled out | Evidence |
|---|---|---|
| CI checkout dropped the files | the commit object for b513264 has no such paths, so there was nothing for checkout to drop; the run's first failing step is `npm test` with no deletion step before it | `git ls-tree -r b513264 .opencode/plugins/context-resume/` empty |

## Falsification

- Reviewer: orchestrator (falsifier pass over the commit objects)
- Strongest alternative: the deployed copies existed in b513264 and the CI checkout removed them.
- Test that separates it: read the commit tree directly (`git ls-tree -r b513264 ...`) instead of the working tree; also re-run the test in a fresh clone of b513264.
- Outcome: the paths are absent from the commit object and reproduce as ENOENT in a clean clone; the alternative is false.
- Residual uncertainty: none for this failure; the local working-tree read is what masked it.

## Outcome oracle

- Before (red): run 45895333772, jobs test (22) and test (24) failed with the ENOENT above on b513264.
- After (green): run 45895797728 on d055956 — test (22), test (24), and Board service gates all success; `node --test tests/context-resume.test.js` is 11/11 in the committed tree.
- Command / observation: `gh run view 45895333772 --log-failed`; `node --test tests/context-resume.test.js`; `git ls-tree -r b513264 .opencode/...`
- Environment / surface: GitHub Actions clean checkout plus the local committed tree.
- Independent owner: the CI workflow (`ci.yml`) executes the assertion on a clean checkout, independent of the new index read.

## Open questions

- none
