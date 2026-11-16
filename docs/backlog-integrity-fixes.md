# Harness fix queue — backlog integrity, auto-commit scoping, and WSL/merge-driver hardening

Status: **FIXED in `0.1.65`** (all six items; `npm run lint` + `npm test` green,
177 pass) — **except item 4, whose `process.execPath` fix was a regression;
corrected in `0.1.67` (see item 4).** Found 2026-09-16 in the LibraryOS project (`~/develop/PublicVirtualLibrary`,
WSL2) while verifying that the canonical `BACKLOG.md` can be written concurrently
from (a) agent `backlog_*` tools / `scripts/backlog.js` and (b) the superadmin web
UI (`app/api/admin/backlog/route.ts`, which shells out to the same CLI).

**Item 7 is FIXED in `0.1.68`** — a `merge-backlog.js` data-integrity defect
found 2026-09-17 in the same project (a conflicting `BACKLOG.md` merge dropped
nearly every row). Details below.

Every item below is harness-owned (`templates/` and `bin/agent-harness.js`) — fix
here, bump `package.json`, `npm run lint` + `npm test` green, commit
`fix: … (0.1.x)`, then deploy with
`node ~/develop/agent-harness/bin/agent-harness.js update --target ~/develop/PublicVirtualLibrary`.

---

## 1. `withLock` in `templates/scripts/backlog.js` is not a correct mutex under contention

Severity: **HIGH** — board data integrity; affects every project and every writer
(CLI, agent tools, HTTP route, `reports-sync.ts`).

### Symptom
Concurrent writes lose rows and can assign the same row id twice. Reproduced in
WSL against a temp board copy:

- 40 parallel `add` → only 26 landed (14 lost).
- 20 mixed `add` (10 CLI + 10 superadmin API) → duplicate id: `F-195` assigned
  **twice** (two writers both read max `F-194`); one row clobbered.
- Isolated mutex invariant (12 procs × N locked increments) → fine at low
  contention; at 50 procs × 4 → `194/200` (6 lost).

### Root cause (proven, not speculated)
`withLock` acquires via:

```js
fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
```

`writeFileSync` is **open(O_CREAT|O_EXCL) then write**. A second process can open
and read the lock file inside that window and observe `""`. The stale check then
does:

```js
holderPid = parseInt("", 10);      // NaN
if (!pidAlive(holderPid)) { … unlinkSync(lockPath); continue; }
```

`pidAlive(NaN)` returns `false`, so the waiting process **unlinks a live lock**
and enters the critical section. An instrumented run logged `5/5` breaks with
`raw="" pid=NaN` (no break ever had a valid-but-dead PID).

### Fix
Durable: make the lock a **directory** — `fs.mkdirSync(lockPath)` is atomic and
its existence *is* the lock (no create/write window). Store the PID in
`<lockPath>/pid`; treat a missing/unparseable PID as HELD (creator mid-setup);
remove the directory only when a **valid positive** PID is provably dead.

Minimal alternative (keeps the file lock): never treat an empty/unparseable lock
as stale — only break on a finite positive dead PID — and allow a bounded age
(e.g. >5s) escape hatch for a genuinely orphaned empty lock.

### Regression test
Add to `tests/agent-harness.test.js`: spawn N processes each doing M locked
read-modify-write increments on a shared counter; assert the final value is
`N*M`. Also spawn N parallel `backlog add` and assert N distinct ids. Keep
`LOCK_TIMEOUT_MS` bounded so a real deadlock fails fast.

Note: `.backlog.lock` is already gitignored; switching file→directory needs no
`.gitignore` change.

---

## 2. `templates/scripts/qa/check-backlog.js` misses stray/secondary boards

Severity: **MEDIUM** — a shadow board can silently diverge from the canonical one.

### Symptom
LibraryOS had a second tracked board at `mobile/BACKLOG.md`, left over from an
older, separate harness install in `mobile/` (`mobile/.harness.json`,
`projectName: "mobile"`, harness v0.1.27) with its own **non-locking**
`mobile/scripts/backlog.js`. Running `npm run backlog` from `mobile/` edited the
shadow board, while agents/web UI edited the root board. `npm run test:backlog`
stayed **green** throughout.

### Fix
Section 1 of `check-backlog.js` ("only ONE canonical backlog file") currently
only asserts the root file exists. Extend it to fail on any *other* tracked
`BACKLOG.md`, e.g.:

```js
const strays = execFileSync("git", ["ls-files", "--", "*BACKLOG.md"], { cwd: root })
  .toString().split("\n").map(s => s.trim()).filter(Boolean)
  .filter(f => f !== "BACKLOG.md");
check(strays.length === 0, `no stray BACKLOG.md boards (found: ${strays.join(", ") || "none"})`);
```

Also consider routing `**/BACKLOG.md` (not just the root) through the
`backlog-libraryos` merge driver in the deployed `.gitattributes`, so a stray
board at least merges by id instead of as text.

### Acceptance
A committed `mobile/BACKLOG.md` (or any non-root `BACKLOG.md`) fails
`npm run test:backlog` with the offending path.

---

## 3. Every board mutation appends a trailing blank line

Severity: **LOW** (cosmetic, but noisy diffs and unbounded growth).

`readBacklog` splits with `src.split(/\r?\n/)`, so a file ending in `\n` yields a
final `""` element. `main()` then writes `state.lines.join(state.eol) + state.eol`
— `join` already emits a newline before that final `""`, so the extra `+ eol`
adds **one blank line at EOF on every mutation**. LibraryOS `BACKLOG.md`
accumulated ~24 trailing blank lines from routine CLI use.

Fix: write `state.lines.join(state.eol)` and append `state.eol` only when the
last element is non-empty (or normalize `join(eol).replace(/\n*$/, "\n")`).
Add an assertion to the backlog test that a no-op read-modify-write is a byte
no-op (idempotent round-trip).

---

## 4. Tool shell-outs use bare `"node"` — brittle under WSL interop

Severity: **MEDIUM** — the agent tools fail when `node` on PATH is not the Node
running opencode.

### Symptom
`templates/.opencode/tools/backlog.ts:16`,
`templates/.opencode/tools/checkpoint.ts:17`, and
`templates/.opencode/tools/session.ts:23` spawn `execFileSync("node", …)`. On WSL2
with interop, `PATH` commonly appends `/mnt/c/Program Files/nodejs` (Windows
`node.exe`) after the Linux Node; if the Linux `node` is not first — e.g. a shell
without `/usr/local/bin`, or opencode launched over UNC from Windows — the tool
runs the **Windows** node against a Linux `cwd`/paths and fails. Observed in the
LibraryOS WSL checkout: the dev server's PATH had `/usr/local/bin` first (Linux
node won), but the Windows dir was present right after, so the ordering alone was
load-bearing.

### Fix (0.1.65) — WRONG, reverted in 0.1.67
`0.1.65` used `process.execPath` in all three tool files:

```ts
execFileSync(process.execPath, [script, ...args], { … })   // WRONG
```

**Why it broke:** `process.execPath` is only Node when the host process *is*
Node. opencode ships as a **compiled standalone Bun binary** — on the WSL
LibraryOS install the npm `opencode-ai` bin is
`lib/node_modules/opencode-ai/bin/opencode.exe` (an ELF executable), and
`/proc/<opencode-pid>/exe` confirms the running process is that file. Inside
opencode's tool runtime `process.execPath` is therefore `opencode.exe`, so every
`backlog_*` / `checkpoint_*` / `session_info` call spawned
`opencode.exe scripts/backlog.js …` and re-launched opencode instead of running
the script — the tools were dead until the agent fell back to
`node scripts/backlog.js` by hand (observed 2026-09-17).

### Correct fix (0.1.67)
Resolve a **real** Node at runtime, never the host binary:

```ts
function nodeBin(): string {
  const override = process.env.OPENCODE_NODE
  if (override) return override
  const bun = (globalThis as any).Bun
  if (bun && typeof bun.which === "function") {
    const pathEnv = String(process.env.PATH || "")
    const native = process.platform === "linux"
      ? pathEnv.split(":").filter((p) => p && !p.startsWith("/mnt/")).join(":")
      : pathEnv
    const found = bun.which("node", native ? { PATH: native } : {}) || bun.which("node")
    if (found) return found
  }
  return "node"
}
```

`OPENCODE_NODE` is an explicit escape hatch; `Bun.which` finds node on PATH and
skips WSL `/mnt/*` (9p/interop) entries so the native Linux node wins over the
Windows `node.exe`; the bare `"node"` fallback preserves the pre-0.1.65
behavior. `templates/.opencode/tools/*` is the harness-owned surface. The
project-owned companion is the LibraryOS web route
`app/api/admin/backlog/route.ts` (it also shells out); a project shell-out is
correct as long as the process executing it *is* Node (a Next.js route runs
under Node, so `process.execPath` there is fine).

### Regression
Static gate over `templates/.opencode/tools/**`: every tool must call
`execFileSync(nodeBin(), …)` and must **not** reference `process.execPath`.
(`tests/agent-harness.test.js` — "opencode tools resolve a real node runtime".)

---

## 5. `commitHarnessChanges` commits the whole index — it sweeps in other sessions' staged work

Severity: **HIGH** — a harness `chore` commit can capture and **push** another
session's half-finished work.

### Symptom
During the `0.1.64` WSL-hardening deploy to LibraryOS, the run changed only two
root files (`scripts/qa/check-prefix-stability.js` overwritten, `.gitattributes`
merged), yet its auto-commit `c323a2d`
(`chore(harness): opencode-agent-harness 0.1.63 -> 0.1.64`) contained **17
files**, including a concurrent F-213 session's **pre-staged** `mobile/*`
deletions. That unrelated work was carried into a harness commit and pushed to
`origin/main`. Evidence: the 0.1.64 session; `git show --stat c323a2d` vs the
deploy's `[overwrite]/[merge]` actions.

### Root cause
In `bin/agent-harness.js` `commitHarnessChanges()` (≈ lines 382–436) the helper
force-adds only `changedRels`:

```js
const addR = runGit(target, ["add", "-f", "--", ...changedRels]);
…
const diffCached = runGit(target, ["diff", "--cached", "--name-only"]);   // whole index
const staged = (diffCached.out || "").split(/\r?\n/).filter(Boolean)…
out.staged = staged;
const commitR = runGit(target, ["commit", "-m", message]);                // no pathspec
```

`git diff --cached --name-only` and a bare `git commit` operate on the **entire
index**, not this run's paths. Any path already staged before the update (another
session, a partial `git rm`, etc.) is committed too. The header comment's promise
— "Scoped to this run's changed harness files (never `git add -A`) so unrelated
uncommitted work is NEVER swept in" — only holds for *unstaged* changes; it
silently includes *staged* ones. `out.staged` is also misleading (it reports the
whole index as this run's changes).

Related but separate: because only `changedRels` are ever staged, a harness-owned
file that exists on disk, is gitignored, and was never touched by a committed
update stays untracked forever — a fresh clone is not hermetic until `init`/`update`
re-materializes it (observed: 7 `.agents/skills/*` + `.agents/memory/model-routing.md`
in LibraryOS, identical on Windows — pre-existing, low priority).

### Fix
Commit by **pathspec** so other staged entries stay in the index:

```js
const commitR = runGit(target, ["commit", "-m", message, "--", ...changedRels]);
```

and compute the reported set with the same scope:
`git diff --cached --name-only -- <changedRels>`. Do not rely on "the index is
empty of unrelated work"; never `git commit` without a pathspec here. (If a
`changedRels` path was not actually changed, `git commit -- <paths>` is a no-op
and the existing "no harness changes staged" handling should key off the scoped
diff, not the full index.)

### Regression test
In a temp git repo: stage an unrelated file A, then call `commitHarnessChanges`
for a different changed path B (and the config file) and assert (a) the new
commit contains only B + config, (b) A is still staged after the call, and
(c) `out.staged` lists only B. Reuse the existing deploy/commit test harness.

---

## 6. BACKLOG merge driver is registered against the `--target` path — a worktree target leaves a dangling per-clone driver

Severity: **MEDIUM** — silent loss of row-aware `BACKLOG.md` merging after a
feature worktree is removed; surfaces only at the next concurrent board merge.

### Symptom
On the WSL LibraryOS clone, the per-clone config held
`merge.backlog-libraryos.driver = node "<abs>/scripts/qa/merge-backlog.js" %O %A %B`
where `<abs>` was a **deleted feature worktree**,
`~/develop/.worktrees/PublicVirtualLibrary/f-189/...`. The Windows clone pointed at
the main tree and worked, so the breakage was WSL-only and silent until a merge
touched `BACKLOG.md`. Repaired by hand (local config only) during the 2026-09-16
WSL deployment audit.

### Root cause
Git config is **per-clone and shared by every linked worktree**
(`$GIT_COMMON_DIR/config`). `registerBacklogMergeDriver()` (`bin/agent-harness.js`
≈ lines 345–356, called from `deploy()` at ≈ :527) writes an **absolute path
derived from the target it is handed**:

```js
const driverScript = path.join(target, "scripts", "qa", "merge-backlog.js")…
const driver = `node "${driverScript}" %O %A %B`;
```

Any `init`/`update` invoked with `--target` (or cwd) inside a feature worktree
poisons the *shared* config with a path into that worktree. When the worktree is
removed (`backlog archive`, `git worktree remove`), the driver dangles for the
main checkout and every other worktree.

### Fix
Resolve and register the **main worktree** regardless of which checkout ran the
update — e.g. take the first `worktree` entry from
`git worktree list --porcelain`, or `path.dirname(git rev-parse --git-common-dir)`
— and use that for `driverScript`. Prefer a stable, relocation-tolerant form
(relative to the common dir) so a moved/renamed main checkout cannot dangle
either. Re-running `update` from the main tree already repairs the pointer, but
the code should not be able to write a worktree path in the first place.

### Regression test
In a temp repo with one linked worktree, run `update --target <worktree>` and
assert `git -C <main> config merge.<driver>.driver` resolves to the **main**
worktree's `scripts/qa/merge-backlog.js`, then remove the worktree and assert the
configured path still exists.

---

## 7. `merge-backlog.js` `rebuild()` drops nearly every row — `resolved` values carry no `key`

Severity: **HIGH** — board data integrity; a single conflicting row destroys the
rest of `BACKLOG.md`.

Status: **FIXED in `0.1.68`** (found 2026-09-17; `decode()` now carries the row
key through to `rebuild()`, plus multi-row-per-section regression tests).
`templates/scripts/qa/merge-backlog.js` (identical to the deployed LibraryOS
twin).

### Symptom
A `git stash pop` (or any merge) that hits a genuine `BACKLOG.md` row conflict
leaves the working file **almost empty**. On the WSL LibraryOS clone, syncing local
`main` with `origin/main` (shipped F-153 archive row vs. an uncommitted
In-progress row for the same id) produced:

- driver: `merge-backlog: 1 conflicting row(s): F-153`
- `.gitattributes`-driven `%A` board: **884 lines / 228 rows → 73 lines**
- only **one** row survived per section; 207 of 216 resolved rows were lost.

Nothing was permanently lost only because a pre-stash copy of the board existed
(`cp BACKLOG.md` before stashing). A merge with no such backup loses the board.

### Root cause (proven, reproduced)
`merge()` stores `resolved` values as `decode(v)` = `{ section, line }` — **no
`key`**:

```js
function decode(v) {
  const i = v.indexOf("\u0000");
  return { section: v.slice(0, i), line: v.slice(i + 1) };   // <-- no key
}
// 3 set sites, e.g.:
resolved.set(k, decode(ov));   // the map key `k` is dropped from the value
```

But `rebuild()` reads the value's `.key`:

```js
for (const k of oursOrder.get(section) || []) {
  const r = rows.find((x) => x.key === k);   // x.key === undefined -> never matches
  if (r) { seen.add(k); ordered.set(k, r.line); }
}
for (const r of rows) if (!seen.has(r.key)) ordered.set(r.key, r.line);  // keyed on undefined
```

`x.key` / `r.key` are always `undefined`, so the first loop is a no-op and the
fallback collapses each section's `ordered` Map to a single entry (last row wins).
`merge()` itself is correct (216 rows resolved, 1 conflict) — the corruption is
entirely in `rebuild()`.

Instrumented run (base = merge base, ours = 884-line board, theirs = 885-line):

```
resolved: 216  conflicts: 1
archive  start=114 del=157 ins=3   885 -> 731    # ins=3 = header+sep+1 row, not 162
frozen   start=96  del=15  ins=3
open     start=51  del=40  ins=3
queued   start=44  del=2   ins=2
inprogress start=37 del=2  ins=3
epics    start=18  del=12  ins=3
mod.rebuild lines: 674 (45 non-empty)
```

Secondary amplification: the LibraryOS board currently carries ~628 blank lines,
which `rebuild()` preserves; the conflict branch's `out.replace(/\s*$/, "")` then
trims the trailing blanks before appending the conflict block, so the on-disk
artifact collapses to 73 lines. The root cause is the missing key, not the trim.

### Why the tests missed it
`tests/agent-harness.test.js` merge-backlog tests use fixtures with **at most one
row per section** and assert "F-001 appears exactly once" / "F-002 appears exactly
once". A section collapsed to its single row is indistinguishable from a correct
merge, so `rebuild()`'s row-dropping is invisible. `merge()`'s `resolved` Map is
asserted; `rebuild()` is never checked for preserving N>1 rows.

### Fix
Carry the row key into the resolved value so `rebuild()` can key by it. In
`merge()`:

```js
const dec = (v) => { const { section, line } = decode(v); return { key: k, section, line }; };
resolved.set(k, dec(ov));   // at all three set sites
```

(or, in `rebuild()`, iterate `for (const [k, r] of resolved)` and assign
`r.key = k` instead of iterating `for (const [, r] of resolved)`). Add `key` to
the documented shape of a `merge()` resolved value.

### Regression test
In `agent-harness.test.js`: a board with **multiple rows per section** (e.g. open
with 2+ and archive with 3+), run `merge()` + `rebuild()`, and assert every input
row key appears exactly once and no section loses rows. Add an end-to-end driver
conflict run (both sides change one row) over such a board and assert all
non-conflicting rows survive in the written `%A`. Keep `npm test` green.

### Acceptance
A conflicting `BACKLOG.md` merge preserves every non-conflicting row: the written
board has no fewer data rows than `|(base ∪ ours ∪ theirs) minus conflicts|`, and
`rebuild()` round-trips a multi-row-per-section board unchanged when both sides
are equal.
