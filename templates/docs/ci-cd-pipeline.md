# CI/CD pipeline — {{PROJECT_NAME}}

The integration model: **a session lands its gated feature branch directly on
`main` with a fast-forward push; CI gates the landed SHA; the deploy runs only
after CI is green.** There is no pull request, no landing label, and no merge
train — the cycle is deliberately synchronous and simple. A session waits for CI
on the SHA it just landed and is done; the deploy follows automatically.

```
agent worktree (branch)
   │  commit
   │  npm run ship   (rebase on origin/main, branch gates, git push HEAD:main, wait for CI)
   ▼
CI (.github/workflows/ci.yml)                         gates the landed SHA
   ▼
deploy (.github/workflows/deploy-uat.yml)             after CI success: immutable SHA -> prebuilt artifact -> UAT + hygiene
   ▼
UAT health (.github/workflows/uat-health.yml)         scheduled probe
```

A concurrent landing (two sessions pushing around the same time) is normal git
contention: the second `git push HEAD:main` is rejected non-fast-forward, and
`ship` re-fetches, rebases, and retries automatically. The per-feature worktree
(`backlog worktree <id>`) is what keeps two sessions from sharing a checkout.

## What each piece owns

- **`ci.yml`** — the gate on `main`. Runs on every push to `main` (and on a pull
  request if one is ever opened). Extend the `static` job with the harness process
  gates once the harness is CI-installable; enable the DB-backed `runtime` job
  with repository variable `CI_RUNTIME=true`.
- **`deploy-uat.yml`** — triggered by the `CI` workflow completing **successfully**
  on `main` (and by manual dispatch of any ref for rollback). Runs
  `npm run deploy:uat` with `DEPLOY_CI=1`: link from
  `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`, build once (`vercel build`), ship the
  prebuilt artifact, migrate, seed, alias + commit-parity verify, smoke, hygiene.
  **Fail-closed once configured:** set repository variable
  `UAT_DEPLOY_CONFIGURED=true` and the required secrets; from then on a missing
  secret is a red failure, not a silent skip.
- **`uat-health.yml`** — scheduled probe of `$UAT_ALIAS`; set repository variable
  `UAT_ALIAS`.
- **`nightly.yml`** — scheduled off-hours E2E (unit/API/routes/browser). The
  heavy device/Maestro tier runs locally via `agent-harness install-nightly`
  (see `docs/nightly-testing.md`); nightly is also where the board is reconciled
  (`reopen` a fix that is still failing, validate one that now passes).

## One-time setup (human-gated)

1. Keep the Vercel Git integration **disconnected** — CLI/CI is the single deploy
   path. Create a token and read `orgId`/`projectId` from `.vercel/project.json`.
2. Repository secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`,
   `DATABASE_URL_UAT` (optional `DATABASE_URL_UAT_DIRECT`).
3. Repository variables: `UAT_DEPLOY_CONFIGURED=true`, `UAT_ALIAS`,
   `CI_RUNTIME=true` (when the runtime job is validated).
4. Branch protection on `main` (where the plan supports it): allow direct pushes
   (or exempt the landing account), and require the CI check. The harness lands by
   pushing `HEAD:main`, so a rule that forbids direct pushes will reject it.
5. Fill in `.agents/memory/environments.md` with the real dev/uat/prod registry.

## Rollback

Re-deploy a known-good SHA through the same workflow:

```bash
gh workflow run deploy-uat.yml --ref main -f ref=<previous-good-sha>
```

The local `npm run deploy:uat` (with `DEPLOY_CI` unset, from the linked main
checkout) is the emergency path only.
