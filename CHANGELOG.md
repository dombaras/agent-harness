# Changelog

## 0.2.0 — 2026-11-16

First public release under the `opencode-agent-harness` name.

- Renamed the package from `@dombaras/agent-harness` to `opencode-agent-harness`
  (the CLI binary remains `agent-harness`).
- `init` no longer commits or pushes by default; pass `--commit` / `--push`.
  `update` keeps its auto-commit behaviour.
- `init` refuses to overwrite a pre-existing `AGENTS.md` it did not create;
  `--accept-harness` overwrites deliberately after backing the file up under
  `.harness-backup/`. Pre-existing untracked harness files are backed up before
  any overwrite.
- Added `repository`, `homepage`, `bugs`, `author`, and public-package keywords;
  Node engine raised to `>=20`.
- Added a packed-tarball smoke test (`npm run test:pack`), a `prepublishOnly`
  gate, and a tag-driven release workflow.
- Default model routing is unchanged (`opencode-go/*`).

## 0.1.21 — 2026-09-04

Last release under the previous name, `@dombaras/agent-harness`.
