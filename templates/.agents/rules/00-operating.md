# {{PROJECT_NAME}} Operating Rules (summary)

Always in effect. Full detail lives in `.agents/AGENTS.md`; read it before non-trivial work.

## Step Zero — subagent dispatch gate (non-negotiable)

Before reading or editing any file for a task, dispatch the relevant personas via the `task` tool — each runs on its own `model:` (`.opencode/agents/<name>.md`). Keep only coordination/mechanical work (reads, git, commits) on the main model.

- **Bound every task before dispatching.** No persona gets a bare metric ("get under N lines", "type everything"). Each dispatch prompt carries a task spec: `Objective` (one deliverable) → `Owned files` (exact paths) → `Read-only files` → `Shared contracts (owns|consumes)` → `Done = <gate command + observable metric>` → `Out-of-scope`.
- **Parallel = disjoint.** Dispatch two personas in parallel only when their owned files AND shared contracts are disjoint; otherwise serialize and put the shared-contract owner first.
- **Accept, don't trust.** After a code persona reports done, the orchestrator re-runs the gate itself (`tsc --noEmit`, `lint:hooks`, `test:quick`) and greps the metric before integrating — a subagent's `Evidence` is a claim, not proof.
- **QA planning is never optional.** Every change touching code paths gets a QA plan (coverage map in `.agents/memory/qa-plan.md`) from `qa-architect`; if it isn't dispatched, the main orchestrator plans in its place. `npm run test:qa-plan` fails on any changed code path with no covering assertion or waiver, and on any touched flow (`.agents/memory/flow-map.md`) whose sibling surfaces / declared variants the plan doesn't address.
- Persona map, waivers, and the dispatch-failure ladder: `.agents/AGENTS.md` §5 and `.agents/memory/model-routing.md`.
- **Features**: capture a found item as one light row in `.agents/features/INDEX.md`; on pickup dispatch `features` to author the per-feature doc chain (`.agents/skills/features/SKILL.md`). Right-size ceremony to risk.
- Every subagent returns the output contract (`Result` → `Evidence` → `Deferred & risks`).
- Wrap up with a **dispatch log** (`subagent → model → shipped/deferred`) in `.agents/memory/handoff.md`.

## Non-negotiable laws

1. **Zero speculation** — base every fix/decision on observed logs, telemetry, or DB state; instrument first if evidence is missing.
2. **No hardcoded mocks/fallback data** — prefer dynamic queries and database-backed settings.
3. **5 UI states** (ideal/empty/loading/error/partial), user-visible errors (never `console.warn`-only), and RTL-safe logical props.
4. **Verify stack versions** before writing framework code (`.agents/memory/stack-versions.md`).
5. **Token discipline** — search before read, targeted reads, batch reads, don't re-read unchanged files, right-size QA.
6. **Static ≠ runtime** — never declare verified from `tsc` alone; execute a real runtime/API path that exercises the MODIFIED code — a tier label never proves coverage. `test:qa-plan` gates every changed code path to a covering assertion or waiver, and every touched flow's sibling surfaces / variants to an audit entry (`.agents/memory/flow-map.md` — "fix one, fix all").
7. **Commit** with `feat:`/`fix:`/`refactor:` then push to main.

## Definition of Done

Right-sized QA tier → security lens (if the change touches data/auth/input/secrets) → commit → push.

## Session checklist

Start: read `.agents/memory/locations.md` + `.agents/memory/model-routing.md`. End: record the dispatch log and update the handoff memory.
