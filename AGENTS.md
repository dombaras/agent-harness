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
