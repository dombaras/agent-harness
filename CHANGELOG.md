# Changelog

## Unreleased

- Auto-resume no longer strands itself behind a finished session: an observed execution end (`succeeded`/`failed`/`interrupted`) now releases the session lease. V2 never emits `session.deleted` for a normal run, so the old code kept the finished session's lease "live" (the shared server pid plus a fresh heartbeat) for the 4h freshness window, and the next resume was skipped as "another live session shares the checkout". (F-071)

- Auto-resume can no longer duplicate a finalize: a subagent (child-session) idle event is ignored instead of being treated as the work unit's context boundary, and a feature worktree with another live session lease refuses a second auto-resume. The fresh session is now prompted with the checkout's configured default model (from `opencode.json`) rather than inheriting the TUI's current model, so an auto-launch cannot land on a free fallback such as `opencode/seaglass-alpha-free`. (F-070)

- The feedback loop captures red signals automatically: a failed landed CI run in `ship`, a red nightly cycle, and UAT/gate failures normalize into one ledger item, dedupe by signature, and plan exactly one board row (`add` new, `link` known, `reopen` archived). Harness-side breakage stays off the product board as its own ops row, and `orient` prints a bounded feedback inbox line. (F-050)

- Feedback items are triaged reproduce-first: one clean rerun is recorded (a pass quarantines the flake with a named owner, 14-day expiry, and P2 hardening row), a fix closes only after the original signal verifies green, and a verified high-risk patch stops for human approval. `feedback next` emits a bounded reproduce-first prompt treating logs as untrusted; `run --feedback` works one eligible item in bounded phases and stops at approval. (F-050)

- The feedback loop now runs a bounded fix loop that retries only while attempts make progress, stops and escalates on consecutive same-failure attempts, limits auto mode to low-risk product-class items with a small attempt budget, and verifies a fix only inside a bounded window after a passing attempt; before landing, a test-integrity guard blocks deleted or skipped tests, inflated timeouts, and weakened assertions, UAT/deploy items require a rollback plan before closing, and the kill switch refuses in-flight verification. (`9098140`, F-050)

## 0.6.1 — 2026-11-27

- Fixed the F-067 deploy so the plugins load again: the fallback checkpoint writer now ships in the live `scripts/qa/` tree (not only `templates/`), and the TUI dynamic import points at `../../../scripts/qa/checkpoint-fallback.mjs`. Without both, `context-guard.ts` failed to load after a service restart because its static import resolved to a missing module (`plugin operation failed`). A deploy drift-guard test now pins deployed/template parity and both import resolutions.
- The harness restart verdict and update notice now survive a TUI restart instead of being lost with the previous plugin state (`e95f38d`, F-065).

## 0.6.0 — 2026-11-27

- Every observed session stop now writes a deterministic fallback checkpoint before the session is treated as idle — preserving the prior objective/progress/decisions/risks, refreshing changed files, recording the stop reason, incrementing the count, staying idempotent per session and never overwriting a newer model checkpoint (`4b25758`, F-067).
- Auto-resume now covers every non-technical stop (context band, early clean stop, context overflow, logical/work failures) under the existing freshness/progress/3-reset/landed gates, while network, provider, auth, resource, funds/quota and user-interrupt stops still hard-pause. A file-backed heartbeat lets `orient` flag an unobserved prior session.

## 0.5.19 — 2026-11-27

- Auto clear-resume now arms at the **checkpoint** band (F-066): the context guard writes `.agents/context-resume.json` when a primary session reaches the 120K checkpoint request level, not only the 160K intervene level. The checkpoint nudge already tells a compliant session to stop at the phase boundary; the marker now exists so the TUI/`agent-harness run` can resume it instead of leaving the work to a manual `/resume`. The existing freshness, checkpoint-progress and reset-cap gates are unchanged.

## 0.5.18 — 2026-11-27

- TUI auto clear-resume now survives a deploy and fires on the context-fill path (F-064): the plugin entry no longer statically imports its decision module (a stale CJS hop made opencode log `plugin operation failed` and never retry, so the marker was never consumed); it evaluates `resume-plan.mjs` through a cache-busted dynamic import on every execution end. A context-window `failed` execution now resumes through the same fresh/progressed/cap gates instead of only `succeeded`, a marker for a background worktree/tab resumes in its own directory without stealing focus, and the guard no longer writes a linked marker when the handoff has no resumable checkpoint.

## 0.5.17 — 2026-11-27

- Session-start `orient` and `orient --brief` now name the active feature's doc chain: they locate `.agents/features/<dir>/` by directory name or the `id` in `meta.json` and render one bounded `docs:` line listing intent/scope/plan/tests present versus missing (or `none` when no feature directory exists), so a cleared session reads the docs instead of globbing for them. (F-063)
- Ported the `audit:prefix` section into `templates/docs/gates.md` so the template and deployed `docs/gates.md` bytes match and the next deploy does not revert it. (`1c9208f`, F-063)
- Tracked the deployed `outline` plugin and library copies so a clean checkout resolves them instead of relying on a locally deployed tree. (`5356c04`, F-059)

## 0.5.16 — 2026-11-27

- Added the `outline` tool for bounded, fence-aware Markdown heading outlines with section line ranges and byte size, plus a pre-read guard for oversized `.agents/**` state documents. The guard can be tuned with `AGENT_GUARD_STATEDOC=0` or `AGENT_STATE_READ_BYTES`. (F-059)

## 0.5.15 — 2026-11-27

- Added `npm run audit:prefix` (`scripts/qa/prefix-audit.js`): it reads the first
  assistant usage of the newest session in the current root and reports the fixed
  session-start floor split into observed tokens, auto-loaded instruction bytes
  and tokens, and the derived system + tool-schema remainder. In this repo the
  floor is 11,238 tokens (9,318 input + 1,920 cache read) and ~71% is system +
  tool schemas, so the next context-economy trim targets the real bucket instead
  of a guess. It degrades to static mode without a store, so CI never depends on
  machine-local data.
- Trimmed the root `AGENTS.md` ~2 KB by pointing already-expanded mechanics at
  `.agents/rules/00-operating.md` / `.agents/rulebook.md`, and lowered the
  `test:prefix` ceiling from 12 KiB to 11 KiB (combined 72,704 -> 71,680 bytes) so
  the detail cannot quietly return to the always-loaded prefix. (F-060)
- Session-start `orient --brief` now names each In-progress row's title, epic, worktree path and branch, and handoff path; the active feature line also includes the row title, with bounded title clipping to keep the brief compact. (F-062)

## 0.5.14 — 2026-11-27

- A feature no longer stops at the context ceiling when the fresh context lands
  in the main checkout. When a primary session in main crosses the limit and
  exactly one recent checkpointed feature exists, the guard records a main
  resume marker; after the session ends, the TUI opens a fresh session in the
  same checkout seeded from the bounded checkpoint. It is one-shot,
  reset-capped, and refuses a stale, ambiguous, landed, or flat checkpoint. It
  also refuses while another live primary session shares the checkout. The
  linked-worktree path is unchanged. (F-061)

## 0.5.13 — 2026-11-27

- Moved the canonical rulebook to `.agents/rulebook.md` and reduced the
  auto-injected `.agents/AGENTS.md` shim, avoiding the ~28 KB (~7.4K-token)
  rulebook on every `.agents/` handoff, plan, or review read. The prefix gate
  now budgets the shim at 1 KiB and the rulebook at 28 KiB (72,704 bytes
  combined), with drift-guard coverage. (`7b9210b`, `2580e95`)

## 0.5.12 — 2026-11-27

- Resuming a large handoff no longer dumps the whole file into a fresh context.
  `checkpoint resume` and the `checkpoint_resume` tool now return a bounded
  (<= 3 KB) excerpt — objective/phase/next action plus a heading outline — and
  `orient` prints the same bounded next action with the top-level sections.
  A handoff that predates the `## Checkpoint` block yields a best-effort
  phase/next excerpt instead of failing or forcing a whole-file read; a truly
  missing handoff still fails loudly. (F-058)

## 0.5.11 — 2026-11-27

- Resuming a work unit no longer loses its checkpoint when the board row points
  at a slug-named handoff (`.agents/handoffs/platform-review-2026-11.md`) or when
  several rows are In progress. Resume now honors the row's declared `Handoff`
  cell, writes through to that same file instead of creating an id-named
  duplicate, and `checkpoint resume` with no feature (or `--list`) prints every
  resumable checkpoint with its phase and next action. `orient` lists each
  In-progress checkpoint instead of reporting `ckpt: none`, and the
  `checkpoint_resume` tool accepts an omitted feature. An explicit empty or
  sentinel `--feature` still fails loudly. (F-056)

## 0.5.10 — 2026-11-27

- TUI auto clear-resume loads again on OpenCode 2.4.2: the plugin's dependency on
  the shared resume decision core is now a true ES module
  (`scripts/qa/run-loop-core.mjs`) instead of the CommonJS runner script. OpenCode's
  TUI loader evaluates the plugin graph as ESM-only, where a CommonJS dependency
  exposes no exports and the whole plugin failed at read time with
  `export 'DEFAULT_MAX_CONTEXT_RESETS' not found`. `scripts/qa/run-loop.js` remains
  a synchronous CommonJS facade for `agent-harness run` and `scripts/finalize.js`,
  so the runner is unchanged. A new `test:quick` guard walks every TUI plugin entry
  and fails on a relative `.js`/`.cjs` import, with a negative fixture proving the
  guard fires. The documented Node floor is now 20.19+, the first release that can
  `require()` an ES module. (F-054)

## 0.5.9 — 2026-11-26

- A TUI session in a feature worktree now resumes itself at the context
  ceiling: when the guard records the crossing and the session finishes its
  execution, a TUI plugin opens and focuses a fresh session seeded from the
  checkpoint instead of waiting for a manual `/resume`. It reuses the runner's
  freshness, checkpoint-progress, and 3-reset gates (a flat checkpoint or a
  spent cap surfaces a toast instead of relaunching), never acts mid-step,
  never relaunches after a failed/interrupted run, and leaves main checkouts on
  the advisory nudge. (F-052)

- The context-resume source-contract test now reads the deployed plugin copies
  from git instead of the working tree, so a locally deployed but uncommitted
  copy can no longer mask a missing commit — the gap that turned b513264's CI red.

- A long feature run no longer stalls at the context ceiling waiting for a manual
  resume: when the guard records that a session in a feature worktree crossed its
  context limit, `agent-harness run` now treats that phase exit as a resumable
  boundary and starts a fresh bounded context from the checkpoint. The marker is
  trusted only when it was written during the phase, belongs to the same feature,
  and the checkpoint actually advanced; a stale or no-progress marker stops the
  run, and consecutive resets are capped (`--max-context-resets`, default 3) so a
  relaunch loop cannot run away. Interactive TUI sessions on main keep the
  advisory nudge and are never relaunched. (F-051)

- Phase 2 turns a red feedback item into bounded triage: one clean rerun is
  recorded, a pass quarantines the flake with a named owner, 14-day expiry, and
  P2 hardening row, while a fail keeps the product classification for diagnosis.
  High-risk work reaches `resolved` only with human approval recording who, when,
  the diff hash, and evidence. `feedback next` emits a bounded reproduce-first
  prompt treating logs as untrusted; `escalate` stores its decision template and
  `prepare` seeds a diagnosis scaffold. `run --feedback` works one eligible item
  in bounded phases and stops at approval; policy defaults are 1 rerun/14 days,
  and `test:feedback` independently re-derives these decisions. (F-050)

## 0.5.8 — 2026-11-26

- The harness now ships the Phase 0 foundation of a closed feedback loop: every
  important failure signal (CI, nightly, UAT, gate, human) can be captured once,
  normalized, deduplicated by signature, classified, and routed by a deterministic
  policy instead of an improvised agent decision. A fix is only `resolved` after
  the original signal is verified green, and recurrence reopens the item at P1.
  `npm run feedback` exposes the CLI, while the new `test:feedback` gate pins the
  policy safety floor, eight-fixture truth table, secret redaction,
  dedupe/reopen, state transitions, and budget rules offline. (F-050)

- The feedback loop now captures the red signals automatically instead of waiting
  for someone to file them: a failed landed CI run in `ship`, a red nightly cycle,
  and UAT/gate failures all normalize into one ledger item, dedupe by signature,
  and plan exactly one board row (`add` new, `link` known, `reopen` archived).
  Harness-side breakage stays off the product board as its own ops row, while a
  product nightly journey links to the row the nightly reconcile already owns.
  `orient` prints a bounded feedback inbox line (open items, mode, oldest age) and
  degrades to `unavailable` when the ledger or capture script is absent; the
  `test:feedback` gate now also pins the CI/nightly adapters and the one-row board
  plan. (F-050)

- Phase 2 turns a red feedback item into bounded triage: one clean rerun is
  recorded, a pass quarantines the flake with a named owner, 14-day expiry, and
  P2 hardening row, while a fail keeps the product classification for diagnosis.
  High-risk work reaches `resolved` only with human approval recording who, when,
  the diff hash, and evidence. `feedback next` emits a bounded reproduce-first
  prompt treating logs as untrusted; `escalate` stores its decision template and
  `prepare` seeds a diagnosis scaffold. `run --feedback` works one eligible item
  in bounded phases and stops at approval; policy defaults are 1 rerun/14 days,
  and `test:feedback` independently re-derives these decisions. (F-050)

## 0.5.6 — 2026-11-25

- Resuming or checkpointing a work unit now accepts lowercase and separator-variant
  feature ids without losing the canonical handoff: checkpoint, orient, finalize,
  and backlog share one resolver, find handoffs in the feature worktree, current
  checkout, or main checkout, and offer near-match suggestions when a lookup
  misses. Readiness output now gives the real session-move command and avoids
  claiming to proceed when the session is rooted in the wrong tree or the feature
  id is only inferred from the board; the new regression coverage runs in
  `test:quick`. (F-046)

- The freshness badge test no longer depends on the wall clock: it pins the
  F-038 verdict timestamp, so a run that crosses midnight cannot flip the
  assertion. (F-039, `53bd9e3`)

- The freshness activity test no longer drives its plugin spawn against the
  developer's real project registry. That spawn lacked `XDG_STATE_HOME`, so its
  startup sweep stamped real checkouts with the fixture version `9.9.9`; it
  repolluted LibraryOS after a service restart. The spawn now owns a temp state
  root. (F-049)

- A harness release published while a project session is open is now applied on
  the next request instead of waiting for a new session or a restart. The
  freshness plugin re-evaluates at most once per 15-minute window
  (`AGENT_HARNESS_RECHECK_MS` overrides it), which also backs off a genuine
  refusal. (F-048)

- A sweep-discovered harness update now reads `⚠update pending` (footer badge)
  and `(update pending)` (`orient`) instead of `⚠update blocked`: the startup
  sweep never applies an update, so "pending" is the truthful state. The
  freshness F-035 test now isolates `XDG_STATE_HOME`/`XDG_CACHE_HOME` and
  asserts the real project registry is untouched — it had registered its
  `/tmp/harness-update-*` fixtures in the machine registry and stamped real
  checkouts with a fake `latest: 9.9.9`, pinning LibraryOS on `⚠update blocked`
  after the test process was gone. (F-047)

## 0.5.5 — 2026-11-25

- A `restart-needed` badge can no longer be pinned by an older opencode process.
  One checkout may be served by several processes (the shared background service
  plus per-client stdio/ACP servers), so the newest live process now owns the
  tree's verdict: an older process can no longer rewrite it, and verdict
  provenance includes the writer's `/proc` boot id + process start time so pid
  reuse is not mistaken for a live writer. A client that loaded the deployed
  build ignores a verdict written before it started. Restart advice now names the
  V2 command `opencode service restart` and explains that restarting the TUI
  alone reloads nothing. LibraryOS had stayed on `v0.5.1 -> v0.5.4 ↻restart`
  after a restart because a stale ACP server held the tree's verdict. (F-039)

## 0.5.4 — 2026-11-25

- The harness update state is now truthful and self-healing, so "deployed" and
  "running" are never confused again. A successful `update` records
  `restart-needed` (deployed = new build, active = the build the running service
  still holds, latest = new) instead of claiming `current`: the footer badge and
  `orient` say a restart is pending until the service actually reloads. A
  `blocked` verdict now survives the updater process exiting — it is cleared only
  by a later deploy or a newer write — so a checkout the updater cannot refresh
  keeps showing why. Readers normalize the legacy `refreshed` state, and the
  update probe is persisted to `.serve/harness-update.json` (schema
  `harness-update/1`, atomic, re-reads the deployed version at write time) with a
  bounded registry plus a refresh-only startup sweep. `doctor` now tells the whole
  story in three lines: `update probe` (latest, when, which source answered),
  `freshness verdict` (status, first cause line, exact next command) and
  `global plugin` (symlink target vs the bundled source — the one failure a
  project cannot self-heal). EOL-only differences (a `git` `eol=crlf` checkout of
  an LF template) no longer count as hand-edits that fail `update` closed, while a
  real content edit still does. (F-045)

## 0.5.3 — 2026-11-25

- A refused or failed harness auto-update is now visible instead of silent: the
  footer badge renders the freshness plugin's `blocked` verdict (`⚠update failed`
  / `⚠update blocked`), and `orient` says `harness 0.5.1 (update failed)`, so a
  checkout the updater cannot refresh no longer advertises its stale version as
  current. The update probe also compares the machine's local harness checkout
  (`AGENT_HARNESS_HOME`, default `~/develop/agent-harness`) with the registry, so
  a dev machine that leads npm shows `↑0.5.3` instead of treating the older
  published release as latest. A blocked verdict keeps the first lines of the
  updater's error (the cause) instead of only the tail of the stack. Reported
  case: LibraryOS stayed on 0.5.1 with no indicator because two mobile-e2e fixes
  were hand-edited in the project and `update` failed closed. (F-044)
- The F-331 mobile-e2e APK-cache fixes now ship in the templates: `build-apk.sh`
  verifies the APK's embedded `EXPO_PUBLIC_API_URL` before reusing a cached or
  overlaid artifact (and deletes the stale generated bundle tree before Gradle),
  and `apk-cache.js` bumps the bundle key to v2 so a poisoned v1 entry is never
  reused. Those hand-edits had blocked LibraryOS's harness update.

## 0.5.2 — 2026-11-25

- The harness version badge and `orient` now name the build the running service
  actually loaded when a restart is pending, instead of printing only the
  deployed `.harness.json` version. A stale service now reads
  `harness v0.4.18 → v0.5.1 ↻restart` (and `orient` says
  `harness 0.4.18 → 0.5.1 (restart needed)`); when the loaded build cannot be
  established the old `↻restart` marker remains and no version is invented.
  The freshness verdict now records `active`, recovered from `.harness.json`
  at service start via git history. Reported case: service loaded 0.4.18 at
  14:59Z, 0.5.1 was written at 15:12Z, and the footer advertised 0.5.1 as if it
  were running. (F-043)
- The falsifier drift guard now compares the deployed persona against the
  template rendered with the project name, as `init`/`update` do, instead of the
  raw `{{PROJECT_NAME}}` placeholder. The 0.5.1 self-deploy legitimately
  rendered the placeholder and turned CI red. (F-043)

## 0.5.1 — 2026-11-25

- `agent-harness update` no longer stops at the locally-modified-file guard in
  the harness's own checkout. The 0.5.0 diagnosis-gate documentation landed in
  the deployed `docs/gates.md` but not in `templates/docs/gates.md`, so every
  self-update saw a "hand-edited" harness file, refused to write, and the
  repo's version badge stayed on 0.4.19. The template now carries the
  `test:diagnosis` section, so the deployed copy is identical and the update
  proceeds. Reported case: 0.5.0 published, service restarted, badge still
  stale in both the harness repo and LibraryOS.

## 0.5.0 — 2026-11-25

- Declared bug, incident, and fix work now needs a checked diagnosis before it can finalize: two candidate causes with discriminating tests, ruled-out causes, independent falsification, and a red-before/green-after oracle. (F-040)
- A read-only `falsifier` persona plus the `/diagnose` command and skill challenge the cause before code changes; unknown-cause work routes to at least T2 and pays the new gate. (F-040)
- `npm run test:diagnosis` validates the artifact, supports one-release warn mode with `AGENT_HARNESS_DIAGNOSIS=warn`, never blocks legacy features without `meta.json`, and honors `requiresDiagnosis: false` as the deliberate opt-out. (F-040)
- Bug, incident, and fix QA plans now carry an `## Outcome oracle` covering the reported symptom, before red, after green, command, environment, and independent owner. (F-040)
- `orient` and `checkpoint resume` surface diagnosis status, confidence, staleness, and open questions. (F-040)
- [`docs/harness-lifecycle.md`](docs/harness-lifecycle.md) describes the inquiry loop end to end. (F-040)
- The harness's own CI runs the diagnosis gate from its template source, because `/scripts` is generated and gitignored in this repository. (F-040)

## 0.4.19 — 2026-11-25

- A `restart-needed` verdict can no longer outlive the deploy or process it
  describes. Every verdict now records the writing process (`pid`, `startedAt`),
  and the footer badge renders `↻restart` only while the verdict still matches
  the checkout: its `have` equals the deployed `.harness.json` version, its
  `wrote` is not older than the current `.harness.json` write, and the writer is
  still alive. The badge also resolves its checkout directory on each render.
  Reported case: a verdict written for 0.4.17 at 12:33Z survived the 0.4.18
  deploy (13:01Z) and the service restart (13:35Z), so the footer read
  `harness v0.4.18 ↻restart` indefinitely with no session activity to re-evaluate
  it. Legacy verdicts without provenance still pass the version/deploy checks.
  (F-038)

## 0.4.18 — 2026-11-25

- A harness update that only rewrote deployment metadata (`.harness.json`) no
  longer blocks a resumed session or claims the running plugins are old: the
  freshness plugin now checks whether anything opencode loads at startup
  (`opencode.json`, `AGENTS.md`, `.opencode/**`) actually changed after the
  process started, and a real change is advisory ("continue now, restart when
  convenient") instead of a "do NOT begin work yet" gate. Reported case:
  0.4.16 -> 0.4.17 auto-committed mid-session, the badge read 0.4.17, and the
  agent refused to resume over a restart that would have changed nothing. (F-036)
- The context-guard session brief is revalidated against the tree before it is
  re-injected: if HEAD or the deployed harness version moved after the snapshot
  was collected (a harness update landing seconds later), the stale brief is
  dropped and re-collected instead of telling the agent an old version while the
  TUI badge reads the new one. (F-036)

## 0.4.17 — 2026-11-25

- A `restart-needed` harness verdict no longer outlives the opencode service
  restart that resolved it. A session survives a service restart but never
  re-fires `session.created`, so the global `harness-freshness` plugin now
  re-evaluates once per session on its first activity (the event stream and the
  context hook): the stale verdict is replaced, the `↻restart` footer badge
  clears, and a real block surfaces on the next turn. The restart advice says
  "restart the opencode service (the server process, not just the TUI)" — the
  old "restart opencode" wording sent the user to the TUI twice. (F-035)

## 0.4.16 — 2026-11-25

- The global `harness-freshness` plugin resolves a session's project tree from
  the event's top-level `location.directory` (opencode 2.4 moved it out of
  `event.data`), then `data.location`, then the server cwd. A LibraryOS session
  previously fell back to the server cwd (`$HOME`), found no git tree, and
  skipped every project — so `0.4.15` was never surfaced there. A drift guard
  pins the fallback order. (F-034)

## 0.4.15 — 2026-11-25

- The gate reference now states the release rule the suite already enforces: a
  change under `bin/` or `templates/` must bump `package.json` in the same
  commit, on top of the CHANGELOG line.

## 0.4.14 — 2026-11-24

- The harness update badge can no longer lag a release behind a cached verdict.
  The detached probe re-reads the registry on every new, cleared, or compacted
  session (`session.created` + `session.compaction.ended`) and now probes by
  default instead of honouring a 24h TTL (`--max-age <ms>` is the opt-in
  throttle); the TUI badge re-reads the deployed version and the update/restart
  verdicts on every render. A project can no longer show `0.4.10 ↑0.4.11` while
  `0.4.13` is already published. (F-023 follow-up)

## 0.4.13 — 2026-11-24

- The global `harness-freshness` plugin now closes the gap that left an active
  project on an older harness: a release that exists only in the npm registry is
  applied through `npx --yes opencode-agent-harness@<latest> update` instead of
  being advisory-only, a cleared/compacted session re-checks the tree (not just
  `session.created`), and a successful apply injects a one-shot "restart
  opencode" notice because the running process still holds the previous plugins.
  Unsafe trees — stale project main, diverged branch, overlapping local changes,
  an in-flight merge/rebase, a failed update — are still blocked, never mutated.
  (F-030)

## 0.4.12 — 2026-11-24

- `/resume <id>` now orients on the named feature: the command forwards its id
  to `orient --feature`, an explicit id outranks the board's In-progress row,
  and feature inference prefers the checkout (directory/branch) before the
  board. A board-inferred feature is labelled `pass --feature <id> to override`
  in both the full and brief output. (F-029)

## 0.4.11 — 2026-11-24

- Landing a task can no longer sweep another live session's uncommitted work
  into the commit. When a shared checkout holds a second live session,
  `finalize` now aborts before it archives or stages anything unless every dirty
  path is this feature's own tail or a declared ownership glob; staging itself
  switches from a blanket sweep to that explicit allowlist. `backlog owns <id>
  --files …` declares the globs, and `--include-blocked` remains the deliberate
  override. (F-028)
- The governance gate now validates the handoffs that are actually in the push
  (the git index) instead of every handoff on disk: a stale untracked draft
  warns and no longer blocks a landing, while an invalid handoff that is staged
  still fails. (F-028)
- Harness CI no longer writes LibraryOS `main`: the auto-update publishes the
  update commit to `refs/heads/harness/auto-update` and leaves integration to a
  human, so a concurrent harness write cannot race LibraryOS's own landings.
  (F-028)

## 0.4.10 — 2026-11-24

- Persona dispatch now preflights the model pin, write scope, and working tree,
  then assembles a six-field task spec before work starts.
- `orient` makes the cost lane visible, while the T0–T3 policy matches dispatch
  effort to risk instead of defaulting every change to the same fan-out.
- Finalize derives a readable `persona -> model -> status` dispatch log, and
  `doctor` plus the context guard add advisory checks and first-edit guidance.
  (F-025)

## 0.4.9 — 2026-11-24

- The TUI harness badge now appends `↻restart` when the global
  `harness-freshness` verdict is `restart-needed`: the deployed `.harness.json`
  is current but the running opencode server predates the last write, so the
  footer no longer reads as if the new server-side harness were already active.
  The badge reads `.serve/harness-freshness.json` best-effort (missing or
  malformed = no marker) and keeps the warning colour. (F-027, H-44)
- A finished feature worktree now cleans itself up again under OpenCode V2:
  `ship` asks `worktree-prune` to remove the landed checkout from inside that
  checkout, and `--self` accepts the caller's cwd as ownership proof when the
  lease pid is not an ancestor (V2 runs tool bash under a pty helper that is a
  sibling of `opencode serve`; every session also shares the server pid, so
  ancestry cannot name the caller). Merged, clean worktrees no longer survive
  finalize and pile up for manual housekeeping. (F-026)

## 0.4.8 — 2026-11-24

- Persona `description:` lines are now decision contracts — `Use when <trigger>
  — returns <artifact>. Skip for <anti-trigger>. Writes: <globs>` (or `Reads
  only`) — so the main agent sees what a dispatch returns, what it costs in
  scope, and when not to use it at the moment it chooses. A new drift guard
  (`tests/dispatch-contract.test.js`, wired into `npm test`) fails a description
  that loses a decision field, grows past the schema-cost budget, drops the
  output-contract marker, or drifts between `templates/` and the deployed copy.
  (F-024)

## 0.4.7 — 2026-11-24

- A harness-provisioned session now tells you when the harness itself is stale,
  like opencode's own "Update available" notice: a cached probe (24 h, detached
  at session start) compares the deployed `.harness.json` version with the
  registry's latest and a local harness checkout, and the `orient` brief, the
  TUI version badge (`harness v0.4.4 ↑0.5.0`), and `doctor` point at
  `npx opencode-agent-harness@latest update` (then restart opencode). The global
  `harness-freshness` plugin reports the registry path as advisory — it never
  deploys a registry release on its own. Offline, disabled
  (`AGENT_HARNESS_NO_UPDATE_CHECK=1`), current, and source-ahead checkout states
  stay silent. (F-023)

## 0.4.6 — 2026-11-23

- Archiving a shipped feature from inside its own worktree now resolves the
  recorded worktree path against the main checkout instead of the feature
  checkout. `finalize` no longer leaves the worktree behind with a misleading
  `fatal: .../.worktrees/<repo>/.worktrees/<repo>/<id> is not a working tree`,
  and the live session pointer stays put until the landing session prunes it.
  (F-020)

## 0.4.5 — 2026-11-23

- A session moved with `session_move` no longer leaves a GHOST lease in the
  checkout it left: the guard plugin reconciles its lease against the store's
  `session_v2.directory` (60 s TTL) and retires the old tree's lease/pointer,
  `session.deleted` clears this tree regardless of the event's location, and
  `worktree-prune` retires foreign leases before reading the live view so a
  moved session no longer blocks pruning its old worktree. (F-021)

## 0.4.4 — 2026-11-23

- Finalize now carries handoffs written in the shared checkout into the landing
  commit, moves untracked handoffs out of the way of fast-forwarding, and reports
  other sessions' orphaned handoffs without committing them. (F-019)

## 0.4.3 — 2026-11-21

- `update` now recognises an unmodified previous-release root `AGENTS.md` that
  carries the tool-owned `next dev` marker block: the preflight compares the
  manifest checksum against the harness-owned content (block and trailing
  newline normalised), not raw bytes, so a release that changes `AGENTS.md` no
  longer fails closed as a project hand-edit. This blocked every automatic
  deploy to LibraryOS after 0.4.0. (F-022)

## 0.4.2 — 2026-11-21

- Native OpenCode worktrees now share the harness's sibling container: the
  managed `opencode.json` sets `worktree.directory` to `../.worktrees/<repo>`
  (add-only; a project's own destination wins), so a TUI or
  `opencode run --worktree` checkout no longer lands under the data directory
  the edit policy denies. Feature isolation stays on `git worktree` (named
  branch + board/handoff bookkeeping); the deliberate divergence is recorded in
  ADR 0002. (F-015)

## 0.4.1 — 2026-11-21

- Guard/session tool classifiers now cover the OpenCode 2.3.2 built-in set:
  `todowrite`/`todo` and `skill` repeats are loop-exempt, while `artifact`,
  `automation`, and `image-generate` count as material work and end the recon
  orientation prologue. A drift-guard test pins a deliberate intent for every
  effective built-in name. (F-014)

- The always-loaded `AGENTS.md` budget now fails before landing instead of only
  in CI: `test:prefix` runs in the ship/pre-push process battery, the ceiling has
  ~550 bytes of deliberate headroom (12 KiB, up from 11 KiB), and the file
  documents the trim-first / ask-the-user-before-raising path. The repo's own
  `test:quick` is defined so the quick phase is never silently empty. (F-018)

## 0.4.0 — 2026-11-21

- Added a hard-deny policy layer for credential paths, harness config/store
  self-modification, and MCP availability; MCP now requires explicit per-server
  opt-in. Policy merging is managed-first/project-appended with duplicate
  removal and legacy `experimental.policies` migration, while `update` and
  `doctor` warn about existing servers that remain denied; `test:opencode-compat`
  detects drift in the managed credential/MCP denies. (F-013)

- Trimmed the managed-MCP bullet in `AGENTS.md` back inside the always-loaded
  `test:prefix` size budget after the F-013 wording pushed it over (both
  clean-deploy prefix tests were red on CI). (F-013)

- The OpenCode todo panel works end-to-end again: `templates/opencode.json`
  enables `experimental.todo: true` (V2 gates the built-in `todowrite` behind it,
  default false), and `mergeOpencodeJson` deep-merges the `experimental` block so
  a project keeps its own flags while `todo` stays harness-managed. A new
  `test:opencode-compat` gate (wired into the process gates + `doctor`) fails a
  deploy that drifts to V1 — wrong runtime major, a missing/disabled
  `experimental.todo`, a leftover V1 config key (`small_model`/`agent`/
  `permission`/`tools`), a V1 plugin package/envelope, or the legacy
  `.opencode/tools`/`opencode/command` layout. The todo guard tightens to
  3/2 material calls, flags a list with open items but no `in_progress`
  (`nocurrent`), and stays silent when the project disables the capability.
  (F-005)

- OpenCode 2.3.2 compatibility scan: `docs/opencode-v2.3-compat-scan.md` audits
  every harness surface against the installed `2.3.2` binary and the published
  `@opencode/*@2.3.2` types. Verified live: all 11 harness plugins load, the
  pinned tool/session hooks and event payloads still match, `experimental.todo`
  still exists, and `session_v2` + `session_message` are still in the store.
  Filed the deltas as rows: managed `policies` hard-denies (P2), guard
  classifiers for the 2.3.2 built-in tool set (P3), native worktree alignment
  (P3), and the new `plugin`/`stats` CLI + stats-oracle follow-ups (P4). (F-006)

## 0.3.16 — 2026-11-21

- A harness-provisioned repo now shows its deployed harness version as a
  constant TUI badge (`harness v0.3.16`): in the home footer beside opencode's
  own version, and in the session prompt footer beside the model indicator. It
  reads the version from `.harness.json`, so it tracks `agent-harness update`,
  and renders nothing in repos that are not harness-provisioned. (F-012)

## 0.3.15 — 2026-11-21

- The Release workflow pins npm 11 instead of `npm@latest`: npm 12 changed
  `npm pack --json` output (an empty array) and broke `test:pack` before the
  publish step, so auto-releases failed before npm trusted publishing could
  run. npm 11 keeps OIDC publishing while the pack gate passes. (F-011)

## 0.3.14 — 2026-11-21

- Version bumps now reach npm automatically: after a green `main` CI run,
  `.github/workflows/auto-tag.yml` creates the missing `v<package.json version>`
  tag and dispatches `release.yml` (which gains `workflow_dispatch`). The release
  publishes with npm trusted publishing (OIDC), so no long-lived `NPM_TOKEN` is
  stored. A tag pushed with the workflow token cannot trigger another workflow,
  hence the explicit dispatch. (F-010)

## 0.3.13 — 2026-11-21

- Every green `CI` run on `main` now redeploys the harness into LibraryOS
  (`.github/workflows/deploy-libraryos.yml`): it checks out the CI-tested
  commit plus `dombaras/LibraryOS`, runs `agent-harness update` against it, and
  lets the updater commit/push the `chore(harness)` release. A write-scoped
  deploy key is stored as `LIBRARYOS_DEPLOY_KEY`; `update` is idempotent, so a
  landing that changes no harness file commits nothing. This closes the gap
  that left LibraryOS at v0.3.8 while the harness was v0.3.12. (F-009)

## 0.3.12 — 2026-11-21

- `backlog sync` no longer refuses a behind-only checkout just because an
  unrelated tracked file is dirty. It attempts the fast-forward and lets git
  protect the dirty file: unrelated edits are carried across, and only a file
  the landing would overwrite fails closed (with git's own error line). This
  previously stranded `main` one commit behind on an uncommitted config toggle
  the landing never touched. (F-008)
- Removed the accidentally tracked `node_modules` symlink from the release
  tree. (`7049179`)

## 0.3.11 — 2026-11-21

- Archiving a row from a linked feature worktree no longer writes that
  worktree's inherited board snapshot. The archive exception now applies only to
  a row the branch itself claimed (In progress), so a subsumed Open row is
  archived on the canonical board. Previously such an archive stranded in the
  feature checkout after its branch had already landed and had to be redone by
  hand from main. (F-007)

## 0.3.10 — 2026-11-21

- Board publishing no longer aborts on the gitignored (but tracked)
  `.agents/memory/owned-files.md`: `publishBoard` force-stages its explicit
  tracked extras, and every add/commit/push failure carries git's first error
  line. `backlog.js` prints that detail and whether the change is committed or
  only in the working tree, instead of a fixed "remote unreachable" note that
  masked local git failures for weeks. (F-004)
- `test:docs` skips link-shaped inline code spans (an API example such as
  ``plugin["tool.execute.before"](...)`` is not a markdown link), and
  `test:backlog` no longer counts `templates/BACKLOG.md` as a stray board, so
  both gates run green and can be enforced instead of rotting. (F-004)

## 0.3.9 — 2026-11-21

- `update` adopts harness-owned files whose working bytes already match the
  release but are still uncommitted against HEAD. A deploy that wrote a file
  but skipped it in its `chore(harness)` commit no longer leaves invisible
  drift: `.harness.json` records the worktree hash, so every later update saw
  "unchanged" and nothing was ever committed (the LibraryOS 0.3.8 case —
  `scripts/board-service.sh`, `finalize.js`, `qa/run-gates.js`, `wsl-tune.sh`
  needed a manual commit). The adopted files join the harness commit; a path
  whose staged bytes belong to another session is left in the index untouched.

## 0.3.8 — 2026-11-21

- `check-flows.js` no longer rejects a valid journey matrix: a `*TestID` prop
  that is forwarded resolves to the element's `testID` at runtime, so only a
  literal-free or unknown target is a violation; `runFlow: file:` includes are
  validated recursively — a missing file, an escape outside `flows/`, or an
  include cycle is reported against the journey instead of failing later as a
  Maestro timeout. Ported byte-for-byte from LibraryOS's project-proven copy so
  it has an upstream release identity. (03f3013)

## 0.3.7 — 2026-11-21

- `update` refuses to deploy from an uncommitted `templates/` tree and refuses
  `--no-commit` for a real deploy, so a release can never land downstream as
  untracked project WIP (the 2026-11-20 LibraryOS 0.3.6 incident). `--dry-run`
  previews; `--allow-dirty-templates` is the deliberate harness-development
  override. (0b97dc3)
- `wsl-tune` resolves the node binary instead of assuming PATH, because sudo
  resets it to the secure_path: a user-local node (nvm/volta/fnm/~/.local/bin)
  no longer makes the `.wslconfig` merge die with a bare
  `node: command not found` after the root tunables landed; under sudo the
  merge runs as the invoking user, and a failed merge is reported as one.
  (aa22740)
- The board-service systemd unit pins the generating node's directory in
  `PATH`: systemd --user's default PATH omits user-level Node installs, so
  `next`'s `#!/usr/bin/env node` shebang made the service restart-loop with
  exit 127. (5c4516b)

## 0.3.6 — 2026-11-20

- Finalization now closes the loop instead of reporting drift. `finalize` stages
  its tail with `git add -u` + explicit untracked adds, refusing generated paths,
  symlinks, other features' handoffs, and a stray worktree `BACKLOG.md` when the
  board service owns the board (the `git add -A` sweep had committed a
  `prisma/generated` symlink and could commit another session's work); after
  landing it fast-forwards a clean main checkout and prints the remaining
  close-out actions. NEW `scripts/qa/worktree-hygiene.js` reports main-checkout
  drift + merged/clean leftover worktrees, and `test:worktrees`
  (`scripts/qa/check-worktrees.js`, wired into the `process` gate phase and
  skipped on CI) fails when a landing left either behind.
- `update` no longer fails closed on the root `AGENTS.md` because `next dev`
  appended its `<!-- BEGIN:nextjs-agent-rules -->` block: the drift check and the
  deploy write now compare the harness-owned content with that tool-owned block
  stripped, so a marker-only difference is neither a hand-edit nor a rewrite
  (which previously made `next dev` re-append the block on the next run). A real
  edit to the harness-owned part is still refused. (F-349)
- The worktree-hygiene guard scripts (`scripts/qa/worktree-hygiene.js`,
  `scripts/qa/check-worktrees.js`) are committed at the repo root even though
  `/scripts` is gitignored, so a fresh clone gets `test:worktrees` instead of
  silently running nothing. (b68e1bc)

## 0.3.5 — 2026-11-20

- Shipped the `.agents/reviews/` scaffolding for review deliverables (ebe9dd8).
- Trimmed the canonical rulebook (`templates/.agents/AGENTS.md`) from ~47 KB to
  ~27 KB by removing the operating mechanics that duplicate the always-on root
  `AGENTS.md` and `.agents/rules/00-operating.md` (dispatch economics, retry/gate
  discipline, context budget, capacity guards, finalize/reporting). The rulebook
  now carries the durable standards and points at the summary for mechanics;
  test-pinned rules and every section number are preserved.
- Lowered the `test:prefix` size budget for the rulebook (48 -> 28 KiB) and the
  combined harness-owned ceiling (87 -> 69 KiB), so the dedupe is locked in and
  the prefix cannot silently regrow.

## 0.3.4 — 2026-11-20

- Added a durable per-project backend pin: `.harness.json`
  `"board": { ..., "backend": "file" }` keeps a project on the legacy file board
  without relying on a shell export (useful when the service is not provisioned
  on that machine). `backend: "service"` pins the service; `BACKLOG_BACKEND`
  remains the per-environment override, and `--root` still forces file mode for
  migration/tests. The pin survives `update` because `.harness.json` merges
  project fields.

## 0.3.3 — 2026-11-20

- Refined worktree archive routing: a row already in the worktree's board
  snapshot still archives there and rides the feature branch (finalize
  semantics), while a row captured after the branch was cut exists only on main
  and now archives on main instead of failing with "no row in BACKLOG.md".

## 0.3.2 — 2026-11-20

- Board capture/claim/read commands are project-scoped, never checkout-scoped.
  A `backlog` run inside a linked feature worktree now resolves to the shared
  board service — or, in legacy file mode, to the MAIN checkout's board — so a
  row captured mid-feature (the LibraryOS Next.js security finding filed in an
  f-002 worktree) reaches the main board immediately instead of a private
  worktree copy. In legacy file mode, `archive` of a row already in the
  worktree's snapshot rides the feature branch, so a failed `ship` cannot mark
  unlanded work done on main; a row captured after the branch was cut has no
  local copy, so its archive resolves to main (finalize no longer fails with
  "no row").
- A project that declares `board.url` in `.harness.json` now treats the service
  as mandatory: a missing token fails loudly with an actionable message instead
  of silently falling back to a checkout-local `BACKLOG.md`. The legacy file
  board remains available only through explicit `BACKLOG_BACKEND=file` or
  `--root`.
- The board client also reads the installed
  `~/.config/agent-harness/board.env`, so an opencode server launched outside the
  shell hook (systemd/desktop/resumed session) still reaches the service.
- Tests: a linked worktree mutation/read targets main and leaves the worktree
  copy untouched; a declared-service/no-token project writes no local row; the
  `board.env` token fallback is covered.

## 0.3.1 — 2026-11-17

- Added an `sdlc` bundle profile: the process/quality harness only (personas,
  rules, skills, memory, backlog, context/token discipline, and the process
  gates) without deploy, CI, host-tuning, mobile-E2E, or the board service.
  Like `core`, its bundle is a single-commit snapshot.
- The `sdlc` archive carries a `profile.json`; `init`/`update` read it and wire
  only the npm scripts whose files actually ship, so a process-only checkout has
  no dead `ship`/`nightly`/`serve` entries. No `profile.json` still means the
  full harness.
- Kept the shared libraries that the retained features import
  (`capacity-lib.js` for the context guard/`orient`, `merge-backlog.js` for the
  board merge driver) in the `sdlc` archive.

## 0.3.0 — 2026-11-17

- Added `npm run bundle` (`tools/make-release-bundle.mjs`) for closed /
  air-gapped handovers: a source zip, a git bundle, `MANIFEST.json`
  (commit + per-file SHA-256), `REVIEW-NOTES.md`, and `SHA256SUMS`.
- Added a `core` bundle profile that drops the host-tuning installers
  (WSL sysctls, tmpfs, GPU, nightly timer), the mobile-E2E tier, and the global
  freshness plugin; its bundle is a single-commit snapshot so excluded files are
  not carried in history.
- `tools/` is repo tooling only — not shipped in the npm package and not
  deployed by `init`.

## 0.2.0 — 2026-11-16

First public release under the `opencode-agent-harness` name.

- Renamed the package from `@dombaras/agent-harness` to `opencode-agent-harness`
  (the CLI binary remains `agent-harness`).
- `init` no longer commits or pushes by default; pass `--commit` / `--push`.
  `update` keeps its auto-commit behaviour.
- `init` refuses to overwrite a pre-existing `AGENTS.md` it did not create;
  `--accept-harness` overwrites deliberately after backing the file up under
  `.harness-backup/`. Pre-existing untracked harness files are backed up before
  any overwrite.
- Added `repository`, `homepage`, `bugs`, `author`, and public-package keywords;
  Node engine raised to `>=20`.
- Added a packed-tarball smoke test (`npm run test:pack`), a `prepublishOnly`
  gate, and a tag-driven release workflow.
- Default model routing is unchanged (`opencode-go/*`).

## 0.1.21 — 2026-09-04

Last release under the previous name, `@dombaras/agent-harness`.
