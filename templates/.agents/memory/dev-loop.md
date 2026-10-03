# Dev loop — {{PROJECT_NAME}}

The **project-owned** half of the `dev-loop` skill (load it with the `skill`
tool → `dev-loop`). It answers one question so no session re-derives it: *how do
I run, verify, seed, boot, and debug something in THIS project?* The skill is the
universal loop (`gates`, `serve.js`, `orient`/`where`, "read the failing gate");
this file is the concrete commands.

`orient` digests this file at session start. Keep it current whenever a command,
port, tier, or seed changes — this file is **create-if-missing**, so the harness
never overwrites your edits. Fill every `—`/`(fill in)` cell.

## Test tiers (cheapest that exercises the change first)

| Tier | Scope | Command |
|---|---|---|
| 1 | types + unit/smoke | `npm run test:quick` |
| 2 | routes / page render | `npm run test:routes` |
| 3 | API / ORM / transactions | `npm run test:api` |
| 5 | full regression | `npm run test:verify` |
| 6 | security / deps | `npm run test:security` |

**Single test** (iterate without running a whole tier):

- TS/tsx suite: `npx tsx --test scripts/qa/tests/<name>.test.ts`
- node:test suite: `node --test scripts/qa/tests/<name>.test.js`

## Dev server

- Start: `node scripts/serve.js start --cmd "npm run dev" --url http://localhost:3000`
- Stop: `node scripts/serve.js stop --name dev`
- Health URL / port: `http://localhost:3000` (fill in)

## Data (development only — never uat/prod)

- Seed: `npm run db:seed`
- Reset / clean test data after a live run: `—` (project cleanup script)

## Mobile / device (delete this section if there is no native app)

- Reset harness/app data: `npm run mobile-e2e:reset`
- Boot the device tier (adb + emulator + APK + dev server, idempotent):
  `bash scripts/qa/mobile-e2e/device-up.sh`
- Device tier config: `scripts/qa/mobile-e2e/local.json`
- Tear down: `bash scripts/qa/mobile-e2e/device-down.sh`

## Nightly E2E (off-hours full battery)

- Orchestrator: `npm run nightly -- run` (config: `.agents/nightly.json`).
- Install/status: `agent-harness install-nightly --target .` / `bash scripts/setup-nightly.sh status`
- Read the last cycle: `npm run report:nightly` (or `node scripts/nightly.js report`).
- Default phases: `—` (see `.agents/nightly.json`; the device/Maestro tier runs
  here, never in the day loop — the day loop covers device paths via the
  `audited: device tier deferred to nightly` plan entry).

## Debug / logs

- Log endpoints / files: `—` (fill in)
- DB introspection: `—` (e.g. the project's psql / prisma studio / MCP route)
