# Owned files per active row

One row per in-progress feature: the files/globs it owns. Drives the
cross-session overlap check in `test:concurrency` (two In-progress rows must
not own the same file). Format: `- <ID>: <glob>[, <glob>...]`.

- F-005: templates/opencode.json, templates/AGENTS.md, templates/.agents/memory/orchestration.md, templates/.agents/rules/00-operating.md, templates/scripts/qa/context-guard-core.js, templates/.opencode/plugins/context-guard.ts, templates/scripts/qa/run-gates.js, templates/scripts/qa/check-opencode-compat.js, templates/scripts/qa/check-test-wiring.js, bin/agent-harness.js, tests/agent-harness.test.js, package.json, README.md, CHANGELOG.md, docs/**, opencode.json
- F-041: lib/wikidata.ts, scripts/qa/tests/wikidata-genres.test.ts
