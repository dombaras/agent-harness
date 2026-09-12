# agent-harness — repo workflow

Standing workflow for every change to the harness (`bin/`, `templates/`,
`docs/`, tests):

1. Bump `package.json` version (the version-bump test enforces this).
2. `npm run lint` and `npm test` must both be green.
3. Commit + push to `main` with a `feat:`/`fix:` message ending in `(0.1.x)`.
4. Deploy to the active projects from this local checkout (always after harness changes):

   ```powershell
   node C:\develop\agent-harness\bin\agent-harness.js update --target C:\develop\PublicVirtualLibrary
   node C:\develop\agent-harness\bin\agent-harness.js update --target C:\develop\FamilyBudget
   ```

Active projects: **LibraryOS** at `C:\develop\PublicVirtualLibrary` and
**FamilyBudget** at `C:\develop\FamilyBudget`. Publishing to npm is optional and
done on the user's side — the local-checkout updates above are the authoritative
way to push harness changes to both projects.
