# {{PROJECT_NAME}} Operating Rules

These rules apply to the entire repository. They are enforced across all agent
front-ends (VS Code Copilot, Claude Code, Zoo Code, Antigravity).

## Step Zero — Subagent dispatch gate (NON-NEGOTIABLE)

Before reading or editing any file for a task, STOP and dispatch:

1. Decompose the task and identify which personas it touches using the mapping below (lookup, not judgment). For non-trivial tasks, dispatch `planner` first to emit the dispatch plan.
2. Dispatch each persona via the `task` tool — the subagent runs on its own `model:` from `.opencode/agents/<name>.md`.
3. Dispatch **independent** subagents in **parallel** (one message, multiple `task` calls); serialize only when one depends on another's output.
4. Keep only coordination/mechanical work (git, commits, reads, final integration) on the main model.

Do NOT gather deep context inline first — that is exactly what causes the "might as well finish inline" collapse. Skipping dispatch is a rules violation, not a style preference.

> **Waivers (the ONLY way to skip a persona — explicit and recordable):** A persona may be skipped ONLY when the change is (a) fully covered by an automated gate that runs on push or in the QA tiers (`lint:hooks`, `test:schema`, `test:dispatch`, `test:governance`, `test:security`, or a peer `test:*`), AND (b) the skip was pre-audited in `.agents/memory/` with a cited pointer. Any other skip is a HIGH-severity rules violation. Every waiver MUST be written into the wrap-up dispatch log as `waived: <persona>` with `reason: <gate or pointer>`.
>
> **Dispatch failure ladder (never silent):** if a `task` dispatch fails, (1) retry the same task once (resume the same `task_id`); (2) if it still fails, degrade by doing the persona work inline on the main model AND log `degraded: <persona> model: <failure>` in the wrap-up dispatch log; (3) never silently re-scope or skip. Mirror in `.agents/memory/model-routing.md` §"Dispatch failure ladder".

Every subagent must return the **output contract** (`result` → `evidence` → `deferred & risks`); see `.agents/memory/model-routing.md`.

| Work area | Persona subagent |
|---|---|
| Task decomposition → dispatch plan | `planner` |
| Web app code (React / Next.js / Tailwind / shadcn) | `frontend-engineer` |
| Mobile native (Expo / React Native) | `mobile-engineer` |
| Design system / tokens / shared components | `ui-designer` |
| QA strategy (risk + tier + progression tests) | `qa-architect` |
| QA execution (run tiers, catalog E2E, data cleanup) | `qa-runner` |
| DB schema / data model / tenancy / sync protocol | `system-architect` |
| Auth, secrets, input validation, external services, deps | `security-engineer` |
| Error / performance / API debugging | `diagnostics-expert` |
| Features, gamification, product journeys | `product-manager` |
| Data/catalog ingestion / entity resolution | `data-engineer` |
| Deployment / cron / secrets / build & release | `devops-engineer` |
| Session wrap-up / handoff | `handoff` |

Every session wrap-up MUST open with a **dispatch log** — `subagent → model → shipped/deferred`. An empty log is a non-compliant session.

## 1. Fact-Based, Zero-Guessing SDLC — Evidence Over Speculation
- NEVER speculate, guess, or assume the root cause of an error or system behavior across any persona.
- Inspect live logs, telemetry (debug-log endpoints, mobile debug logs), structured telemetry records (e.g. `ExternalServiceLog`), or database state before proposing fixes.
- If logs/telemetry are insufficient, FIRST add structured instrumentation, run it, reproduce, capture actual data, and base the fix exclusively on observed facts.
- Verify against the real application runtime — never ad-hoc scripts that bypass real config/middleware.

## 2. Data & business-logic integrity
- NEVER create hardcoded mock lists or fake data (records, reviews, fallback arrays) without explicit approval.
- Prefer dynamic database queries and database-backed `SystemSetting` values.

## 3. UI, mobile ergonomics, RTL & flow alignment
- NEVER use `Alert.alert()`, `alert()`, `confirm()`, or `prompt()`. Use toasts, bottom sheets, or inline states.
- Hydrate from local cache (AsyncStorage / SQLite) so the UI never renders blank loading states.
- Handle the 5 UI states: ideal, empty (with CTA), loading, error (with retry), partial/single-item.
- Use logical CSS/props (`ps-*`, `ms-*`, `text-start`), never physical (`pl-*`, `left-*`).
- In React Native RTL, use inverted horizontal lists and direction-aware flex.
- **Legacy Pruning & Physical Roleplay Rule**: When refactoring or introducing a new flow/paradigm (e.g. async drop-off vs in-person handoff), ALWAYS audit and prune contradictory legacy friction steps (e.g. PINs, redundant codes) and roleplay the physical real-world user journey step-by-step.

## 4. Stack — verify versions first
- Never assume framework versions from memory. Read `.agents/memory/stack-versions.md` (the project-specific version manifest) before writing framework code.
- Read the relevant framework guide shipped in `node_modules/<framework>/dist/docs/` (if present) before writing against it; heed deprecation notices.
- Framework-specific gotchas (e.g. async route params, strict typing) live in the `frontend-engineer` / `mobile-engineer` skills.

## 5. Token & workflow discipline
- No heavy planning docs for simple fixes.
- Search before reading; use targeted line reads; batch independent searches/reads.
- Delegate broad searches; persist non-obvious facts to `.agents/memory/`.
- **Subagent & model routing**: Satisfy the **Step Zero dispatch gate** (top of this file) before touching any code. Read `.agents/memory/model-routing.md` at session start for the persona→concrete-model tiers. Do NOT inline persona-owned work in the main conversation; load a persona via the `skill` tool only for instruction-only context.

## 6. Testing — right-sized QA tier & Static ≠ Runtime rule
- Never declare code verified based solely on static typing (`tsc`); always execute runtime component or API pathways.
- Tier 1: `npm run test:quick` (Types + Translations + Mobile Headless Render Smoke in ~3s) · Tier 2: `npm run test:routes` · Tier 3: `npm run test:api` · Tier 5: `npm run test:verify` · Tier 6: `npm run test:security`.
- Audit testing gaps per subsystem and graduate progression tests into the permanent regression suite.

## 7. Definition of Done
1. Run the right-sized QA tier and make it pass.
2. Apply the security lens when the change touches data, auth, input, or secrets.
3. Commit with a concise `feat:` / `fix:` / `refactor:` message.
4. Push to `main` (the pre-push hook runs `npm run test:quick`).

## 8. Session discipline
- One session = one coherent task.
- At the end, record a planned → shipped → deferred delta (see `.agents/skills/handoff/SKILL.md`).
- Every wrap-up MUST open with the **dispatch log** (`subagent → model → shipped/deferred`). Empty log = non-compliant session.
- Read `.agents/memory/locations.md` at session start (canonical map of sessions, logs, docs, data). Update it at session end with any new/changed locations (external session archives, scratch scripts, log files, DB targets), so each front-end's data stays discoverable.
