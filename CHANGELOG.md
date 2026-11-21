# Changelog

## 0.4.1 — 2026-11-21

- The always-loaded `AGENTS.md` budget now fails before landing instead of only
  in CI: `test:prefix` runs in the ship/pre-push process battery, the ceiling has
  ~550 bytes of deliberate headroom (12 KiB, up from 11 KiB), and the file
  documents the trim-first / ask-the-user-before-raising path. The repo's own
  `test:quick` is defined so the quick phase is never silently empty. (F-018)

## 0.4.0 — 2026-11-21

- Added a hard-deny policy layer for credential paths, harness config/store
  self-modification, and MCP availability; MCP now requires explicit per-server
  opt-in. Policy merging is managed-first/project-appended with duplicate
  removal and legacy `experimental.policies` migration, while `update` and
  `doctor` warn about existing servers that remain denied; `test:opencode-compat`
  detects drift in the managed credential/MCP denies. (F-013)

- Trimmed the managed-MCP bullet in `AGENTS.md` back inside the always-loaded
  `test:prefix` size budget after the F-013 wording pushed it over (both
  clean-deploy prefix tests were red on CI). (F-013)

- The OpenCode todo panel works end-to-end again: `templates/opencode.json`
  enables `experimental.todo: true` (V2 gates the built-in `todowrite` behind it,
  default false), and `mergeOpencodeJson` deep-merges the `experimental` block so
  a project keeps its own flags while `todo` stays harness-managed. A new
  `test:opencode-compat` gate (wired into the process gates + `doctor`) fails a
  deploy that drifts to V1 — wrong runtime major, a missing/disabled
  `experimental.todo`, a leftover V1 config key (`small_model`/`agent`/
  `permission`/`tools`), a V1 plugin package/envelope, or the legacy
  `.opencode/tools`/`opencode/command` layout. The todo guard tightens to
  3/2 material calls, flags a list with open items but no `in_progress`
  (`nocurrent`), and stays silent when the project disables the capability.
  (F-005)

- OpenCode 2.3.2 compatibility scan: `docs/opencode-v2.3-compat-scan.md` audits
  every harness surface against the installed `2.3.2` binary and the published
  `@opencode/*@2.3.2` types. Verified live: all 11 harness plugins load, the
  pinned tool/session hooks and event payloads still match, `experimental.todo`
  still exists, and `session_v2` + `session_message` are still in the store.
  Filed the deltas as rows: managed `policies` hard-denies (P2), guard
  classifiers for the 2.3.2 built-in tool set (P3), native worktree alignment
  (P3), and the new `plugin`/`stats` CLI + stats-oracle follow-ups (P4). (F-006)

## 0.3.16 — 2026-11-21

- A harness-provisioned repo now shows its deployed harness version as a
  constant TUI badge (`harness v0.3.16`): in the home footer beside opencode's
  own version, and in the session prompt footer beside the model indicator. It
  reads the version from `.harness.json`, so it tracks `agent-harness update`,
  and renders nothing in repos that are not harness-provisioned. (F-012)

## 0.3.15 — 2026-11-21

- The Release workflow pins npm 11 instead of `npm@latest`: npm 12 changed
  `npm pack --json` output (an empty array) and broke `test:pack` before the
  publish step, so auto-releases failed before npm trusted publishing could
  run. npm 11 keeps OIDC publishing while the pack gate passes. (F-011)

## 0.3.14 — 2026-11-21

- Version bumps now reach npm automatically: after a green `main` CI run,
  `.github/workflows/auto-tag.yml` creates the missing `v<package.json version>`
  tag and dispatches `release.yml` (which gains `workflow_dispatch`). The release
  publishes with npm trusted publishing (OIDC), so no long-lived `NPM_TOKEN` is
  stored. A tag pushed with the workflow token cannot trigger another workflow,
  hence the explicit dispatch. (F-010)

## 0.3.13 — 2026-11-21

- Every green `CI` run on `main` now redeploys the harness into LibraryOS
  (`.github/workflows/deploy-libraryos.yml`): it checks out the CI-tested
  commit plus `dombaras/LibraryOS`, runs `agent-harness update` against it, and
  lets the updater commit/push the `chore(harness)` release. A write-scoped
  deploy key is stored as `LIBRARYOS_DEPLOY_KEY`; `update` is idempotent, so a
  landing that changes no harness file commits nothing. This closes the gap
  that left LibraryOS at v0.3.8 while the harness was v0.3.12. (F-009)

## 0.3.12 — 2026-11-21

- `backlog sync` no longer refuses a behind-only checkout just because an
  unrelated tracked file is dirty. It attempts the fast-forward and lets git
  protect the dirty file: unrelated edits are carried across, and only a file
  the landing would overwrite fails closed (with git's own error line). This
  previously stranded `main` one commit behind on an uncommitted config toggle
  the landing never touched. (F-008)
- Removed the accidentally tracked `node_modules` symlink from the release
  tree. (`7049179`)

## 0.3.11 — 2026-11-21

- Archiving a row from a linked feature worktree no longer writes that
  worktree's inherited board snapshot. The archive exception now applies only to
  a row the branch itself claimed (In progress), so a subsumed Open row is
  archived on the canonical board. Previously such an archive stranded in the
  feature checkout after its branch had already landed and had to be redone by
  hand from main. (F-007)

## 0.3.10 — 2026-11-21

- Board publishing no longer aborts on the gitignored (but tracked)
  `.agents/memory/owned-files.md`: `publishBoard` force-stages its explicit
  tracked extras, and every add/commit/push failure carries git's first error
  line. `backlog.js` prints that detail and whether the change is committed or
  only in the working tree, instead of a fixed "remote unreachable" note that
  masked local git failures for weeks. (F-004)
- `test:docs` skips link-shaped inline code spans (an API example such as
  ``plugin["tool.execute.before"](...)`` is not a markdown link), and
  `test:backlog` no longer counts `templates/BACKLOG.md` as a stray board, so
  both gates run green and can be enforced instead of rotting. (F-004)

## 0.3.9 — 2026-11-21

- `update` adopts harness-owned files whose working bytes already match the
  release but are still uncommitted against HEAD. A deploy that wrote a file
  but skipped it in its `chore(harness)` commit no longer leaves invisible
  drift: `.harness.json` records the worktree hash, so every later update saw
  "unchanged" and nothing was ever committed (the LibraryOS 0.3.8 case —
  `scripts/board-service.sh`, `finalize.js`, `qa/run-gates.js`, `wsl-tune.sh`
  needed a manual commit). The adopted files join the harness commit; a path
  whose staged bytes belong to another session is left in the index untouched.

## 0.3.8 — 2026-11-21

- `check-flows.js` no longer rejects a valid journey matrix: a `*TestID` prop
  that is forwarded resolves to the element's `testID` at runtime, so only a
  literal-free or unknown target is a violation; `runFlow: file:` includes are
  validated recursively — a missing file, an escape outside `flows/`, or an
  include cycle is reported against the journey instead of failing later as a
  Maestro timeout. Ported byte-for-byte from LibraryOS's project-proven copy so
  it has an upstream release identity. (03f3013)

## 0.3.7 — 2026-11-21

- `update` refuses to deploy from an uncommitted `templates/` tree and refuses
  `--no-commit` for a real deploy, so a release can never land downstream as
  untracked project WIP (the 2026-11-20 LibraryOS 0.3.6 incident). `--dry-run`
  previews; `--allow-dirty-templates` is the deliberate harness-development
  override. (0b97dc3)
- `wsl-tune` resolves the node binary instead of assuming PATH, because sudo
  resets it to the secure_path: a user-local node (nvm/volta/fnm/~/.local/bin)
  no longer makes the `.wslconfig` merge die with a bare
  `node: command not found` after the root tunables landed; under sudo the
  merge runs as the invoking user, and a failed merge is reported as one.
  (aa22740)
- The board-service systemd unit pins the generating node's directory in
  `PATH`: systemd --user's default PATH omits user-level Node installs, so
  `next`'s `#!/usr/bin/env node` shebang made the service restart-loop with
  exit 127. (5c4516b)

## 0.3.6 — 2026-11-20

- Finalization now closes the loop instead of reporting drift. `finalize` stages
  its tail with `git add -u` + explicit untracked adds, refusing generated paths,
  symlinks, other features' handoffs, and a stray worktree `BACKLOG.md` when the
  board service owns the board (the `git add -A` sweep had committed a
  `prisma/generated` symlink and could commit another session's work); after
  landing it fast-forwards a clean main checkout and prints the remaining
  close-out actions. NEW `scripts/qa/worktree-hygiene.js` reports main-checkout
  drift + merged/clean leftover worktrees, and `test:worktrees`
  (`scripts/qa/check-worktrees.js`, wired into the `process` gate phase and
  skipped on CI) fails when a landing left either behind.
- `update` no longer fails closed on the root `AGENTS.md` because `next dev`
  appended its `<!-- BEGIN:nextjs-agent-rules -->` block: the drift check and the
  deploy write now compare the harness-owned content with that tool-owned block
  stripped, so a marker-only difference is neither a hand-edit nor a rewrite
  (which previously made `next dev` re-append the block on the next run). A real
  edit to the harness-owned part is still refused. (F-349)
- The worktree-hygiene guard scripts (`scripts/qa/worktree-hygiene.js`,
  `scripts/qa/check-worktrees.js`) are committed at the repo root even though
  `/scripts` is gitignored, so a fresh clone gets `test:worktrees` instead of
  silently running nothing. (b68e1bc)

## 0.3.5 — 2026-11-20

- Shipped the `.agents/reviews/` scaffolding for review deliverables (ebe9dd8).
- Trimmed the canonical rulebook (`templates/.agents/AGENTS.md`) from ~47 KB to
  ~27 KB by removing the operating mechanics that duplicate the always-on root
  `AGENTS.md` and `.agents/rules/00-operating.md` (dispatch economics, retry/gate
  discipline, context budget, capacity guards, finalize/reporting). The rulebook
  now carries the durable standards and points at the summary for mechanics;
  test-pinned rules and every section number are preserved.
- Lowered the `test:prefix` size budget for the rulebook (48 -> 28 KiB) and the
  combined harness-owned ceiling (87 -> 69 KiB), so the dedupe is locked in and
  the prefix cannot silently regrow.

## 0.3.4 — 2026-11-20

- Added a durable per-project backend pin: `.harness.json`
  `"board": { ..., "backend": "file" }` keeps a project on the legacy file board
  without relying on a shell export (useful when the service is not provisioned
  on that machine). `backend: "service"` pins the service; `BACKLOG_BACKEND`
  remains the per-environment override, and `--root` still forces file mode for
  migration/tests. The pin survives `update` because `.harness.json` merges
  project fields.

## 0.3.3 — 2026-11-20

- Refined worktree archive routing: a row already in the worktree's board
  snapshot still archives there and rides the feature branch (finalize
  semantics), while a row captured after the branch was cut exists only on main
  and now archives on main instead of failing with "no row in BACKLOG.md".

## 0.3.2 — 2026-11-20

- Board capture/claim/read commands are project-scoped, never checkout-scoped.
  A `backlog` run inside a linked feature worktree now resolves to the shared
  board service — or, in legacy file mode, to the MAIN checkout's board — so a
  row captured mid-feature (the LibraryOS Next.js security finding filed in an
  f-002 worktree) reaches the main board immediately instead of a private
  worktree copy. In legacy file mode, `archive` of a row already in the
  worktree's snapshot rides the feature branch, so a failed `ship` cannot mark
  unlanded work done on main; a row captured after the branch was cut has no
  local copy, so its archive resolves to main (finalize no longer fails with
  "no row").
- A project that declares `board.url` in `.harness.json` now treats the service
  as mandatory: a missing token fails loudly with an actionable message instead
  of silently falling back to a checkout-local `BACKLOG.md`. The legacy file
  board remains available only through explicit `BACKLOG_BACKEND=file` or
  `--root`.
- The board client also reads the installed
  `~/.config/agent-harness/board.env`, so an opencode server launched outside the
  shell hook (systemd/desktop/resumed session) still reaches the service.
- Tests: a linked worktree mutation/read targets main and leaves the worktree
  copy untouched; a declared-service/no-token project writes no local row; the
  `board.env` token fallback is covered.

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
