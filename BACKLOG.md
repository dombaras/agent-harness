# BACKLOG — canonical task list

Single source of truth for **all** open work: features, bugs, follow-ups, audits,
roadmaps, ideas. Every other list (`.agents/features/INDEX.md`,
`.agents/memory/todo.md`, historical docs) points here. One row per task — if it's
not a row, it doesn't exist.

**Status ladder:** `backlog → ready → in-progress → testing → shipped → archived`,
plus `frozen` (parked — keep a *why* and a *reopen condition*, never delete).
The board maps status to section: `backlog`/`ready` → **Open**,
`in-progress`/`testing` → **In progress** (active work), `shipped`/`archived` →
**Archive**, `frozen` → **Frozen**. A **Queued** row is a ready-to-pull lane:
`backlog queue <id>` allocates an `Open` row into it, and `/next` (or
`backlog next --take`) pulls the top-priority Queued row into `In progress`.
**Priority (`P`):** `P1` blocking · `P2` important · `P3` nice-to-have · `P4` later.
Priority applies to open/queued rows only. **Evidence** = a pointer
(file/log/ticket/words), never a re-derivation. **Epic** = a declared `## Epics`
key (or `?` when unassigned). **Depends on** = comma-separated row IDs that must
be archived before this row is picked up (`?` when none); `/next`/`take`/`worktree`
skip or refuse a row whose dependencies aren't archived. Leave `?` where unknown —
don't invent.

> Updated in the same session the work happens. Pick up a row by moving it
> `Open`/`Queued` → `In progress`; archive `shipped` rows; freeze don't-delete.
> Historical design docs are aspirational — verify against live code.

## Epics

Group work into logical containers. Declare an epic here (`Key` / `Label` / `Goal`),
then set a row's `Epic` cell to the key — or leave `?` when unassigned. Editable
in-file; no code change needed.

| Key | Label | Goal |
|---|---|---|
| inquiry-capability | Inquiry capability | Reliable root-cause discovery, independent falsification, outcome-based done, and attempt memory for future work. |
| context-economy | Context economy | Cut the repeated token cost of session orientation and state loading: static prefix, rulebook auto-injection, checkpoint size, and progressive disclosure for large state docs. |

## Active / next

- _the next few picks (optional): cite each as `ID (P)`._

## In progress

Active work — rows a session has picked up and is working on right now. Move a row
here from `Open`/`Queued` the moment a session starts dealing with it (cite the
session's handoff), and move it to `Archive (shipped · done)` when it ships — or
back to `Open` if it stalls.

| ID | Epic | Task | Handoff |
|---|---|---|---|
| F-050 | ? | Close the agentic SDLC loop: ingest CI/nightly/UAT/deploy failures, dedupe + classify, run bounded diagnose→fix→verify attempts, escalate with evidence, and record loop metrics/lessons. | .agents/handoffs/F-050.md (worktree: ../.worktrees/agent-harness/f-050; branch: f-050) |

_Rows: `| F-004 | epic-key | short desc | .agents/handoffs/F-004.md (or \`?\`) |`_

## Queued

Sorted by priority (P1 → P4). Ready-to-pull work allocated to a worker.

| ID | P | Epic | Task | Evidence | Depends on |
|----|---|------|------|----------|------------|
| | | | | | |

_Rows: `| F-005 | P2 | epic-key | short desc | pointer, never a re-derivation | F-004 |`_

## Open

Sorted by priority (P1 → P4).

| ID | P | Epic | Task | Evidence | Depends on |
|---|---|---|---|---|---|
| F-041 | P2 | ? | Prune the feature worktree automatically at task completion: after finalize archives the landed row and CI is green, remove the shipped worktree (or schedule worktree-prune) instead of printing "feature worktree left in place — clean up when this session ends". Never prune an unmerged or dirty worktree, or the session's own checkout; report what was kept and why. | F-040 finalize/ship output: "[ship] feature worktree left in place. Clean up when this session ends"; /home/ronen/develop/.worktrees/agent-harness/f-040 remains after a green-CI landing; scripts/ship.js tail; scripts/finalize.js archive step; docs: .agents/AGENTS.md §7.6 | ? |
| F-065 | P2 | ? | Harness update visibility must survive a TUI-only restart: (1) the footer badge drops ↻restart when the TUI process reloaded after the deploy, even though the shared service still runs the old build; (2) the global freshness plugin's 24h npm cache can publish a stale `latest`; (3) the startup sweep can overwrite another process's restart-needed verdict with `current`; (4) the update notice is async/one-shot and can miss the turn that triggered the update. Add regression coverage for the badge/service split, cross-process verdict ownership, and a fresh npm probe; make the notice deliverable on the triggering turn. | .agents/reviews/harness-update-notification/REPORT.md — timeline: npm 0.5.17 published 2026-11-27T10:40:06Z; LibraryOS auto-deployed 10:38:52Z; service pid 674454 started 10:21:16Z; TUI pid 697704 started 10:38:40Z; .serve/harness-freshness.json restart-needed (have 0.5.17, active 0.5.16); ~/.cache/opencode-agent-harness/npm-latest.json = 0.5.6 @ 2026-11-26T17:18:41Z; session ses_de369e001fferU7RwWPbn4gDt9 notice injected 10:38:58, turn aborted 10:39:10 | ? |
| F-055 | P3 | ? | Extend the TUI ESM-only graph guard to every plugin TUI entry (harness-version/tui.tsx too), not just context-resume | tests/context-resume.test.js::the TUI plugin graph is ESM-only lists only context-resume entries; templates/.opencode/plugins/harness-version/tui.tsx imports ./version.mjs (clean today) | ? |
| F-016 | P4 | ? | Document the 2.3.2 CLI/config additions the harness docs miss: `opencode plugin` (list/add/check/update/remove), `opencode stats` (--tools/--cost/--json), the top-level `plugins` config key, and the MCP server `protocol` field. | docs/opencode-v2.3-compat-scan.md §G4; `opencode plugin --help`; `opencode stats --help`; @opencode/schema@2.3.2 config.plugin | ? |
| F-017 | P4 | ? | Cross-check agent-report/store-lib against `opencode stats --json` as an independent oracle: the CLI now emits per-tool reliability + cost/token stats, so a parity assertion would catch store-shape drift the direct-DB reader silently misses. | docs/opencode-v2.3-compat-scan.md §G5; `opencode stats --help` | ? |

_Rows: `| F-001 | P3 | epic-key | short desc; open questions with \`?\` | pointer | ? |`_

## Frozen

Parked, not deleted. Reopen only when the stated condition recurs.

| ID | Epic | Task | Why frozen / reopen when |
|---|---|---|---|
| F-037 | ? | checkpoint resume/read resolve feature IDs case-insensitively (F-036.md exists but --feature f-036 reports no handoff on a case-sensitive FS; orient matches case-insensitively) | Absorbed into F-046 (the full /resume fix includes this narrower case-insensitive handoff lookup; F-046 also covers the write-duplication, single-root lookup, re-root step, and brief gating). — reopen when Reopen if F-046 is dropped or split and the case-only fix is still needed. |

_Rows: `| F-002 | epic-key | short desc | why + reopen condition (required) |`_

## Archive (shipped · done)

| ID | Epic | Task | Closed |
|---|---|---|---|
| F-001 | ? | Port LibraryOS's project-proven check-flows.js upstream: forwarded *TestID resolves at runtime; runFlow file: includes validated recursively | shipped 0.3.8 — 5d07aec, CI green (03f3013) |
| F-002 | ? | update: absorb or report pre-existing target modifications to harness-owned files whose content already matches the release (currently left uncommitted AND recorded in .harness.json, so the drift becomes invisible) | shipped |
| F-004 | ? | fix the completion pipeline: publishBoard aborts on the gitignored tracked `.agents/memory/owned-files.md` (git add without -f), backlog.js masks every publish failure as 'remote unreachable', worktree-prune treats finished sessions' pointers as live, and test:docs/test:backlog are not wired into CI | shipped |
| F-003 | ? | green the local process gates on main: test:docs flags a `...` link inside inline code (docs/opencode-v2-migration.md:245 `]({...}, ...)`) and a missing CHANGELOG entry for b68e1bc (fix(harness): commit root worktree-hygiene scripts); test:backlog flags templates/BACKLOG.md as a stray board (the template scaffold shipped to targets). Decide per item: teach the checker to ignore code spans / exempt templates, or fix the content. | subsumed by F-004 (landed 894bc3b): docs/backlog gate findings fixed + gates green |
| F-007 | ? | board: archive from a linked worktree must route an inherited OPEN row to main, never the worktree's snapshot | shipped |
| F-008 | ? | board sync: a behind-only fast-forward must proceed past unrelated tracked dirt; drop the accidentally tracked node_modules symlink | shipped 0.3.12 — 7049179, CI green: behind-only converge fast-forwards past unrelated tracked dirt; dropped the accidentally tracked node_modules symlink |
| F-009 | ? | Auto-deploy the harness to LibraryOS on every green CI run on main (deploy key + workflow) and fast-forward the local LibraryOS clone | shipped |
| F-010 | ? | Auto-tag version bumps on green main CI and dispatch the npm Release workflow (trusted publishing) | shipped |
| F-011 | ? | Pin the Release workflow to npm 11 (or move the upgrade after test:pack): npm@latest 12.x breaks test:pack with an empty `npm pack --json` array, failing auto-releases before publish | shipped |
| F-012 | ? | Harness version badge in the opencode TUI: ship a template TUI plugin (templates/.opencode/plugins/harness-version/) that renders the deployed `.harness.json` version in the home footer + session prompt footer status slots (beside opencode's own version / the model indicator), only in harness-provisioned repos. | shipped |
| F-005 | ? | Enable OpenCode V2 todowrite end-to-end: ship `experimental.todo: true` in `templates/opencode.json`; deep-merge `experimental` in `mergeOpencodeJson` so a project's other experimental keys survive; tighten the todo guard (require a `todowrite` update after every completed step, exactly ONE `in_progress`, suppress nudges when the flag is off); add `test:opencode-compat` (V2 version + config + deprecated-V1-key + plugin-hook check) wired into gates/doctor/update. | shipped |
| F-006 | ? | OpenCode V2 compatibility scan: audit every harness surface (plugin hooks/API, config keys, built-in tool names, CLI commands, store/telemetry, permissions/policies, MCP, skills/commands, worktrees, child-session behavior) against the OpenCode V2 docs + installed binary; produce a gap report and file each gap as a row. The `todowrite` miss is a known symptom. | shipped |
| F-013 | ? | Adopt managed `policies` hard-denies for credential paths and MCP gating: OpenCode 2.3.2 ships a real top-level `policies` key (hard allow/deny over provider.use/tool.use/mcp.use/skill.use/plugin.use/websearch.use); the harness still relies on overridable `permissions`, so a project allow can shadow a harness credential/MCP deny. | shipped 0.4.0 — 5e597ee, CI green (run 44923107044); 3204fbb landed CI-red and was fixed forward |
| F-018 | ? | Make the always-loaded AGENTS.md budget a pre-landing gate: wire test:prefix into ship/pre-push, give the file deliberate headroom, and document the trim-or-ask escalation path | shipped |
| F-014 | ? | Align guard/session tool classifiers with the OpenCode 2.3.2 built-in tool set (`todo`, `skill`, `question`, `webfetch`, `websearch`, `patch`, `artifact`, `automation`, `image-generate`): `EXEMPT_TOOLS` has `todowrite` but not `todo`, `MATERIAL_TOOLS` has no `skill`/`artifact`. Verify effective tool names first, then update classifiers + the drift-guard test. | shipped |
| F-015 | ? | Decide worktree alignment with OpenCode 2.3.2 native support: `worktree.directory` config, `ctx.worktree` (transform/add/list/create/remove), and `opencode run --worktree [=name]` now exist while the harness shells out to `git worktree` under `../.worktrees/<repo>/<id>`. Adopt the native surface or document the deliberate divergence. | shipped |
| F-022 | ? | agent-harness update fails closed on an unmodified previous-release AGENTS.md once next dev appends its block (blocks 0.4.1+ deploy to LibraryOS) | shipped |
| F-019 | ? | Session-end guard: an untracked `.agents/handoffs/*.md` in a project's shared main checkout is silently orphaned — `finalize` stages only the current feature's handoff and refuses every other one, while main-checkout commits are guard-blocked. Add a gate (or a handoff sync into the landing worktree) so no session handoff can be left behind unnoticed. | shipped |
| F-021 | ? | Migrate or retire a session's `.serve/sessions/<id>.json` lease when `session_move` relocates the session to the main checkout: the lease file stays inside the old worktree, `liveLeases(main)` surfaces it, and `worktree-prune` then reports every merged worktree as 'this session is rooted in it' and refuses to prune (observed for f-014/f-015/f-018 after moving F-015 to main). | shipped |
| F-020 | ? | Fix `archive` worktree cleanup when the board write runs from inside the feature worktree: cleanupWorktree resolves the recorded worktree path against the worktree root instead of the main checkout, so `git worktree remove` targets `<worktree>/../.worktrees/...` and fails, leaving the shipped worktree behind with a misleading fatal. | shipped |
| F-023 | ? | Session-start harness update check: compare the deployed `.harness.json` version to npm `dist-tags.latest` and suggest `npx opencode-agent-harness@latest update` (like opencode's "Update available"). Must be a cached (24h TTL) detached probe, not a blocking `npm view`; show once per new version in `orient --brief`, the TUI harness badge (v0.4.4 ↑0.5.0), and `doctor`; extend the global `harness-freshness` plugin so a stale project still sees it; stay silent offline and when the local checkout is ahead of npm. | shipped |
| F-024 | ? | Persona dispatch activation: make delegation legible, cheap and reliable — persona decision contracts, a prefilled dispatch_persona wrapper with preflight, persona economics in orient, risk-tiered dispatch policy, derived dispatch log, dispatch health probe | shipped |
| F-026 | ? | worktree-prune --self cannot identify the caller under OpenCode V2: tool bash runs under the pty helper, so the opencode server pid (which owns every session lease) is NOT a process ancestor, and all sessions share that pid. Result: finalize/ship reports 'worktree left in place' and every merged, clean feature worktree survives (f-023/f-024), forcing manual housekeeping each session. | shipped |
| F-027 | ? | Harness TUI version badge must append a restart marker when the global harness-freshness verdict is restart-needed (deployed .harness.json is current but the running opencode server predates the last write), so the footer never implies the loaded server-side harness is already active. | shipped |
| F-025 | ? | Persona dispatch activation, remaining slices S2-S6: dispatch_persona plugin tool (create child with parentID+agent+location, preflight model/write-scope/tree), persona economics in orient, risk-tiered dispatch policy (T0-T3 classifier), derived dispatch log in finalize, dispatch health probe + persona-hint interception. S1 (decision contracts + drift guard) shipped in 0.4.8. | shipped |
| F-028 | ? | Make finalize, update and deploy session-scoped: finalize aborts before staging when a shared checkout holds another live session's WIP (replace blanket add -u/untracked sweep with an ownership/tail allowlist), governance checks only handoffs in the push (untracked foreign drafts warn, never fail), and harness auto-deploy stops being a concurrent writer on LibraryOS main (publish-only or quiescence-gated). | shipped |
| F-029 | ? | Make /resume <id> orient on the named feature: forward $ARGUMENTS to orient --feature, treat an explicit id as authoritative over a board In-progress row, prefer the checkout (directory/branch) over the board in inference, and label a board-inferred feature as overridable in the full/brief output. | shipped |
| F-030 | ? | Session-start harness freshness: on every new and cleared/compacted session, apply a pending harness update (local checkout or registry) when the tree is safe, and require a restart; never mutate an unsafe tree. | shipped |
| F-031 | ? | Reconcile the harness self-deploy: root scripts/orient.js diverges from templates/scripts/orient.js, so `agent-harness update .` fails closed on drift, .harness.json stays at 0.4.9, and the installed harness-freshness plugin blocks every new session in the harness checkout. | shipped 2026-11-24 — root scripts/orient.js reconciled to templates/ (0 root-only lines); `agent-harness update .` deployed (4 created, 3 overwritten, 1 adopted), .harness.json 0.4.9 -> 0.4.13, commit 6583d6c pushed; doctor: deployed v0.4.13, dispatch plugin present, update dry-run clean |
| F-032 | ? | 0.4.14: always-fresh harness update probe — re-check registry on new/cleared/compacted sessions and render the badge from live files | shipped |
| F-033 | ? | Release 0.4.15: document the package.json bump rule in the gate reference (auto-update propagation probe) | shipped |
| F-034 | ? | harness-freshness resolves the project tree from the top-level event.location (opencode 2.4 moved it out of event.data): a LibraryOS session showed no 0.4.15 update because the plugin fell back to the server cwd ($HOME) and skipped every project. Prefer event.location.directory, then data.location, then ctx.location; pin the order with a drift guard. | shipped |
| F-035 | ? | harness-freshness: a restart-needed verdict written before an opencode service restart outlives it — the badge keeps showing ↻restart and the snippet stays stale because existing sessions never re-trigger session.created. Re-evaluate on session activity (context hook, once per session) so a post-restart message clears the verdict; also change the notice wording to 'opencode service restart' (not 'restart opencode'), which sent the user to the TUI twice. | shipped |
| F-036 | ? | Fix the false 'restart needed' harness block: classify a post-start harness write by what it touched (metadata-only = current) and make a real restart-pending notice advisory; also drop/re-collect a stale context-guard orient brief when HEAD/version moves under it | shipped |
| F-038 | ? | stale harness restart badge: .serve/harness-freshness.json from a dead process survives the service restart (publicvirtuallibrary verdict=restart-needed have=0.4.17 @12:33Z while .harness.json=0.4.18 @13:01Z); badge renders fresh 0.4.18 + stale ↻restart forever. Add verdict provenance (process/deploy id), ignore a verdict whose have != current version or older than the deploy, re-invalidate at process start, and resolve the badge directory per render. | shipped |
| F-040 | inquiry-capability | Inquiry loop: gated diagnosis + independent falsification + outcome verification | shipped |
| F-042 | ? | harness self-update/version badge stuck after 0.5.0: templates/docs/gates.md is missing the test:diagnosis section that landed only in the deployed docs/gates.md, so update fails closed as a local hand-edit in the harness repo and neither its badge nor LibraryOS can reach 0.5.x; port the section into the template and release 0.5.1 | pending |
| F-043 | ? | harness version badge/orient must show the loaded build vs the deployed build when a service restart is pending: badge currently prints only .harness.json (deploy), so it advertises a version the running service does not use | shipped |
| F-044 | ? | Harness auto-update failure is invisible: LibraryOS left on 0.5.1 with a blocked freshness verdict, the footer badge renders nothing for `blocked`, and the project update probe reports npm 0.5.1 as latest so even the ↑ arrow never appears while the local checkout is ahead. | shipped |
| F-045 | ? | Harness auto-update visibility, part 2: a successful update leaves the footer on the pre-update build because the freshness writer records `refreshed` (terminal) while the badge renders only `restart-needed`; a `blocked` verdict is discarded once its writer pid dies; and a project still on the old harness cannot render `blocked` because that badge code ships inside the blocked update. Fix: write restart-needed after a successful apply, keep blocked independent of writer liveness, have the global plugin write the project probe cache, add a refresh-only startup sweep, race/EOL hardening, and a doctor that tells the whole truth. | shipped |
| F-039 | ? | stale restart badge still shown after a service restart: the freshness plugin never evaluates a project tree without a session event that carries its directory (startup writes no verdict; an unresolvable first event burns the session's once-only check), so a dead process's restart-needed file survives; the project's own badge/TUI also still runs the pre-fix build | 0.5.5: newest live process owns the verdict; /proc pid identity; older live writer cannot pin; a newer client ignores a foreign restart verdict; V2 advice = opencode service restart |
| F-047 | ? | freshness tests must not pollute the real project registry; sweep-discovered updates render as pending, not blocked | resolved |
| F-048 | ? | freshness applier must re-evaluate a live session after a bounded window so a mid-session harness release applies without a restart | shipped |
| F-049 | ? | freshness test spawn must isolate XDG_STATE_HOME so it never writes the real project registry | shipped |
| F-046 | ? | Make /resume deterministic in one pass: (1) one shared case/separator-insensitive feature resolver (board row -> existing handoff stem -> worktree dir/branch) used by checkpoint/orient/finalize/backlog, so --feature f-045 finds F-045.md and a lowercase write can never create a second handoff; (2) resume searches feature worktree + current root + main, returns canonical id and absolute path, and suggests near-miss ids; (3) /resume moves the session with tools.opencode.session.move (delete every mention of the nonexistent session_move) BEFORE reading the checkpoint, then re-orients to confirm the root; (4) orient brief with rootMismatch or a board-inferred feature prints the exact move call and never says 'Proceed from the checkpoint/next'; (5) tests: lowercase resume, lowercase write keeps one file, handoff-only-in-main, finalize lowercase, brief gating, command uses the real tool name. Supersedes F-037. | shipped |
| F-051 | ? | Auto clear-resume when a feature session reaches its context limit: detect the request-context ceiling, write the deterministic checkpoint, start a fresh bounded context seeded from that checkpoint, and continue the feature without a manual /resume. | shipped |
| F-052 | ? | Auto clear-resume in the TUI: a TUI-side plugin that, when a feature-worktree session crosses the context ceiling and its checkpoint advanced, opens and focuses a fresh session seeded from the checkpoint (no manual /resume), reusing the runner's freshness/progress gates and reset cap. | shipped |
| F-053 | ? | Require committed deployed plugin copies: the context-resume source-contract test read the working tree, so a locally deployed but uncommitted copy masked b513264's CI failure (ENOENT in a clean checkout) | shipped |
| F-054 | ? | TUI plugin context-resume fails to load on OpenCode 2.4.2: ESM plugin graph named-imports from CJS scripts/qa/run-loop.js (export 'DEFAULT_MAX_CONTEXT_RESETS' not found) | shipped |
| F-056 | ? | Resume discovery loses the checkpoint when the board row declares a slug handoff or several rows are In progress — resolver must honor the Handoff cell, and orient/checkpoint_resume must list resumable checkpoints instead of `none` | shipped |
| F-058 | context-economy | Bound resume/checkpoint reads: honor the board Handoff slug (F-056) and make orient/checkpoint_resume return a <=3 KB excerpt (phase + next + headings) instead of `none` or the whole file | shipped |
| F-057 | context-economy | Nested `.agents/AGENTS.md` is auto-injected (28 KB) whenever any `.agents/**` file is read — rename the rulebook to `.agents/rulebook.md` (keep a small shim) so reading handoffs/reviews does not pull the whole rulebook into context | shipped |
| F-061 | context-economy | Auto-resume a feature across context bounds from the main checkout: when a checkpointed session is cleared and the fresh session lands on main, detect the recent checkpoint and automatically open a fresh context seeded from it (extend the context-resume plugin; keep the linked-worktree path unchanged, one-shot, reset-capped, ambiguous/multi-session safe). | shipped |
| F-060 | context-economy | Audit the fixed session-start prefix: first F-372 request was 11,394 tokens before any user work (system + tool schemas + 15.3 KB instructions); measure the tool-schema vs AGENTS.md share and trim or lazy-load it | shipped 4b8c619 (audit:prefix + AGENTS.md trim); CI green |
| F-062 | context-economy | Session-start brief should carry the board rows it already reads: per-row title + handoff/worktree pointer (and the active feature's title) so a cleared session needs zero discovery calls to find a named feature | shipped |
| F-059 | context-economy | Progressive disclosure for large state docs: add a markdown outline/headings mode and an oversized-read guard for `.agents/**` so review registers are read by section, not whole | shipped |
| F-063 | context-economy | Session-start brief should name the active feature's doc chain (intent/scope/plan/tests present vs missing, or none) so a cleared session does not glob/hunt for feature docs after orient | shipped |
| F-064 | ? | TUI auto clear-resume did not fire on context fill: stale ESM dep (run-loop.js) kept the context-resume TUI plugin unloaded; linked-worktree markers also resume only with checkpoint progress and only in the TUI's current location | shipped |

_Rows: `| F-003 | epic-key | short desc | shipped/done + date/commit |`_

## Not tracking (leave-in-place, no action)

_One prose note listing built-and-stable items deliberately left in place (no
investment, no removal). Omit the section if there is nothing to note._
