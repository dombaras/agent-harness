# QA run evidence — one directory per change

Project-owned (like all `.agents/*` data). Full verbatim command/test output for
a QA run lives here, not in the agent's final message:
`.agents/qa-runs/<change-id>/evidence.txt` (same id as the QA plan / handoff —
`F-003`, `return-no-condition`). Only `qa-runner` writes here; never edit another
run's evidence.

Why: the orchestrator's context is the expensive part of a run. `qa-runner`
returns a compact summary (commands + exit codes, pass/fail per suite, evidence
path + sha256) and the unbounded logs stay on disk, so a failure can be audited
without bloating every later dispatch.

Integrity: the runner reports the artifact's sha256 via
`node scripts/qa/hash-file.js .agents/qa-runs/<id>/evidence.txt`; the
orchestrator can recompute it to confirm the summary matches the file.

    # evidence.txt (example)
    $ npm run test:quick
    exit 0 | 42 tests, 42 pass | runner 38.2s, wall 41.0s
    ... full verbatim output, no truncation ...
