import type { Context } from "@opencode/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import guard from "../../scripts/qa/context-guard-core.js"
import runLoop from "../../scripts/qa/run-loop.js"
import checkpoint from "../../scripts/checkpoint.js"
import featureResolver from "../../scripts/qa/feature-resolver.js"
import capacity from "../../scripts/qa/capacity-lib.js"
import leases from "../../scripts/qa/lease-lib.js"
import toolLib from "../../scripts/qa/tool-lib.js"
import storeLib from "../../scripts/qa/store-lib.js"

// Mechanical half of the context budget: read the project-owned thresholds from
// `.agents/memory/orchestration.md` and nudge the PRIMARY orchestrator session as
// it crosses them. The nudge is injected into the conversation TAIL via the V2
// `context` session hook, never the system prompt: changing the
// system prefix on a band crossing evicts the provider's whole prompt cache and
// re-bills the entire transcript at full input price (measured: every full-price
// re-read landed on turn 50/60/80/100). Appending at the tail keeps the cached
// prefix byte-stable. Also counts identical tool+args calls (loop detector),
// whole turns with no material file/state change (no-state detector), and
// repeated failures sharing a signature (same-failure detector), and records
// crossings in `.agents/guard-events.jsonl` (local-only, excluded clone-locally)
// so telemetry exists before a full provider-stats pass does.
// It also hard-stops on provider funds/quota errors (see model-routing.md
// "Provider funds stop") so a failed dispatch can never silently degrade inline.
// Child sessions (subagent dispatches) are tracked to attribute their funds
// errors to the orchestrator *with the failing provider/model* — the top-up
// target comes from observed dispatch metadata (task `metadata.model` or the
// child assistant message `providerID/modelID`), never a guess.
// It also blocks a branch switch (`git checkout`/`git switch`) while another
// live primary session shares the same checkout — see the branch-switch guard
// on `tool.execute.before` (the 2026-09-18 direct-push-to-main incident) — and
// blocks any code change aimed at the shared MAIN checkout until the session
// isolates into its feature worktree (the F-278 stranded-work guard). Git ops
// are judged by the paths they actually move against the checkout they select
// (`-C` resolved), so docs maintenance on main — and only that — stays allowed.

const ORCHESTRATION_REL = path.join(".agents", "memory", "orchestration.md")
const GUARD_LOG_REL = path.join(".agents", "guard-events.jsonl")

/* Stable id for the synthetic tail message the guard injects. The transform is
 * per-request (never persisted), so this only needs to be stable within one
 * request-building pass — where it lets a re-request replace the message in
 * place instead of stacking duplicates. */
const GUARD_MESSAGE_ID = "context-guard"


export default {
  id: "context-guard",
  async setup(ctx: Context) {
  const directory = ctx.location.directory as string
  // V2: plugin registrations live for the plugin's lifetime; this controller
  // aborts the event subscription on unload.
  const controller = new AbortController()
  const sessions = new Map<string, any>()
  const childSessions = new Set<string>()
  const childParent = new Map<string, string>()
  const sessionModel = new Map<string, string>()
  let thresholds: any = null
  let thresholdsMtime = -1
  const ORCHESTRATION_ABS = path.join(directory, ORCHESTRATION_REL)

  /* Root resolution. `directory` is the location this instance was loaded for;
   * it is correct for a session in that location but NOT for a session in
   * another (the V2 event stream is process-wide). `session.created` carries the
   * session's own location, so it is recorded per session and preferred. */
  const normDir = (p: unknown) => guard.normalizeRootPath(p)
  const ourRoot = normDir(directory)
  const sessionRoots = new Map<string, string>()
  /* When this plugin observed each primary session start. The main-checkout
   * resume selector uses it to accept a checkpoint written during THIS session
   * even when the plugin missed the session's earlier turns (a reload). */
  const sessionStarts = new Map<string, number>()
  const rootOf = (sessionID: string) => sessionRoots.get(sessionID) || directory
  /* Both sides known -> strict (normalized) comparison, with the Windows
   * case-insensitive rule; `guard.ownsLocation` is the one home for that rule. */
  const sameRoot = (a: string, b: string) => {
    const x = normDir(a)
    const y = normDir(b)
    return x !== "" && y !== "" && guard.ownsLocation(x, y)
  }
  const sameLocation = (event: any) => {
    // The session's own location (payload) is the most specific; the envelope
    // carries the location for the other event types.
    const loc = event?.data?.location?.directory ?? event?.location?.directory
    return guard.ownsLocation(directory, loc)
  }

  /* Is this session ours? Tool hooks and the context/prompt hooks carry only a
   * sessionID (no location), so they use this instead of the event envelope.
   * Known sessions answer from the recorded root; an unseen session is resolved
   * from the store once (authoritative), and an undeterminable one is treated as
   * ours so a guard is never skipped. */
  /* `session_move` re-homes a session in the store, so this answer has a TTL:
   * a forever-cached directory would keep the old plugin instance treating the
   * session as its own (heartbeating a GHOST lease) and the new instance
   * filtering it out — F-021. */
  const STORE_DIR_TTL_MS = 60_000
  const storeDirs = new Map<string, { dir: string; at: number }>()
  const storeDir = (sessionID: string) => {
    const hit = storeDirs.get(sessionID)
    if (hit && Date.now() - hit.at < STORE_DIR_TTL_MS) return hit.dir
    let dir = ""
    try {
      dir = storeLib.sessionDirectory(sessionID) || ""
    } catch {
      dir = ""
    }
    storeDirs.set(sessionID, { dir, at: Date.now() })
    return dir
  }
  const sessionOurs = (sessionID: unknown): boolean => {
    const sid = typeof sessionID === "string" ? sessionID : ""
    if (!sid) return true
    const known = sessionRoots.get(sid)
    if (known) return sameRoot(normDir(known), ourRoot)
    const dir = storeDir(sid)
    if (dir) return sameRoot(normDir(dir), ourRoot)
    return true
  }

  const stateFor = (sessionID: string) => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = guard.createSessionState()
      sessions.set(sessionID, state)
    }
    return state
  }

  /* Walk a subagent session up to the primary orchestrator it belongs to, so a
   * child's funds error arms the stop on the session the user actually sees. */
  const primaryRoot = (sessionID: string) => {
    let cur = sessionID
    for (let i = 0; i < 100 && childParent.has(cur); i++) cur = childParent.get(cur) as string
    return cur
  }

  /* Arm the funds stop on the primary session, naming the failed provider/model
   * (when observed) in the injected rule, the guard-event log, and the TUI log. */
  const armFunds = async (sessionID: string, label: string | null, source: string) => {
    const owner = primaryRoot(sessionID)
    const state = stateFor(owner)
    if (state.fundsPending) return
    state.fundsPending = true
    state.fundsNotice = guard.fundsText(label, source)
    const [provider, model] = label
      ? label.includes("/")
        ? [label.slice(0, label.indexOf("/")), label.slice(label.indexOf("/") + 1)]
        : [null, label]
      : [null, null]
    logEvent({
      kind: "funds",
      sessionID: owner,
      failedSessionID: sessionID === owner ? null : sessionID,
      provider,
      model,
      source,
    })
    await report(`${label || "unknown provider/model"} — provider funds/quota error (${source}) — pausing for top-up`)
  }

  const isPrimary = (sessionID: unknown): sessionID is string =>
    typeof sessionID === "string" && sessionID.length > 0 && !childSessions.has(sessionID)

  /* The V2 shell tool is named `shell`; V1 called it `bash`. Accept both so the
   * pure core and any transitional caller keep working. */
  const isShell = (tool: unknown): boolean => {
    const n = String(tool || "").toLowerCase()
    return n === "bash" || n === "shell"
  }

  /* Read `.agents/memory/orchestration.md` once and cache it, re-reading whenever
   * the file's mtime changes. This replaces V1's `file.watcher.updated` branch
   * (that event name does not exist in V2): a plain stat is cheaper than relying on
   * an event we have not observed firing in 2.0.29, and it cannot go stale. */
  const loadThresholds = () => {
    let mtime = -1
    try {
      mtime = fs.statSync(ORCHESTRATION_ABS).mtimeMs
    } catch {
      /* missing/unreadable -> documented defaults from the core */
    }
    if (thresholds && mtime === thresholdsMtime) return thresholds
    let text = ""
    try {
      text = fs.readFileSync(ORCHESTRATION_ABS, "utf8")
    } catch {
      /* missing/unreadable -> documented defaults from the core */
    }
    thresholds = guard.parseThresholds(text)
    /* Todo capability: `todowrite` exists only while the active config enables
     * `experimental.todo` (default false). A project that turns it off explicitly
     * opts out; nudging into an absent tool is noise the model cannot satisfy. */
    let todoFlag: unknown = undefined
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(directory, "opencode.json"), "utf8"))
      todoFlag = cfg?.experimental?.todo
    } catch {
      /* no/parse-failed config -> leave the core default (enabled) */
    }
    if (todoFlag === false) thresholds.todo = { ...(thresholds.todo || {}), enabled: false }
    thresholdsMtime = mtime
    return thresholds
  }

  const logEvent = (event: Record<string, unknown>) => {
    try {
      const file = path.join(rootOf(String(event.sessionID || "")), GUARD_LOG_REL)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // `root` makes a mis-attributed event self-evident in the log (the guard
      // root must always be the session's own checkout).
      fs.appendFileSync(file, guard.formatGuardEvent({ ...event, root: rootOf(String(event.sessionID || "")) }), "utf8")
    } catch (err: any) {
      // Best-effort telemetry, but never silent: a missing guard log left a real
      // detection unattributable once (LibraryOS) — surface the write failure.
      void report(`guard-event log write failed: ${err?.message || err}`)
    }
  }

  // V2 plugins have no `client`; log to the opencode server log (stdout/stderr).
  const report = async (message: string, level: "info" | "warn" = "warn") => {
    try {
      if (level === "info") console.log(`context-guard: ${message}`)
      else console.warn(`context-guard: ${message}`)
    } catch {
      /* logging is best-effort */
    }
  }

  /* Per-tree primary-session lease. `test:concurrency` reads `.serve/sessions/`
   * to fail when two primary sessions share one checkout — a collision that
   * exists even on a clean tree. The lease carries a process birth token
   * (bootId + /proc starttime) and a heartbeat, both defined in lease-lib.js, so
   * a recycled pid or a closed TUI can't masquerade as a live session.
   * Best-effort (never throws into the hook). */
  const writeLease = (sessionID: string) => {
    try {
      leases.writeLease(rootOf(sessionID), sessionID)
    } catch {
      /* lease is best-effort */
    }
  }
  const clearLeaseAt = (root: string, sessionID: string) => {
    if (!root || !sessionID) return
    try {
      leases.clearLease(root, sessionID)
    } catch {
      /* lease is best-effort */
    }
  }
  const clearLease = (sessionID: string) => clearLeaseAt(rootOf(sessionID), sessionID)
  const touchLeaseAt = (root: string, sessionID: string) => {
    if (!root || !sessionID) return
    try {
      leases.touchLease(root, sessionID)
    } catch {
      /* lease is best-effort */
    }
  }
  /* Keep exactly ONE lease for a session: the one in the tree the store says it
   * lives in. A tool/step heartbeat from any instance first resolves that
   * directory; if this instance's tree is no longer the session's home, its
   * GHOST lease (and `.worktree` pointer) is retired here instead of heartbeated
   * forever. This is the writer-side half of F-021; the backlog reader also
   * filters by the store so a quiet moved session cannot block a prune. */
  const reconcileLease = (sessionID: string) => {
    try {
      const root = storeDir(sessionID) || rootOf(sessionID)
      if (sameRoot(root, directory)) touchLeaseAt(directory, sessionID)
      else clearLeaseAt(directory, sessionID)
    } catch {
      /* lease is best-effort */
    }
  }

  /* Classify the checkout that encloses a path WITHOUT invoking git (git is not
   * guaranteed on the plugin process's PATH). A main worktree's `.git` is a
   * DIRECTORY; a linked feature worktree's `.git` is a FILE (`gitdir: ...`), so
   * walking up to the first `.git` and checking its type is enough. Returns
   * "main" | "linked" | null (outside a repo). The path may not exist yet (a
   * new file), so start from its nearest existing ancestor. */
  const checkoutKind = (p: string): "main" | "linked" | null => {
    let dir = path.resolve(p)
    // A new file's parents may not exist yet: start from the nearest existing dir.
    while (dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir)
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir)
    for (let i = 0; i < 64; i++) {
      try {
        return fs.statSync(path.join(dir, ".git")).isDirectory() ? "main" : "linked"
      } catch {
        /* no .git here — keep walking up */
      }
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
    return null
  }

  /* The repo root enclosing a path (nearest ancestor holding a `.git`), or null.
   * Lets the main-checkout refusal tell a SAME-repo edit (isolate here) from a
   * CROSS-repo one (F-12: a project session editing the harness `templates/`),
   * which worktree isolation cannot reach. */
  const repoRootOf = (p: string): string | null => {
    let dir = path.resolve(p)
    while (dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir)
    if (fs.existsSync(dir) && !fs.statSync(dir).isDirectory()) dir = path.dirname(dir)
    for (let i = 0; i < 64; i++) {
      if (fs.existsSync(path.join(dir, ".git"))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) return null
      dir = parent
    }
    return null
  }

  const expandHome = (p: string): string => {
    const s = String(p || "")
    if (s === "~") return os.homedir()
    if (s.startsWith("~/")) return path.join(os.homedir(), s.slice(2))
    return s
  }

  /* The tree a session's bash calls should default to: the recorded mid-session
   * worktree pointer when this session (or its primary ancestor) created one,
   * else null (fall back to the launch directory). Used to reroot `cd X && ...`
   * into the bash `workdir` argument — opencode pins a session to the tree it
   * launched in, and `--open` is rarely used, so agents otherwise `cd` by hand. */
  const sessionBashRoot = (sessionID: string): string | null => {
    try {
      const root = primaryRoot(sessionID)
      const ptr = leases.readWorktree(directory, root)
      if (!ptr) return null
      const abs = path.resolve(expandHome(ptr))
      return fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : null
    } catch {
      return null
    }
  }

  /* The feature id the session should isolate: the board's single In-progress
   * row, or null. Best-effort and cached-ish (a fresh read per refusal only —
   * refusals are rare). Used to hand back the exact `backlog worktree <id>`
   * command in the main-checkout refusal, never a bare error. */
  const inferBoardFeature = (sessionID: string): string | null => {
    try {
      const root = sessionBashRoot(sessionID) || directory
      const out = gitOut(root, ["branch", "--show-current"])
      const fromBranch = out && out.match(/^[fF]-\d+/)
      if (fromBranch) return fromBranch[0].toUpperCase()
      const backlog = path.join(root, "BACKLOG.md")
      if (!fs.existsSync(backlog)) return null
      const text = fs.readFileSync(backlog, "utf8")
      const section = (text.split(/^##\s*In progress\s*$/m)[1] || "").split(/^##\s/m)[0]
      const ids = [...section.matchAll(/^\|\s*([Ff]-\d+)\s*\|/gm)].map((m) => m[1].toUpperCase())
      return ids.length === 1 ? ids[0] : null
    } catch {
      return null
    }
  }

  /* ------------------------------------------------- auto clear-resume (F-051/F-061)
   * The runner (`agent-harness run`) relaunches a fresh bounded context instead
   * of stopping mid-feature, but it cannot see this session's request context.
   * The guard records the crossing: a marker carries the feature id and the
   * checkpoint count a fresh context would resume from.
   *
   * A linked feature worktree names its feature on the branch and keeps the
   * original F-051 path. A MAIN checkout does not, so F-061 writes a marker only
   * when the pure selector proves exactly ONE recent checkpoint (the lease gate
   * and the 2h/60s rules refuse everything else). No marker means the TUI keeps
   * the advisory nudge and no session is relaunched. */
  const writeLinkedContextResume = (sessionID: string, tokens: number | null, root: string) => {
    const feature = guard.featureFromBranch(gitOut(root, ["branch", "--show-current"]))
    if (!feature) return
    let handoff = ""
    try {
      handoff = fs.readFileSync(path.join(root, ".agents", "handoffs", feature + ".md"), "utf8")
    } catch {
      /* no checkpoint yet — the crossing cannot be resumed (F-064) */
    }
    /* No checkpoint => nothing to seed a fresh context from: the marker would
     * only make the TUI consume it and stop with "did not advance the
     * checkpoint". Record the skip instead, so the absence is observable and
     * the advisory nudge stays the only action. */
    if (!runLoop.hasResumableCheckpoint(handoff)) {
      logEvent({
        kind: "context-resume-skip",
        sessionID,
        feature,
        reason: "no resumable checkpoint (no checkpoint_count/next_action in the handoff)",
      })
      return
    }
    const marker = guard.contextResumeMarker({
      feature,
      sessionID,
      tokens,
      checkpointCount: runLoop.checkpointCount(handoff),
      at: new Date().toISOString(),
    })
    const file = path.join(root, guard.CONTEXT_RESUME_REL)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(marker, null, 2) + "\n", "utf8")
    logEvent({
      kind: "context-resume",
      sessionID,
      feature,
      tokens: marker.tokens,
      checkpointCount: marker.checkpoint_count,
    })
  }

  /* In-progress board rows that declare a handoff, stem -> row id. The LOCAL
   * BACKLOG.md only: this runs inside the synchronous crossing hook, so it must
   * never wait on the shared board service (the plugin has no client and a
   * blocking read would stall the event loop). */
  const inProgressHandoffStems = (root: string): Map<string, string> => {
    const map = new Map<string, string>()
    let text = ""
    try {
      text = fs.readFileSync(path.join(root, "BACKLOG.md"), "utf8")
    } catch {
      return map
    }
    const section = (text.split(/^##\s*In progress\s*$/m)[1] || "").split(/^##\s/m)[0]
    for (const raw of section.split(/\r?\n/)) {
      const line = raw.trim()
      if (!/^\|.*\|$/.test(line)) continue
      if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue
      const cells = line.slice(1, -1).split("|").map((cell) => cell.trim())
      const id = cells[0] || ""
      if (!/^[A-Za-z]+-\d+$/.test(id)) continue
      const stem = featureResolver.handoffStem(cells[3] || "")
      if (stem) map.set(stem.toLowerCase(), id.toUpperCase())
    }
    return map
  }

  /* Checkpoints a MAIN checkout may resume. Only THIS checkout's handoffs are
   * scanned: resuming worktree-owned state from main would force a session
   * move, which the TUI deliberately never does. A slug-named handoff is mapped
   * to its In-progress row; an id-named handoff names its own feature. Landed
   * outcomes are skipped here, and the selector refuses any ambiguity. */
  const mainResumeCandidates = (root: string): any[] => {
    const stems = inProgressHandoffStems(root)
    const dir = path.join(root, ".agents", "handoffs")
    let names: string[] = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return []
    }
    const out: any[] = []
    for (const name of names) {
      if (!name.toLowerCase().endsWith(".md") || name.toLowerCase() === "readme.md") continue
      const file = path.join(dir, name)
      let text = ""
      try {
        text = fs.readFileSync(file, "utf8")
      } catch {
        continue
      }
      const parts = checkpoint.splitCheckpoint(text)
      if (!parts.body) continue
      const state = checkpoint.parseBlock(parts.body)
      const checkpointCount = Number(state.checkpoint_count) || 0
      if (checkpointCount <= 0) continue
      const meta = checkpoint.parseBlock((parts.before || "") + "\n" + (parts.after || ""))
      const outcome = meta.outcome ? String(meta.outcome).trim().toLowerCase() : ""
      if (outcome === "shipped" || outcome === "resolved") continue
      const stem = name.slice(0, -3)
      const feature = guard.featureFromBranch(stem) || stems.get(stem.toLowerCase()) || null
      if (!feature) continue
      let updated = 0
      try {
        updated = fs.statSync(file).mtimeMs
      } catch {
        continue
      }
      out.push({
        feature,
        checkpointCount,
        session: state.session ? String(state.session) : null,
        updated,
        landed: false,
      })
    }
    return out
  }

  const writeMainContextResume = (sessionID: string, tokens: number | null, root: string) => {
    /* One live primary per checkout. A second session here must never race this
     * one into the same main-checkout resume; the same leases the branch-switch
     * guard reads decide it. */
    let others: any[] = []
    try {
      others = leases
        .liveLeasesIn(root, { resolveDir: storeLib.sessionDirectory })
        .filter((rec: any) => rec.sessionID !== sessionID)
    } catch {
      others = []
    }
    if (others.length > 0) {
      logEvent({
        kind: "context-resume-skip",
        sessionID,
        reason: "another live session shares the main checkout",
        others: others.map((rec: any) => rec.sessionID),
      })
      return
    }
    const candidate = guard.selectMainResumeCandidate({
      sessionID,
      sessionStartedAt: sessionStarts.get(sessionID),
      candidates: mainResumeCandidates(root),
    })
    if (!candidate.feature) {
      logEvent({ kind: "context-resume-skip", sessionID, reason: candidate.reason })
      return
    }
    const marker = guard.contextResumeMarker({
      feature: candidate.feature,
      sessionID,
      tokens,
      checkpointCount: candidate.checkpointCount,
      at: new Date().toISOString(),
      main: true,
    })
    const file = path.join(root, guard.CONTEXT_RESUME_REL)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(marker, null, 2) + "\n", "utf8")
    logEvent({
      kind: "context-resume",
      sessionID,
      feature: candidate.feature,
      tokens: marker.tokens,
      checkpointCount: marker.checkpoint_count,
      main: true,
    })
  }

  const writeContextResume = (sessionID: string, tokens: number | null) => {
    try {
      const root = rootOf(sessionID)
      const kind = checkoutKind(root)
      if (kind === "linked") {
        writeLinkedContextResume(sessionID, tokens, root)
        return
      }
      if (kind === "main") writeMainContextResume(sessionID, tokens, repoRootOf(root) || root)
    } catch {
      /* best-effort handshake — the runner stops when no marker exists */
    }
  }

  /* Trimmed stdout of a git command run in `cwd`, or null on ANY failure (git
   * absent, not a repo, bad ref). null is "unknown": the caller stays
   * conservative and blocks, so a missing git binary can never open a hole. */
  const gitOut = (cwd: string, args: string[]): string | null => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim()
    } catch {
      return null
    }
  }

  /* Whether a PATHLESS git op would move a code path, resolved against the live
   * checkout. `commit` inspects the index (or the `HEAD` diff for `-a`); `push`
   * inspects the commits not yet on the upstream. Docs-only -> false; anything
   * indeterminate (git unavailable, no upstream) -> null, which blocks. */
  const gitOpTouchesCode = (checkout: string, op: any): boolean | null => {
    const sub = String(op?.subcommand || "")
    const args: string[] = Array.isArray(op?.args) ? op.args : []
    const nameOnly = (spec: string[]): string | null => gitOut(checkout, [...spec, "--name-only"])
    let files: string | null
    if (sub === "commit") {
      const all = args.some((a) => a === "--all" || (/^-[a-z]+$/i.test(a) && a.includes("a")))
      if (args.includes("--amend")) {
        const committed = gitOut(checkout, ["diff", "--name-only", "HEAD^", "HEAD"])
        const staged = gitOut(checkout, ["diff", "--cached", "--name-only"])
        if (committed == null || staged == null) return null // root commit / unborn HEAD
        files = committed + "\n" + staged
      } else {
        files = all ? nameOnly(["diff", "HEAD"]) : nameOnly(["diff", "--cached"])
      }
    } else if (sub === "push") {
      const upstream = gitOut(checkout, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
      if (!upstream) return null
      files = nameOnly(["diff", `${upstream}..HEAD`])
    } else {
      // merge/rebase/am/cherry-pick/revert/reset/clean/stash are not the docs
      // maintenance carve-out — block them conservatively.
      return null
    }
    if (files == null) return null
    return files
      .split(/\r?\n/)
      .filter(Boolean)
      .some((p) => guard.isCodePath(p))
  }

  /* Tools whose args name the file they write. `patch`/`apply_patch` may carry
   * only a diff, in which case the target is unknown and the guard stands
   * down — the edit/write paths still cover the F-278 shape. */
  const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"])

  /* Best-effort board convergence at session start: the main checkout drifts
   * behind `origin/main` while features land from their worktrees, so a stale
   * BACKLOG.md can show a shipped row as Open. Fire-and-forget (never blocks
   * session creation, never throws into the hook); a linked worktree no-ops in
   * `backlog sync`. */
  const syncBoard = () => {
    try {
      const script = path.join(directory, "scripts", "backlog.js")
      if (!fs.existsSync(script)) return
      const child = spawn(toolLib.nodeBin(), [script, "sync"], {
        cwd: directory,
        stdio: "ignore",
        detached: true,
      })
      child.on("error", () => {})
      child.unref()
    } catch {
      /* best-effort */
    }
  }

  /* Best-effort update probe at each context boundary: compare the deployed
   * harness version with the registry (or a newer local harness checkout) so the
   * session and the TUI badge can say "update available" — like opencode's own
   * notice. Spawned detached and `--force`d, so a new/cleared/compacted context
   * always re-checks the registry instead of trusting a 24h-old verdict; a
   * project still running an older probe also honours `--force`. A repo without
   * the script simply no-ops. */
  const refreshHarnessUpdate = (root: string) => {
    try {
      const script = path.join(root, "scripts", "harness-update.js")
      if (!fs.existsSync(script)) return
      const child = spawn(toolLib.nodeBin(), [script, "refresh", "--root", root, "--force"], {
        cwd: root,
        stdio: "ignore",
        detached: true,
      })
      child.on("error", () => {})
      child.unref()
    } catch {
      /* best-effort */
    }
  }

  /* Session-start orientation injection. A resume/claim session otherwise spends
   * its prologue re-deriving git/serve/capacity state and re-reading the
   * session-start memory files (the 2026-10 LibraryOS recon measured a 24-call
   * average prologue across 193 sessions and `serve.js list` 91×). Run the
   * one-call `orient --brief` OFF the event loop (async — it spawns git/backlog)
   * and stash its text on the session state; the transform injects it into the
   * cache-safe tail until the first material action clears it. Best-effort:
   * a missing script or a failed spawn injects nothing and never blocks. */
  /* Identity of the tree a brief snapshot describes. The brief is collected once
   * at session start, but the tree can change under it — a harness update lands
   * its commit seconds later — and re-injecting that snapshot then reports an old
   * HEAD/version while the TUI badge reads the live `.harness.json` (2026-11-25:
   * the brief said 0.4.16, the badge 0.4.17, and the agent asked for a server
   * restart over a difference that no longer existed). Two cheap stats plus the
   * deployed version are enough to know the snapshot moved. */
  const treeStamp = (root: string): string => {
    let gitDir = path.join(root, ".git")
    try {
      if (fs.statSync(gitDir).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitDir, "utf8"))
        gitDir = m ? path.resolve(root, m[1].trim()) : ""
      }
    } catch {
      gitDir = ""
    }
    const mtime = (p: string) => {
      try {
        return fs.statSync(p).mtimeMs
      } catch {
        return 0
      }
    }
    let version = ""
    try {
      const v = JSON.parse(fs.readFileSync(path.join(root, ".harness.json"), "utf8")).version
      if (typeof v === "string") version = v
    } catch {
      /* no harness here */
    }
    const index = gitDir ? mtime(path.join(gitDir, "index")) : 0
    return `${index}:${mtime(path.join(root, ".harness.json"))}:${version}`
  }

  const collectOrient = async (sid: string, root: string) => {
    try {
      const script = path.join(root, "scripts", "orient.js")
      if (!fs.existsSync(script)) return
      const res = await toolLib.runScriptAsync(
        { directory: root, sessionID: sid },
        "scripts/orient.js",
        ["--brief", "--root", root],
        { label: "orient", timeout: 25000 }
      )
      const text = String(res.stdout || "").trim()
      if (res.code !== 0 || !text) return
      const state = stateFor(sid)
      state.orientText = text
      state.orientStamp = treeStamp(root)
      state.orientPending = true
      logEvent({ kind: "orient", sessionID: sid, bytes: text.length })
    } catch {
      /* best-effort — orientation is an accelerator, never a gate */
    }
  }

  // Sweep leases left by crashed/closed sessions so they can never block the
  // concurrency gate. Runs once per plugin load (best-effort).
  try {
    const pruned = leases.pruneLeases(directory)
    if (pruned.length) {
      void report(`pruned ${pruned.length} stale session lease(s) in this tree`)
    }
  } catch {
    /* best-effort */
  }

  /* V2 ModelRef ({ id, providerID, variant }) -> the shape `guard.modelLabel`
   * reads ({ providerID, modelID }). Never invent a label. */
  const modelFields = (m: any) =>
    m && typeof m === "object" ? { providerID: m.providerID, modelID: m.id } : null

  const hooks = {
    event: async ({ event }: any) => {
      try {
        // V2 event envelope: { id, created, type, location, data }. The payload is
        // `event.data` — V1's `properties` payload field does NOT exist in V2 — and
        // several event NAMES changed (session.updated, message.updated,
        // file.watcher.updated and session.error are gone). See
        // docs/opencode-v2-event-remap-plan.md.
        const type = event?.type
        const d = event?.data || {}

        /* A plugin instance is loaded per *location*, but V2's event stream is
         * process-wide: every loaded instance receives EVERY session's events.
         * Without this filter, a session in project A writes its leases and guard
         * events into project B's checkout — measured 2026-10-16 on the same box:
         * an agent-harness session held a lease in LibraryOS AND in the
         * plugin-loader fixture, and logged guard events into both. That corrupts
         * the live-session view `test:concurrency` and `worktree-prune` read
         * ("in use by a live session") and mis-attributes a project's guard
         * evidence. An event with no location is never dropped. */
        /* Retire THIS tree's lease even when the session has moved elsewhere:
         * the location filter below would skip the tree it left, leaving a GHOST
         * lease until its heartbeat goes stale (F-021). Session IDs are unique,
         * so clearing this id from this tree can never hit another session. */
        if (type === "session.deleted" && typeof d.sessionID === "string" && d.sessionID) {
          clearLeaseAt(directory, d.sessionID)
        }
        if (!sameLocation(event)) return

        if (type === "session.created") {
          const sid = d.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          if (typeof d.location?.directory === "string" && d.location.directory) {
            sessionRoots.set(sid, d.location.directory)
          }
          if (d.parentID) {
            // A subagent dispatch. Track it so the guard never treats a persona
            // session as the primary orchestrator (leases, tool blocks, and funds
            // attribution all key off isPrimary/primaryRoot). A CHILD's
            // session.created carries no `model`, so its funds label comes from
            // `session.step.started` below.
            childSessions.add(sid)
            childParent.set(sid, d.parentID)
            return
          }
          const label = guard.modelLabel(modelFields(d.model))
          if (label) sessionModel.set(sid, label)
          sessionStarts.set(sid, Date.now())
          writeLease(sid)
          syncBoard()
          const root =
            typeof d.location?.directory === "string" && d.location.directory
              ? d.location.directory
              : directory
          refreshHarnessUpdate(root)
          void collectOrient(sid, root)
          return
        }

        /* A cleared/compacted context is a fresh context: re-probe at that
         * boundary rather than trusting the session.created verdict from before
         * the context was replaced (the global freshness plugin re-checks its
         * trees on the same event). Subagents cannot change the deploy, so only
         * the primary session runs it. */
        if (type === "session.compaction.ended") {
          const sid = d.sessionID
          if (typeof sid !== "string" || sid.length === 0 || childSessions.has(sid)) return
          refreshHarnessUpdate(rootOf(sid))
          return
        }

        /* Per-step model capture. V1 stored the label from every assistant message
         * (including children, which is what `armFunds`'s fallback needs); in V2 a
         * child's `session.created` omits `model`, so `session.step.started` — which
         * carries `{ agent, model }` for every session — is the reliable source. */
        if (type === "session.step.started") {
          const sid = d.sessionID
          const label = guard.modelLabel(modelFields(d.model))
          if (typeof sid === "string" && sid.length > 0 && label) sessionModel.set(sid, label)
          return
        }

        // Keeps the funds-stop label current when the user switches model mid-session.
        if (type === "session.model.selected") {
          const sid = d.sessionID
          const label = guard.modelLabel(modelFields(d.model))
          if (typeof sid === "string" && sid.length > 0 && label) sessionModel.set(sid, label)
          return
        }

        if (type === "session.deleted") {
          const id = d.sessionID
          if (id) {
            clearLease(id)
            childSessions.delete(id)
            childParent.delete(id)
            sessionModel.delete(id)
            sessions.delete(id)
            sessionRoots.delete(id)
            sessionStarts.delete(id)
            storeDirs.delete(id)
            // Auto-close this session's long-lived serves (dev server/emulator):
            // the harness must not leave them orphaned after the session ends.
            // Detached + best-effort; `reap` never touches a live owner's serve.
            try {
              const serve = path.join(rootOf(id), "scripts", "serve.js")
              if (fs.existsSync(serve)) {
                spawn(process.execPath, [serve, "reap"], {
                  cwd: directory,
                  detached: true,
                  stdio: "ignore",
                }).unref()
              }
            } catch {
              /* reaping is best-effort */
            }
          }
          return
        }

        // One model call == one assistant message == one orchestrator turn. This is
        // the V2 replacement for V1's `message.updated` (which no longer exists);
        // `data.tokens` is the same TokenUsageInfo the pure core already reads.
        if (type === "session.step.ended") {
          const sid = d.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          if (!isPrimary(sid)) return
          reconcileLease(sid)
          const note = guard.noteAssistant(
            stateFor(sid),
            {
              id: d.assistantMessageID,
              sessionID: sid,
              role: "assistant",
              tokens: d.tokens,
            },
            loadThresholds()
          )
          // Not gated on `newTurn`: a token-band crossing must be logged whenever it
          // actually changes.
          if (note.bandChanged && note.band) {
            logEvent({ kind: "band", sessionID: sid, band: note.band, turn: note.turns })
            await report(`turn ${note.turns}: ${note.band} band`)
          }
          if (note.requestChanged && note.requestLevel) {
            logEvent({
              kind: "request",
              sessionID: sid,
              level: note.requestLevel,
              tokens: note.requestTokens,
            })
            // Auto clear-resume handshake: record the crossing for `agent-harness
            // run` / the TUI (feature worktrees always; main only when the
            // selector proves one recent checkpoint — pure decision in
            // run-loop-core.mjs).
            if (note.requestLevel === "intervene") writeContextResume(sid, note.requestTokens)
          }
          if (note.noStateChanged) {
            logEvent({
              kind: "no_state",
              sessionID: sid,
              turn: note.turns,
              noStateTurns: note.noStateTurns,
            })
            await report(`turn ${note.turns}: no material state change across several turns`)
          }
          return
        }

        // V2 renamed `session.error`. The structured failure carries no
        // provider/model (`SessionStructuredError` is `{ type, message, status?,
        // response? }`), so the label comes from the per-session model observed
        // on `session.step.started` (`sessionModel`), with `modelLabel` as a
        // best-effort parse. Capture even for child sessions so the funds stop
        // is armed on the session the user actually sees.
        if (type === "session.execution.failed" || type === "session.step.failed") {
          const sid = d.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          const text = JSON.stringify(d.error ?? d)
          if (!guard.fundsError(text)) return
          const label = guard.modelLabel(d.error) || sessionModel.get(sid) || null
          await armFunds(sid, label, type)
          return
        }
      } catch {
        /* the guard must never break a session */
      }
    },

    "tool.execute.before": async (input: any, output: any) => {
      // Branch-switch guard. This MUST throw to abort the tool call, so it lives
      // OUTSIDE the swallow-everything loop-guard try/catch below. It is armed
      // only when another LIVE primary lease shares this checkout: a
      // `git checkout`/`git switch` here would move HEAD under that session,
      // which could then commit/push on the wrong branch (LibraryOS 2026-09-18).
      if (isPrimary(input?.sessionID)) {
        let target: any = null
        try {
          target = guard.branchSwitch(output?.args?.command)
        } catch {
          target = null
        }
        if (target) {
          let others: any[] = []
          try {
            others = leases
              .liveLeases(directory)
              .filter((r: any) => r.sessionID !== input.sessionID)
          } catch {
            others = []
          }
          if (others.length > 0) {
            const ids = others.map((r: any) => r.sessionID)
            logEvent({ kind: "branch-switch", sessionID: input.sessionID, ref: target.ref, others: ids })
            const message = guard.branchSwitchText(target.ref, ids)
            await report(message)
            throw new Error(message)
          }
        }
      }
      // `pkill -f` self-kill guard. A `-f` pattern that matches its own
      // `bash -c` line SIGTERMs the shell running it — the turn dies mid-step and
      // in-flight work is lost (and once it killed the shared opencode service).
      // Block it and hand back the safe form. MUST throw to abort, so it lives
      // OUTSIDE the swallow-everything loop-guard try/catch below.
      if (isShell(input?.tool)) {
        let selfKill: string | null = null
        try {
          selfKill = guard.shellSelfKill(output?.args?.command)
        } catch {
          selfKill = null
        }
        if (selfKill) {
          logEvent({ kind: "self-kill", sessionID: input?.sessionID, pattern: selfKill })
          const message = guard.SELFKILL_TEXT(selfKill)
          await report(message)
          throw new Error(message)
        }
      }
      // Oversized state-doc read guard (F-059). An UNRANGED read of a large
      // `.agents/**` markdown doc bills the whole file into context — the
      // measured case was a 52 KB findings register read whole when the first
      // edit landed much later. Abort with a heading outline and the exact
      // ranged call to make instead. Applies to child sessions too (a subagent's
      // context is billed identically), so it lives OUTSIDE the isPrimary block.
      //
      // The core stays pure: `stat` + the file text are read here, and the
      // decision is made by `stateDocReadDecision` (AGENT_GUARD_STATEDOC=0
      // disables; AGENT_STATE_READ_BYTES overrides the threshold). MUST throw to
      // abort the call, so it sits outside the swallow-everything loop-guard.
      if (String(input?.tool || "").toLowerCase() === "read") {
        let stateDocBlock: string | null = null
        try {
          const args = output?.args || {}
          const root = rootOf(String(input?.sessionID || ""))
          const rel = guard.stateDocPath(String(args.filePath || ""), root)
          if (rel) {
            const abs = path.resolve(root, rel)
            const bytes = fs.statSync(abs).size
            const decision = guard.stateDocReadDecision({ filePath: rel, root, args, bytes })
            if (decision.block) {
              stateDocBlock = guard.stateDocReadText(decision, fs.readFileSync(abs, "utf8"))
            }
          }
        } catch {
          /* a missing/unreadable file is the read tool's error, not ours */
        }
        if (stateDocBlock) {
          logEvent({ kind: "tool-block", sessionID: input?.sessionID, tool: "read", stateDoc: true })
          await report(stateDocBlock)
          throw new Error(stateDocBlock)
        }
      }
      // Bash reroot (ALL sessions, best-effort, never blocks). A leading
      // `cd X && rest` becomes workdir=X, command=rest, so the tree is carried by
      // the tool's cwd parameter instead of a shell `cd` — the WSL `cd`-chaining
      // habit (2,981 calls / 388 sessions). When the session owns a mid-session
      // worktree pointer and the command carries no workdir/cd, the default cwd is
      // rerooted into it, so bash matches the session's feature tree instead of the
      // MAIN tree opencode pinned at launch. Runs BEFORE the main-checkout guard so
      // that classifier sees the rewritten command.
      if (isShell(input?.tool)) {
        try {
          const args = output?.args || {}
          if (!args.workdir) {
            const root = sessionBashRoot(String(input?.sessionID || ""))
            const rerooted = guard.rerootBash(String(args.command || ""))
            if (rerooted && (root || /^(?:~\/|\/)/.test(rerooted.workdir))) {
              const target = path.resolve(expandHome(rerooted.workdir))
              args.workdir = target
              args.command = rerooted.command
              logEvent({ kind: "reroot", sessionID: input?.sessionID, via: "cd", dir: target })
            } else if (root) {
              args.workdir = root
              logEvent({ kind: "reroot", sessionID: input?.sessionID, via: "worktree", dir: root })
            }
          }
        } catch {
          /* best-effort — a reroot failure must never break the tool call */
        }
      }
      // Main-checkout guard (ALL sessions, including subagents). A code change
      // or code-carrying git mutation aimed at the shared MAIN checkout must
      // isolate first (`backlog worktree <id>`), or the work is stranded exactly
      // like F-278: `finalize` refuses on main and the branch switch is blocked
      // while other sessions share the tree. Docs/board maintenance on main is
      // allowed, so a git op is judged by the PATHS it actually moves — the
      // explicit pathspecs when present, the live index/upstream diff for a
      // whole-index `commit`/`push` — against the checkout the command selects
      // (`git -C <main>` is resolved, not bypassed via an unrelated cwd).
      //
      // FRICTIONLESS RECOVERY (the 43 main-edit blocks / 24 sessions measured in
      // the 2026-09 recon): when the session ALREADY owns a feature worktree, a
      // code change aimed at main is silently REROOTED into that worktree
      // (`workdir`/`-C` rewritten) and allowed — the isolation the agent should
      // have done is done for it, so the common "meant to be in the worktree"
      // case never strands work. Only when NO worktree exists does the guard
      // still refuse, now with the exact `backlog worktree <id>` command to run
      // (never a bare error). Auto-CREATING a worktree stays opt-in via
      // `.harness.json` `autoIsolate` (default off) — the guard must not invent a
      // branch/branch-name on its own. This MUST throw to abort when it refuses,
      // so it lives OUTSIDE the swallow-everything loop-guard try/catch below.
      let mainViolation: { kind: "edit" | "bash"; target: string } | null = null
      // A dogfood install (the harness source checkout running its own guard) edits
      // `templates/**` on main by design, so the main-checkout block is skipped
      // there via the `.harness-dogfood` marker. Every other tree is unchanged.
      const dogfood = !guard.mainEditGuardEnabled(
        path.join(rootOf(String(input?.sessionID || "")), guard.DOGFOOD_MARKER),
        fs.existsSync
      )
      if (!dogfood) {
        try {
        const tool = String(input?.tool || "").toLowerCase()
        const args = output?.args || {}
        const isEdit = EDIT_TOOLS.has(tool)
        const isBash = isShell(tool)
        if (isEdit) {
          if (args.filePath && guard.isCodePath(args.filePath)) {
            const base = path.resolve(String(args.workdir || directory))
            const targetAbs = path.resolve(base, String(args.filePath))
            if (checkoutKind(targetAbs) === "main") {
              mainViolation = { kind: "edit", target: targetAbs }
            }
          }
        } else if (isBash) {
          const { contentCode, gitOps } = guard.classifyCommand(args.command)
          const base = path.resolve(String(args.workdir || directory))
          // Content mutators (`sed -i`/`tee`/redirect) name their own path in the
          // command; the checkout is the command cwd.
          if (contentCode && checkoutKind(base) === "main") {
            mainViolation = { kind: "bash", target: base }
          }
          if (!mainViolation) {
            for (const op of gitOps) {
              const checkout = path.resolve(base, String(op.target || "."))
              if (checkoutKind(checkout) !== "main") continue
              const code = op.pathless
                ? gitOpTouchesCode(checkout, op)
                : op.paths.some((p: string) => guard.isCodePath(p))
              if (code !== false) {
                // true = code; null = indeterminate -> block conservatively.
                mainViolation = { kind: "bash", target: checkout }
                break
              }
            }
          }
        }
      } catch {
        mainViolation = null
      }
      }
      if (mainViolation) {
        // Recover by rerooting into the session's own feature worktree when it
        // has one (see FRICTIONLESS RECOVERY above). A git `-C <main>` selector
        // is rewritten to the worktree; an edit's `workdir` is set to it.
        const reroot = sessionBashRoot(String(input?.sessionID || ""))
        if (reroot && checkoutKind(reroot) === "linked") {
          try {
            const args = output?.args || {}
            if (mainViolation.kind === "edit") {
              args.workdir = reroot
            } else {
              args.workdir = reroot
              // Rewrite an explicit `git -C <main>` to the worktree so the op
              // applies to the isolated checkout, not the shared main tree.
              args.command = String(args.command || "").replace(
                /(git\s+(?:-C|--work-tree[= ])\s*)("[^"]*"|'[^']*'|\S+)/g,
                (m, pre) => pre + JSON.stringify(reroot)
              )
            }
            logEvent({
              kind: "reroot",
              sessionID: input?.sessionID,
              via: "isolate",
              dir: reroot,
            })
          } catch {
            /* best-effort — if the reroot fails, fall through to the refusal */
          }
          return
        }
        // No worktree yet: refuse, but hand back the exact isolating command.
        const feature = inferBoardFeature(String(input?.sessionID || ""))
        logEvent({
          kind: "main-edit",
          sessionID: input?.sessionID,
          tool: String(input?.tool || ""),
          target: mainViolation.kind === "edit" ? mainViolation.target : null,
          commandHash:
            mainViolation.kind === "bash" ? guard.shortHash(String(output?.args?.command || "")) : null,
        })
        const targetRepo = repoRootOf(mainViolation.target)
        const sessionRepo = repoRootOf(directory)
        const crossRepo = !!targetRepo && !!sessionRepo && targetRepo !== sessionRepo
        const message = guard.mainEditText(mainViolation.kind, mainViolation.target, feature, { crossRepo })
        await report(message)
        throw new Error(message)
      }
      // Capacity guard. WSL2 is one VM with no per-agent limits: an emulator +
      // agents + `next dev` exhausts RAM and starves the host<->VM relay, which
      // froze every terminal at once (2026-09-29). A heavy command is sampled
      // against the project envelope and BLOCKED when it would exceed it
      // (naming what is already up); `--force` / AGENT_CAPACITY_DISABLE are the
      // deliberate overrides. This MUST throw to abort the tool call, so it
      // lives outside the swallow-everything loop-guard try/catch; only the
      // sampling is wrapped. A trivial command is never gated.
      //
      // Long-lived heavy commands (emulator/dev server/metro) add a concurrent
      // tier; a ONE-SHOT heavy command (a build, a test tier, `maestro`) does
      // not — it legitimately runs alongside the live device tier (the
      // live-tier test pattern), so it is gated only by the free-RAM floor. The
      // 2026-09-30 freeze was a one-shot `build-dev-apk.sh` (Gradle) that ran
      // inline, uncapped and unclassified — the old code blocked only
      // `serve.js start`, so it sailed through.
      let capViolation: { label: string; ev: any; sample: any } | null = null
      let capNotice: string | null = null
      let capCommand = ""
      try {
        if (
          isShell(input?.tool) &&
          process.env.AGENT_CAPACITY_DISABLE !== "1"
        ) {
          capCommand = String(output?.args?.command || "")
          const label = capacity.classifyHeavy(capCommand)
          if (label) {
            const sample = capacity.sample(directory)
            const longLived = capacity.isLongLivedHeavy(capCommand)
            const ev = capacity.evaluate(sample, {
              pendingHeavy: longLived ? 1 : 0,
              pendingLive: longLived ? 1 : 0,
            })
            const forced = /--force\b/.test(capCommand)
            if (!ev.ok && !forced) capViolation = { label, ev, sample }
            else if (!ev.ok) capNotice = capacity.notice(ev)
          }
        }
      } catch {
        /* capacity sampling is best-effort — never break a tool call */
      }
      if (capViolation) {
        logEvent({
          kind: "capacity",
          sessionID: input?.sessionID,
          label: capViolation.label,
          reasons: capViolation.ev.reasons,
          blocked: true,
        })
        const message = capacity.heavyBlockText(capViolation.label, capViolation.ev, capViolation.sample)
        await report(message)
        throw new Error(message)
      }
      if (isPrimary(input?.sessionID)) {
        const state = stateFor(input.sessionID)
        let blockMessage: string | null = null
        const toolBlocking = guard.toolBlockEnabled(process.env)
        if (capNotice) {
          logEvent({
            kind: "capacity",
            sessionID: input.sessionID,
            label: capacity.classifyHeavy(capCommand),
            reasons: [],
            blocked: false,
          })
          state.resourceNotice = capNotice
        } else if (/serve\.js\s+(start|stop|stop-all)/.test(capCommand)) {
          // A serve lifecycle op that did not trip the envelope clears the notice.
          state.resourceNotice = null
        }
        // Tool-choice / whole-tree-dump / re-read hygiene (advisory, one-shot).
        // Each kind is flagged once per session and rides the cache-safe tail; it
        // is cleared after injection (`clearOneShot`), so it never nags.
        try {
          const tool = String(input?.tool || "").toLowerCase()
          if (isShell(tool)) {
            const command = String(output?.args?.command || "")
            const inspect = guard.inspectCommand(command)
            if (inspect) {
              const rearm = guard.noteInspect(state, inspect, loadThresholds().stuck.inspect_rearm_every)
              if (rearm.fire) {
                logEvent({ kind: "tool-choice", sessionID: input.sessionID, tool: inspect, rearm: true, count: rearm.count })
              }
              // Structural escalation: block the first pure inspection of this
              // head once, so the 0.1.104 advisory-only attempt cannot be ignored
              // (measured: shell inspection stayed ~33% of bash two weeks later).
              // A PURE single-path `cat`/`ls` is blocked on EVERY occurrence
              // (H-23): Read/Glob is an exact substitute and the habit stayed
              // flat across the re-measure window.
              const repeat = toolBlocking ? guard.repeatInspectBlock(command) : null
              if (repeat) {
                blockMessage = guard.inspectBlockText(repeat)
              } else if (toolBlocking && !state.blockedInspectHeads.has(inspect)) {
                state.blockedInspectHeads.add(inspect)
                blockMessage = guard.inspectBlockText(inspect)
              }
            }
            const dump = guard.dumpCommand(command)
            if (dump && !state.dumpFlagged) {
              state.dumpFlagged = true
              state.dumpPending = true
              logEvent({ kind: "tool-choice", sessionID: input.sessionID, tool: dump, dump: true })
            }
            // Wait/poll advisory (B): `sleep N; grep log` / `gh run watch`.
            const poll = guard.notePollCall(state, command)
            if (poll.firstFlag) {
              logEvent({ kind: "poll", sessionID: input.sessionID, mode: poll.kind })
            }
            if (poll.poll && toolBlocking && !state.blockedPollKinds.has(poll.kind)) {
              state.blockedPollKinds.add(poll.kind)
              blockMessage = blockMessage || guard.pollBlockText(poll.kind)
            }
            // Gate re-run advisory (F): same gate repeated with no edit between.
            const gate = guard.noteGateRun(state, command, loadThresholds().stuck.gate_rerun_turns)
            if (gate.fire) {
              logEvent({ kind: "gate-rerun", sessionID: input.sessionID, gate: gate.key, count: gate.count })
            }
          } else if (tool === "read") {
            const note = guard.noteReadBefore(state, output?.args?.filePath)
            if (note.firstFlag) logEvent({ kind: "read", sessionID: input.sessionID, notice: "reread" })
          }
        } catch {
          /* never break the tool call */
        }
        // The structural tool blocks throw OUTSIDE the swallow-everything block
        // above (like the branch-switch/capacity guards), so the blocked call is
        // aborted and the agent retries with the dedicated tool / bounded waiter.
        if (blockMessage) {
          logEvent({ kind: "tool-block", sessionID: input.sessionID, message: blockMessage.slice(0, 120) })
          await report(blockMessage)
          throw new Error(blockMessage)
        }
      }
      try {
        if (!isPrimary(input?.sessionID)) return
        reconcileLease(input.sessionID)
        const note = guard.noteToolCall(
          stateFor(input.sessionID),
          input?.tool,
          output?.args,
          loadThresholds().stuck
        )
        if (note.firstFlag) {
          logEvent({
            kind: "loop",
            sessionID: input.sessionID,
            tool: String(input?.tool || ""),
            count: note.count,
            keyHash: note.keyHash,
          })
          await report(`repeated identical ${input?.tool} call x${note.count}`)
        }
      } catch {
        /* never break the tool call */
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isPrimary(input?.sessionID)) return
        reconcileLease(input.sessionID)
        // Read-hygiene notice: a guessed (failed) read or a large whole-file read
        // arms a one-shot nudge (whole-file re-reads are handled in `before`).
        if (String(input?.tool || "").toLowerCase() === "read") {
          const note = guard.noteReadAfter(stateFor(input.sessionID), output?.args, output)
          if (note.firstFlag) logEvent({ kind: "read", sessionID: input.sessionID, notice: note.notice })
        }
        // Todo-list discipline: remember the last list the model wrote so the
        // next request can tell whether the panel is missing, stale, invalid, or
        // still open at a wrap-up boundary. Recording only; the nudge text rides
        // the cache-safe tail via composeGuardText.
        if (String(input?.tool || "").toLowerCase() === "todowrite") {
          const note = guard.noteTodoWrite(stateFor(input.sessionID), output?.args)
          if (note.recorded) {
            logEvent({
              kind: "todo",
              sessionID: input.sessionID,
              count: note.count,
              inProgress: note.inProgress,
              open: note.open,
            })
          }
        }
        // Edit-miss advisory (E): a failed edit/write/apply_patch is a guessed or
        // stale path — point at the locations index once per session.
        {
          const t = String(input?.tool || "").toLowerCase()
          if (EDIT_TOOLS.has(t)) {
            const failed = !!output?.error || String(output?.status || "") === "error"
            const note = guard.noteEditAfter(stateFor(input.sessionID), failed)
            if (note.firstFlag) logEvent({ kind: "edit-miss", sessionID: input.sessionID, tool: t })
          }
        }
        // Only structured failure evidence may arm the funds stop (core gate): a
        // successful read/grep/dispatch returning the harness's own docs — which
        // quote the trigger phrases — must never pause a healthy session.
        const armed = guard.fundsArmText(input?.tool, output)
        if (armed && guard.fundsError(armed)) {
          const meta = output?.metadata || {}
          const label =
            guard.modelLabel(meta.model) || sessionModel.get(String(meta.sessionId || "")) || null
          await armFunds(input.sessionID, label, `tool:${input?.tool}`)
          return
        }
        // Same-failure detector: a failed call (a thrown error, or a bash
        // non-zero exit) records a failure signature; any success clears it.
        // Distinct from the identical-call counter — the same failure can
        // repeat with different arguments.
        const tool = input?.tool
        const exit = output?.metadata?.exit
        const failed =
          !!output?.error || (isShell(tool) && Number.isFinite(exit) && exit !== 0)
        const failureText = output?.error
          ? String(output.error)
          : failed && typeof output?.output === "string"
            ? output.output
            : ""
        const note = guard.noteToolResult(
          stateFor(input.sessionID),
          tool,
          output?.args,
          !failed,
          failureText,
          loadThresholds().stuck
        )
        if (note.firstFlag) {
          logEvent({
            kind: "failure",
            sessionID: input.sessionID,
            tool: String(tool || ""),
            count: note.count,
            keyHash: note.keyHash,
          })
          await report(`same failure repeated x${note.count} (${tool})`)
        }
      } catch {
        /* never break the tool call */
      }
    },

    // Cache-safe nudge injection is registered as the V2 `context` session hook
    // below (see `onContext`); the V1 `experimental.chat.messages.transform`
    // shape no longer exists.
  }

  /* V1 tool-result shape adapter: the hook bodies above keep the V1
   * (input, output) contract; the V2 tool event carries a structured result. */
  const v1Result = (event: any) => {
    const completed = event?.status === "completed"
    const content = completed
      ? typeof event?.result?.content === "string"
        ? event.result.content
        : Array.isArray(event?.result?.content)
          ? event.result.content.map((p: any) => p?.text || "").join("")
          : ""
      : ""
    return {
      args: event?.input,
      status: event?.status,
      error: completed ? undefined : event?.error,
      output: content,
      metadata: completed ? event?.result?.metadata : event?.error?.metadata,
    }
  }

  /* V2 replacement for the V1 messages transform: OpenCode hands the request
   * session and a structured Message[] directly, so we append a synthetic tail
   * message (role user) and never touch the cached leading prefix. */
  const onContext = (event: any) => {
    try {
      const sid = event?.sessionID
      if (!sessionOurs(sid)) return
      if (!isPrimary(sid)) return
      const messages = event?.messages
      if (!Array.isArray(messages)) return
      const state = stateFor(sid)
      // A brief snapshot can go stale while the prologue runs (a harness update
      // commits seconds after collection). Never inject a HEAD/version the tree
      // no longer has: drop it and refill for the next request.
      if (state.orientPending && state.orientStamp) {
        const root = rootOf(sid)
        if (state.orientStamp !== treeStamp(root)) {
          state.orientPending = false
          state.orientText = null
          if (!state.orientRefreshing) {
            state.orientRefreshing = true
            void collectOrient(sid, root).finally(() => {
              state.orientRefreshing = false
            })
          }
        }
      }
      // The capacity notice (set by the heavy-launch guard) rides the same
      // cache-safe tail message as the context-budget nudges; the session-start
      // orientation block rides it too until the first material action.
      const text = [
        guard.composeGuardText(state, loadThresholds()),
        state.orientPending ? state.orientText : null,
        state.resourceNotice,
      ]
        .filter(Boolean)
        .join("\n\n")
      if (!text) return
      // The tool-choice / read / dump notices are one-shot: once injected, clear
      // them so they never nag on later requests (bands/funds/loop persist).
      guard.clearOneShot(state)
      const last = messages[messages.length - 1]
      if (last?.id === GUARD_MESSAGE_ID) {
        // Same turn, re-request (e.g. a band advanced): update in place.
        const part = (last.content || []).find((p: any) => p?.type === "text")
        if (part && part.text !== text) part.text = text
        return
      }
      messages.push({
        id: GUARD_MESSAGE_ID,
        role: "user",
        content: [{ type: "text", text }],
        metadata: { synthetic: true },
      })
    } catch {
      /* never break a request */
    }
  }

  // ---- V2 registration ----
  // The event stream replaces the V1 `event` hook; the tool hooks are driven
  // through the V1-shaped bodies above via thin adapters so the pure core
  // contract is unchanged. The V1 `permission.ask` hook is gone, but V2 does
  // expose `ctx.permission.hook("evaluate")`; only the built-in `doom_loop`
  // action was removed, so the core's loop guard is no longer mirrored onto the
  // permission layer. (Rebuild it on the `evaluate` hook if the runtime mirror
  // is wanted back — the evaluate hook is present in `permission.d.ts`.)
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          await hooks.event({ event })
        } catch {
          /* never break the stream */
        }
      }
    } catch {
      /* subscription unavailable/ended */
    }
  })()
  await ctx.tool.hook("execute.before", async (event: any) => {
    if (!sessionOurs(event?.sessionID)) return
    await hooks["tool.execute.before"](
      { tool: event?.tool, sessionID: event?.sessionID },
      { args: event?.input }
    )
  })
  await ctx.tool.hook("execute.after", async (event: any) => {
    if (!sessionOurs(event?.sessionID)) return
    await hooks["tool.execute.after"](
      { tool: event?.tool, sessionID: event?.sessionID },
      v1Result(event)
    )
  })
  await ctx.session.hook("context", onContext)
  await ctx.session.hook("prompt", (event: any) => {
    try {
      // A real user turn releases the provider funds stop (the top-up-complete
      // message). This is the V2 replacement for the dead `message.updated`
      // role==="user" branch. Synthetic/shell/compaction submissions do not fire
      // this hook, so the stop cannot be cleared by the harness's own traffic.
      const sid = event?.sessionID
      if (!sessionOurs(sid)) return
      if (!isPrimary(sid)) return
      const state = stateFor(sid as string)
      state.fundsPending = false
      state.fundsNotice = null
    } catch {
      /* never break a prompt */
    }
  })
  return () => controller.abort()
  },
}
