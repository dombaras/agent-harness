# Owned files per active row

One row per in-progress feature: the files/globs it owns. Drives the
cross-session overlap check in `test:concurrency` (two In-progress rows must
not own the same file). Format: `- <ID>: <glob>[, <glob>...]`.

- F-005: templates/opencode.json, templates/AGENTS.md, templates/.agents/memory/orchestration.md, templates/.agents/rules/00-operating.md, templates/scripts/qa/context-guard-core.js, templates/.opencode/plugins/context-guard.ts, templates/scripts/qa/run-gates.js, templates/scripts/qa/check-opencode-compat.js, templates/scripts/qa/check-test-wiring.js, bin/agent-harness.js, tests/agent-harness.test.js, package.json, README.md, CHANGELOG.md, docs/**, opencode.json
- F-020: templates/scripts/backlog.js, tests/agent-harness.test.js, .agents/qa-plans/f-020-*.md, CHANGELOG.md
- F-028: scripts/finalize.js, scripts/qa/governance.js, templates/scripts/finalize.js, templates/scripts/qa/governance.js, .github/workflows/deploy-libraryos.yml, tests/agent-harness.test.js
- F-041: lib/wikidata.ts, scripts/qa/tests/wikidata-genres.test.ts
