# Project Rules & Operating Guidelines

## 1. Fact-Based, Zero-Guessing SDLC (Strict Operating Law Across All Roles & Personas)
- **Zero-Speculation Rule**: NEVER guess, hypothesize without evidence, or assume the root cause of an error, performance lag, or system behavior. Speculation is strictly forbidden across all personas and workflow stages.
- **Evidence-First Engineering**: Every diagnostic conclusion, bug fix, architectural decision, and feature enhancement MUST be grounded in observable facts: live server logs, telemetry traces (`/api/debug/logs`, `scratch/mobile-debug.log`), database records (`ExternalServiceLog`, Prisma queries), or verified runtime execution.
- **Mandatory Telemetry Before Fixes**: If logs or telemetry are absent or insufficient to isolate the root cause, you MUST FIRST add structured logging/instrumentation, execute or have the user reproduce, inspect the resulting log file, and ONLY THEN implement the solution based on the captured data.
- **Authentic Runtime Execution**: NEVER substitute real application runtime calls with ad-hoc external test scripts that might bypass actual configurations, environment variables, middleware, or request pipelines. Always test and verify behavior using the actual APIs and functions the application uses.
- **Scientific Progression Gate**: A fix is NEVER complete until live logs or automated runtime tests explicitly demonstrate the bug is eliminated and that the failure mode no longer occurs in real runtime conditions.

## 2. Dynamic Data & Business Logic Integrity
- **No Hardcoded Mock Lists**: NEVER create hardcoded lists (e.g. fake records, mock reviews, static fallback arrays) without explicit user approval. Always prefer dynamic database queries and database-backed system settings (`SystemSetting`).

## 3. UI, Mobile Ergonomics & RTL Support
- **Zero Native Popups**: NEVER use `Alert.alert()`, `alert()`, `confirm()`, or `prompt()`. Replace all dialogs with inline toast notifications, bottom sheets, inline state transitions, or haptic feedback.
- **Progressive Hydration & Cold-Start**: Never render empty dashboard/hub states while waiting for asynchronous auth/community sync. Always use local cache hydration (`AsyncStorage` / SQLite) so UI renders immediately without blank loading lags.
- **The 5 Essential UI States**: Every screen and list component must explicitly handle: Ideal State, Empty State (with onboarding CTA), Loading Skeleton, Error State (with retry action), and Partial/Single-item State.
- **Error Handling Contract (Mobile)**: Every `catch` block in a React Native screen MUST:
  1. Trigger `Haptics.notificationAsync(NotificationFeedbackType.Error)` for tactile feedback.
  2. Set a user-visible error state variable (e.g., `setActionError('Failed to approve loan')`) that renders an inline error banner or toast — NOT just `console.warn`.
  3. Include a retry mechanism (re-call the failed function) or a clear dismissal path.
  - `console.warn` alone is NEVER acceptable as error handling in production code. It is invisible to the user.
  - **Reference pattern** (use this exact structure in every async action handler):
    ```typescript
    try {
      await api.someAction(userId, ...args);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await refreshSync();
    } catch (err: any) {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setActionError(err?.message || t('errors.genericRetry'));
      // Error banner auto-renders via actionError state
    }
    ```
- **Cross-Screen Consistency Rule**: Whenever you implement a UX pattern in one screen (error handling shape, haptic feedback, loading skeleton, animation style, empty state CTA), you MUST:
  1. Grep for all other screens that have analogous patterns (e.g., all `catch` blocks, all `isLoading` states, all empty-list branches).
  2. Apply the same pattern globally if it's missing or inconsistent.
  3. If the scope is too large for the current session, explicitly log it as a deferred item in the handoff with the exact files and patterns that need alignment.
  - **The "Fix One, Fix All" mandate**: A local fix applied to one screen but not others is a regression-in-waiting. If you fix an error handler in `transactions.tsx`, check `shelf.tsx`, `index.tsx`, `discover.tsx`, `community.tsx`, and `scan.tsx` for the same issue.
- **Bidirectional & RTL Support**:
  - Always use logical Tailwind / CSS properties (`ps-*`, `pe-*`, `ms-*`, `me-*`, `text-start`, `text-end`) instead of physical ones (`pl-*`, `pr-*`, `ml-*`, `mr-*`, `left-*`, `right-*`).
  - In React Native RTL mode, use inverted horizontal lists (`inverted={isRTL}`) or direction-aware flex layouts so items begin on the right in Hebrew and left in English.
  - Pass dynamic `dir={isRTL ? "rtl" : "ltr"}` to all Radix UI and shadcn primitives.
- **Physical Paradigm Alignment & Legacy Pruning Rule**:
  - Whenever introducing or refactoring a flow, model, or paradigm (e.g. async drop-off vs in-person handoff, neighbor trust vs stranger marketplace), you MUST explicitly audit existing steps and PRUNE legacy mechanisms that create contradictory friction with the new flow. Never bolt new features on top of obsolete verification steps without removing what they replace.
  - Every transaction or physical interaction flow MUST be traced step-by-step through a literal physical walkthrough from both actors' perspectives to ensure zero unnecessary friction gates (such as PINs, redundant codes, or mandatory face-to-face requirements).

## 4. Framework & Backend Architecture
- **Verify Stack Versions First**: Before writing framework-specific code, confirm versions in `package.json` / `mobile/package.json` against `.agents/memory/stack-versions.md`. Never assume a newer/older framework convention; read the relevant guide in `node_modules/next/dist/docs/` (or the equivalent).
- **Async Route Params**: Dynamic route params in the App Router (`page.tsx`, `route.ts`) are Promises: always use `const { id } = await params;`.
- **Framer Motion Types**: Always import `Variants` from `framer-motion` to avoid TypeScript build failures.
- **Privacy & Visibility Tiers**: Enforce the project's visibility/privacy tier model (see `.agents/memory/domain-map.md` §Visibility tiers) across all data-access endpoints.

## 5. Token Efficiency & Workflow Discipline
- **When NOT to Plan**: Do not generate heavy `implementation_plan.md` planning ceremonies for simple bug fixes, CSS/layout tweaks, single-file adjustments, or minor follow-ups. Execute directly to conserve tokens.
- **Precise File Inspections**: Avoid reading whole 800+ line files. Use `grep_search` with line numbers to locate the relevant region, then `read_file` with targeted line ranges.
- **Search Before Reading**: For questions about code, search first (`grep_search` / `file_search`) rather than opening files blind. Batch multiple independent searches/reads in parallel in a single turn.
- **Don't Re-read Unchanged Files**: If a file's content is already in context, edit it directly; only re-read the specific lines you need if context is stale.
- **Delegate Big Searches**: For broad, multi-file exploration ("where is X used?", "find all callers of Y"), use the `Explore` subagent instead of many manual search+read round-trips in the main conversation.
- **Prefer Memory over Re-derivation**: Persist non-obvious facts to `.agents/memory/` (stack versions, gotchas, handoff state) so future sessions never re-discover them. Read relevant memory files before starting.
- **Locations Map (read first)**: Before starting, read `.agents/memory/locations.md` — the canonical index of where sessions, logs, docs, and data live. Never re-hunt for a planning doc or a log path; it is (or should be) recorded there.
- **Subagent & Model Routing (Step Zero — non-negotiable)**: Before reading/editing any file for a task, satisfy the dispatch gate in `.agents/rules/00-operating.md` (§"Step Zero"). Personas: `planner`, `frontend-engineer`, `mobile-engineer`, `ui-designer`, `qa-architect`, `qa-runner`, `security-engineer`, `product-manager`, `system-architect`, `diagnostics-expert`, `data-engineer`, `devops-engineer`, `handoff`. Dispatch via the `task` tool — each runs on its own `model:` from `.opencode/agents/<name>.md`. Do NOT gather deep context inline first, and do NOT inline persona-owned work on the main conversation model; use the `skill` tool only for instruction-only context. Read `.agents/memory/model-routing.md` at session start for persona→model tiers. Dispatch **independent** subagents in **parallel**; serialize only on dependencies.
- **Synchronous Terminal Commands**: Prefer sync one-shot terminal commands (build, test, lint) that return output inline, rather than background servers/watchers, unless the process must keep running.
- **No Output Bloat**: Never paste large files or diffs into chat unless asked. Never print a code block of a change — apply the edit with the edit tool instead.
- **Right-Size the QA Tier**: Never run the full regression suite for a CSS/copy tweak — pick the minimal QA tier (see §6).

## 6. Smart Tiered Testing & Progression Protocol (QA Architect + QA Runner)
- NEVER run full heavy regression suites blindly for small changes.
- Adopt the split QA personas: `qa-architect` (`.agents/skills/qa-architect/SKILL.md`) inspects the diff, audits testing gaps, selects the right-sized test plan, and authors progression tests; `qa-runner` (`.agents/skills/qa-runner/SKILL.md`) executes the chosen tier and reports pass/fail — the thinker never runs, the doer never designs:
  - **The "Static ≠ Runtime" Rule**: Never declare UI, Mobile, or API changes verified based solely on static typing (`tsc`). Always execute live headless rendering or HTTP routes.
  - **Tier 1 (UI, CSS, Mobile, Copy)**: Run `npm run test:quick` (Types + Translation Parity + Mobile Headless Component Smoke in ~3s).
  - **Tier 2 (Route / Web Page layout)**: Run `npm run test:routes` or `node scripts/verify-all.js --route=<path>` (Web route render in ~4s).
  - **Tier 3 (API, Prisma, Transactions)**: Run `npm run test:api` (API edge cases & governance in ~6s).
  - **Tier 4 (Data Ingestion)**: Run `npx ts-node scripts/test-catalog.ts` (100-record E2E simulation).
  - **Tier 5 (Major Release / Breaking Refactor)**: Run `npm run test:verify` (Full regression).
  - **Tier 6 (Security / Dependencies)**: Run `npm run test:security` (`npm audit --audit-level=high`).
- **Progression Testing Workflow**: When introducing new routes, API endpoints, or database states:
  1. Author dedicated assertion pathways for the new feature in `scripts/verify-all.js`.
  2. Execute the targeted progression test to verify happy path and error boundaries.
  3. Graduate the new test into the permanent regression suite.

## 7. Definition of Done & Continuous GitHub Backup
Every completed task MUST pass this gate, in order:
0. **Feature Completeness Gate** — before running QA, verify the change against this checklist:
   - [ ] **5 UI States**: Does every affected screen/component handle Ideal, Empty (with CTA), Loading (skeleton), Error (user-visible + retry), and Partial states? List each state explicitly.
   - [ ] **Error handling**: Are there any `catch` blocks that only `console.warn`/`console.error` without user-facing feedback? (Zero tolerance — every catch must have haptic + visible error state.)
   - [ ] **Haptic consistency**: Does every user-initiated action (button press, swipe, submit) produce haptic feedback (success or error)?
   - [ ] **RTL verification**: If the change touches layout, has it been mentally traced through the project's RTL mode? Are all spacing/alignment properties logical (`ps-*`, `ms-*`, `text-start`)?
   - [ ] **Cross-screen audit**: If you introduced a new UX pattern (e.g., a new error banner style, a new loading skeleton, a new action handler shape), grep for all similar patterns across other screens and apply consistently.
   - [ ] **File size check**: If the modified file exceeds 500 lines, extract new or modified sections into separate component files before committing.
1. **QA tier** — have `qa-architect` pick the right-sized tier (and author any progression tests), then `qa-runner` execute it and make it pass (§6).
2. **Security check** — if the change touches data access, input, auth, external services, or secrets, apply the `security-engineer` skill and run `npm run test:security` when dependencies changed.
3. **Commit** — stage changes, commit with a concise descriptive message (`feat:`, `fix:`, `refactor:`).
4. **Push** — `git push origin main`.
- **Mechanical floor**: a git `pre-push` hook (husky) automatically runs `npm run test:quick` on every push — keep it green.
- **Lean permissions**: grant only the narrowest `git`/`gh` action needed; ask for escalated permission only after a command has actually failed — never preemptively.
- Git may not be on PATH in the default shell; use the full path to `git.exe` (see `.agents/memory/locations.md`).

## 8. Session & Traceability Discipline
- **One session = one coherent task**. Do not bundle unrelated work into a single session; keep a short task checklist as the single source of truth.
- **Planned vs. Shipped**: At the end of each session, record a one-line "planned → shipped → deferred" delta so future agents can tell aspirational design docs from implemented reality. Never treat old planning docs as ground truth — always verify against the live code and the DB schema.
- **Dispatch Log (mandatory)**: Every session wrap-up MUST open with a dispatch log — `subagent → model → shipped/deferred`. An empty log is a non-compliant session (Step Zero gate was skipped).
- **Persist Continuity**: At session end, use the `handoff` skill to update `.agents/memory/handoff.md`. Project history lives in `.agents/memory/antigravity-history.md`; stack facts in `.agents/memory/stack-versions.md`.
- **Pointers Map Hygiene**: Whenever you create, discover, or change an important location during a session — a new external AI session archive, a scratch script, a log file, a doc, a DB target, an env file — you MUST record it in `.agents/memory/locations.md` so it never becomes unfindable. Each agent front-end records its own session/log paths. The `handoff` skill's pointer step enforces this at session end.
