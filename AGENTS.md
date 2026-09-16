# agent-harness — repo workflow

Standing workflow for every change to the harness (`bin/`, `templates/`,
`docs/`, tests). The authoritative checkout is WSL2 at `~/develop/agent-harness`;
the Windows checkout (`C:\develop\agent-harness`) is a deprecated fallback.

1. Bump `package.json` version (the version-bump test enforces this).
2. `npm run lint` and `npm test` must both be green.
3. Commit + push to `main` with a `feat:`/`fix:` message ending in `(0.1.x)`.
4. Deploy to the active projects from this local checkout (always after harness changes):

   ```bash
   node ~/develop/agent-harness/bin/agent-harness.js update --target ~/develop/PublicVirtualLibrary
   ```

Active projects: **LibraryOS** at `~/develop/PublicVirtualLibrary` (WSL, primary).
**FamilyBudget** is not yet cloned into WSL — deploy it from the Windows checkout
(`node /mnt/c/develop/agent-harness/bin/agent-harness.js update --target /mnt/c/develop/FamilyBudget`)
until it migrates. Publishing to npm is optional and done on the user's side — the
local-checkout updates above are the authoritative way to push harness changes to
the projects.

## WSL environment

The harness's primary environment is WSL2 (Ubuntu). These rules keep it healthy
across the Windows/Linux boundary:

- **Run Node from ext4, never `/mnt/c`.** Windows drives under `/mnt/<drive>/`
  are 9p/virtio-fs — orders of magnitude slower, worst on `node_modules` churn.
  Keep the authoritative checkout and projects under `~/develop`
  (`~/develop/agent-harness`, `~/develop/PublicVirtualLibrary`,
  `~/develop/.worktrees/...`). `deploy`/`update` prints a warning when a target
  is on a `/mnt/` mount; treat it as a prompt to migrate that project to WSL,
  not a blocker. CLI, tests, and gates all run natively from the WSL checkout.
- **Line endings are pinned.** `.gitattributes` (repo root and the harness-managed
  section deployed into each project) pins `*.sh` to LF and `*.ps1` to CRLF, so a
  Windows-side checkout/commit can never CRLF a POSIX script (`bash` fails with
  `bad interpreter: ...\r`). Never hand-flip line endings on `templates/scripts/`.
- **opencode external-directory allowlist.** The harness isolates each feature in
  a sibling worktree (`<repo>/../.worktrees/<repo>/<id>`), which is *outside* the
  project root, so `~/.config/opencode/opencode.jsonc` must allow `~/develop/**`
  (worktrees) and `/mnt/c/develop/**` (FamilyBudget fallback). Config is read once
  at startup — restart opencode after editing it.
- **Git.** SSH key at `~/.ssh/id_ed25519`; the auto-commit + push in
  `init`/`update` works over SSH from WSL. Do not deploy WSL targets with the
  Windows checkout's CLI.
