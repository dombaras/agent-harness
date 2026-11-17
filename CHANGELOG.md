# Changelog

## 0.3.1 — 2026-11-17

- Added an `sdlc` bundle profile: the process/quality harness only (personas,
  rules, skills, memory, backlog, context/token discipline, and the process
  gates) without deploy, CI, host-tuning, mobile-E2E, or the board service.
  Like `core`, its bundle is a single-commit snapshot.
- The `sdlc` archive carries a `profile.json`; `init`/`update` read it and wire
  only the npm scripts whose files actually ship, so a process-only checkout has
  no dead `ship`/`nightly`/`serve` entries. No `profile.json` still means the
  full harness.
- Kept the shared libraries that the retained features import
  (`capacity-lib.js` for the context guard/`orient`, `merge-backlog.js` for the
  board merge driver) in the `sdlc` archive.

## 0.3.0 — 2026-11-17

- Added `npm run bundle` (`tools/make-release-bundle.mjs`) for closed /
  air-gapped handovers: a source zip, a git bundle, `MANIFEST.json`
  (commit + per-file SHA-256), `REVIEW-NOTES.md`, and `SHA256SUMS`.
- Added a `core` bundle profile that drops the host-tuning installers
  (WSL sysctls, tmpfs, GPU, nightly timer), the mobile-E2E tier, and the global
  freshness plugin; its bundle is a single-commit snapshot so excluded files are
  not carried in history.
- `tools/` is repo tooling only — not shipped in the npm package and not
  deployed by `init`.

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
