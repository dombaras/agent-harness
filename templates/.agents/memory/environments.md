# Environments — {{PROJECT_NAME}}

The canonical registry of the three environments: **development** → **User
Acceptance (uat)** → **production**. Read this at session start; keep it current
whenever you add or change a deploy target, database, or seed command. The
Definition-of-Done "deploy to UAT" step and the `devops-engineer` persona read it.

## The invariant (non-negotiable)

Only three things move **forward** (dev → uat → prod): **code**, **schema
migrations** (`prisma migrate deploy`), and **idempotent seed scripts**. **Data
never does** — no `pg_dump` / restore / copy of one environment's database into
another. Each environment owns its database.

- `development` is **dirty by design** — QA/test data lives and dies here.
- `uat` and `production` are **enforced clean** — idempotent seed only, no test data.

## Registry

| Env | App URL | DB env var | Deploy command | Seed command | Owner |
|---|---|---|---|---|---|
| development | (local) | `DATABASE_URL` | — | `npm run db:seed` | dev |
| uat | — | `DATABASE_URL_UAT` | `npm run deploy:uat` | `npm run db:seed -- --env uat` | dev |
| production | — | `DATABASE_URL_PROD` | `npm run deploy:prod` | — | human-gated |

Fill every `—` with the real value for this project. Update this table whenever a
URL, database, deploy command, or seed command changes.

## Forward-boundary check

`test:data-hygiene` scans a target database for test-data markers. It is the
mechanical guard that keeps test data from leaking forward:

- `npm run test:data-hygiene` → scans dev, **warns only** (dev is dirty by design).
- `npm run test:data-hygiene -- --env uat` / `-- --env prod` → **fails** on any marker.
