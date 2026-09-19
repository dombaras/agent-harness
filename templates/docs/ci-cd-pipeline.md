# CI/CD pipeline — {{PROJECT_NAME}}

The integration model: **the remote is the integration point, CI is the
gatekeeper, a serialized merge train lands changes, and CI deploys the merged
commit.** A working session never pushes to `main` and never deploys from its own
checkout.

```
agent worktree (branch)
   │  commit
   │  npm run ship   (rebase on origin/main, branch gates, push, PR, landing label, watch)
   ▼
PR labeled `merge-train`
   ▼
CI (.github/workflows/ci.yml)                         required check
   ▼
merge train (.github/workflows/merge-train.yml)       one PR at a time, re-checked vs current main
   ▼
push to main
   ▼
deploy (.github/workflows/deploy-uat.yml)             immutable SHA -> prebuilt artifact -> UAT + hygiene
   ▼
UAT health (.github/workflows/uat-health.yml)         scheduled probe
```

## What each piece owns

- **`ci.yml`** — the required check. A PR with no CI check can never be picked by
  the train. Extend the `static` job with the harness process gates once the
  harness is CI-installable; enable the DB-backed `runtime` job with repository
  variable `CI_RUNTIME=true`.
- **`merge-train.yml`** — enters by the `merge-train` label, lands the oldest
  all-green mergeable PR, re-checks it against current `main`, squash-merges, and
  dispatches the downstream CI + UAT deploy (GITHUB_TOKEN merges emit no push
  event). Set secret `MERGE_TRAIN_TOKEN` (a PAT) for instant push-triggered
  draining.
- **`deploy-uat.yml`** — `npm run deploy:uat` with `DEPLOY_CI=1`: link from
  `VERCEL_ORG_ID`/`VERCEL_PROJECT_ID`, build once (`vercel build`), ship the
  prebuilt artifact, migrate, seed, alias + commit-parity verify, smoke, hygiene.
  **Fail-closed once configured:** set repository variable
  `UAT_DEPLOY_CONFIGURED=true` and the required secrets; from then on a missing
  secret is a red failure, not a silent skip.
- **`uat-health.yml`** — scheduled probe of `$UAT_ALIAS`; set repository variable
  `UAT_ALIAS`.

## One-time setup (human-gated)

1. Keep the Vercel Git integration **disconnected** — CLI/CI is the single deploy
   path. Create a token and read `orgId`/`projectId` from `.vercel/project.json`.
2. Repository secrets: `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`,
   `DATABASE_URL_UAT` (optional `DATABASE_URL_UAT_DIRECT`, `MERGE_TRAIN_TOKEN`).
3. Repository variables: `UAT_DEPLOY_CONFIGURED=true`, `UAT_ALIAS`,
   `CI_RUNTIME=true` (when the runtime job is validated).
4. Branch protection on `main` (where the plan supports it): require the CI check
   and "branches up to date before merging", and disallow direct pushes. Without
   branch protection the local `pre-push` `check-push-refs` guard is the floor.
5. Fill in `.agents/memory/environments.md` with the real dev/uat/prod registry.

## Rollback

Re-deploy a known-good SHA through the same workflow:

```bash
gh workflow run deploy-uat.yml --ref main -f ref=<previous-good-sha>
```

The local `npm run deploy:uat` (with `DEPLOY_CI` unset, from the linked main
checkout) is the emergency path only.
