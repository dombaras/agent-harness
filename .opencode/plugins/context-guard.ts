import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"
import guard from "../../scripts/qa/context-guard-core.js"
import capacity from "../../scripts/qa/capacity-lib.js"
import leases from "../../scripts/qa/lease-lib.js"
import toolLib from "../../scripts/qa/tool-lib.js"

// Mechanical half of the context budget: read the project-owned thresholds from
// `.agents/memory/orchestration.md` and nudge the PRIMARY orchestrator session as
// it crosses them. The nudge is injected into the conversation TAIL via
// `experimental.chat.messages.transform`, never the system prompt: changing the
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


export const ContextGuard: Plugin = async ({ directory, client }) => {
  const sessions = new Map<string, any>()
  const childSessions = new Set<string>()
  const childParent = new Map<string, string>()
  const sessionModel = new Map<string, string>()
  let thresholds: any = null

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

  const loadThresholds = () => {
    if (thresholds) return thresholds
    let text = ""
    try {
      text = fs.readFileSync(path.join(directory, ORCHESTRATION_REL), "utf8")
    } catch {
      /* missing/unreadable file -> documented defaults from the core */
    }
    thresholds = guard.parseThresholds(text)
    return thresholds
  }

  const logEvent = (event: Record<string, unknown>) => {
    try {
      const file = path.join(directory, GUARD_LOG_REL)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, guard.formatGuardEvent(event), "utf8")
    } catch (err: any) {
      // Best-effort telemetry, but never silent: a missing guard log left a real
      // detection unattributable once (LibraryOS) — surface the write failure.
      void report(`guard-event log write failed: ${err?.message || err}`)
    }
  }

  const report = async (message: string, level: "info" | "warn" = "warn") => {
    try {
      await client.app.log({ body: { service: "context-guard", level, message } })
    } catch {
      /* logging is best-effort (no server/TUI in some modes) */
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
      leases.writeLease(directory, sessionID)
    } catch {
      /* lease is best-effort */
    }
  }
  const clearLease = (sessionID: string) => {
    try {
      leases.clearLease(directory, sessionID)
    } catch {
      /* lease is best-effort */
    }
  }
  const touchLease = (sessionID: string) => {
    try {
      leases.touchLease(directory, sessionID)
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

  return {
    event: async ({ event }: any) => {
      try {
        const type = event?.type
        const props = event?.properties || {}

        if (type === "session.created" || type === "session.updated") {
          if (props.info?.id && props.info.parentID) {
            childSessions.add(props.info.id)
            childParent.set(props.info.id, props.info.parentID)
          } else if (type === "session.created" && props.info?.id) {
            writeLease(props.info.id)
            syncBoard()
          }
          return
        }

        if (type === "session.deleted") {
          const id = props.info?.id
          if (id) {
            clearLease(id)
            childSessions.delete(id)
            childParent.delete(id)
            sessionModel.delete(id)
            sessions.delete(id)
          }
          return
        }

        if (type === "file.watcher.updated") {
          if (String(props.file || "").endsWith("orchestration.md")) thresholds = null
          return
        }

        if (type === "message.updated") {
          const info = props.info
          const sid = info?.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          if (info?.role === "assistant") {
            const label = guard.modelLabel(info)
            if (label) sessionModel.set(sid, label)
            // A failed dispatch reports its own provider/model on the assistant
            // message — capture it even for child (subagent) sessions.
            if (info?.error && guard.fundsError(JSON.stringify(info.error))) {
              await armFunds(sid, label, "assistant error")
            }
          }
          if (!isPrimary(sid)) return
          touchLease(sid)
          if (info?.role === "user") {
            // The user is speaking (usually the top-up-complete message):
            // release the funds stop so work can resume.
            const state = stateFor(sid)
            state.fundsPending = false
            state.fundsNotice = null
            return
          }
          if (info?.role !== "assistant") return
          const note = guard.noteAssistant(stateFor(sid), info, loadThresholds())
          // Not gated on `newTurn`: a request-token crossing can arrive on a
          // repeat emit of the same message (the token-bearing update), so the
          // band transition must be logged whenever it actually changes.
          if (note.bandChanged && note.band) {
            logEvent({ kind: "band", sessionID: info.sessionID, band: note.band, turn: note.turns })
            await report(`turn ${note.turns}: ${note.band} band`)
          }
          if (note.requestChanged && note.requestLevel) {
            logEvent({
              kind: "request",
              sessionID: info.sessionID,
              level: note.requestLevel,
              tokens: note.requestTokens,
            })
          }
          if (note.noStateChanged) {
            logEvent({
              kind: "no_state",
              sessionID: info.sessionID,
              turn: note.turns,
              noStateTurns: note.noStateTurns,
            })
            await report(`turn ${note.turns}: no material state change across several turns`)
          }
          return
        }

        if (type === "session.error") {
          const sid = props.sessionID || props.info?.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          const text = JSON.stringify(props.error ?? props.message ?? props)
          if (!guard.fundsError(text)) return
          const label = guard.modelLabel(props.error) || sessionModel.get(sid) || null
          await armFunds(sid, label, "session.error")
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
      // Bash reroot (ALL sessions, best-effort, never blocks). A leading
      // `cd X && rest` becomes workdir=X, command=rest, so the tree is carried by
      // the tool's cwd parameter instead of a shell `cd` — the WSL `cd`-chaining
      // habit (2,981 calls / 388 sessions). When the session owns a mid-session
      // worktree pointer and the command carries no workdir/cd, the default cwd is
      // rerooted into it, so bash matches the session's feature tree instead of the
      // MAIN tree opencode pinned at launch. Runs BEFORE the main-checkout guard so
      // that classifier sees the rewritten command.
      if (String(input?.tool || "").toLowerCase() === "bash") {
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
      try {
        const tool = String(input?.tool || "").toLowerCase()
        const args = output?.args || {}
        const isEdit = EDIT_TOOLS.has(tool)
        const isBash = tool === "bash"
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
        const message = guard.mainEditText(mainViolation.kind, mainViolation.target, feature)
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
          String(input?.tool || "").toLowerCase() === "bash" &&
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
          if (tool === "bash") {
            const command = String(output?.args?.command || "")
            const inspect = guard.inspectCommand(command)
            if (inspect) {
              const rearm = guard.noteInspect(state, inspect, loadThresholds().stuck.inspect_rearm_every)
              if (rearm.fire) {
                logEvent({ kind: "tool-choice", sessionID: input.sessionID, tool: inspect, rearm: true, count: rearm.count })
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
      }
      try {
        if (!isPrimary(input?.sessionID)) return
        touchLease(input.sessionID)
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
        touchLease(input.sessionID)
        // Read-hygiene notice: a guessed (failed) read or a large whole-file read
        // arms a one-shot nudge (whole-file re-reads are handled in `before`).
        if (String(input?.tool || "").toLowerCase() === "read") {
          const note = guard.noteReadAfter(stateFor(input.sessionID), output?.args, output)
          if (note.firstFlag) logEvent({ kind: "read", sessionID: input.sessionID, notice: note.notice })
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
          !!output?.error || (String(tool || "") === "bash" && Number.isFinite(exit) && exit !== 0)
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

    // Cache-safe nudge injection: a synthetic user message appended to the TAIL
    // of the request, so the leading system prompt / transcript prefix is
    // byte-identical between turns and the provider's prompt cache survives a
    // band crossing. Never touch `output.system` here.
    //
    // Two opencode behaviours shape this (verified live against 1.18.31):
    //   - the transform is per-request and is NOT persisted, so the stored
    //     transcript (and thus the cached prefix) is untouched;
    //   - a synthetic *part* appended to the last message is stripped before the
    //     provider sees it, but a whole synthetic *message* (the compaction-
    //     continue shape) is forwarded — hence `messages.push`, not `parts.push`.
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        const messages = output?.messages
        if (!Array.isArray(messages) || messages.length === 0) return
        // The hook carries no sessionID; it belongs to the last message in the
        // request (its own session). Child/subagent requests are skipped.
        let sid: string | null = null
        for (let i = messages.length - 1; i >= 0; i--) {
          const id = messages[i]?.info?.sessionID
          if (typeof id === "string" && id.length > 0) {
            sid = id
            break
          }
        }
        if (!isPrimary(sid)) return
        const state = stateFor(sid)
        // The capacity notice (set by the heavy-launch guard) rides the same
        // cache-safe tail message as the context-budget nudges.
        const text = [guard.composeGuardText(state, loadThresholds()), state.resourceNotice]
          .filter(Boolean)
          .join("\n\n")
        if (!text) return
        // The tool-choice / read / dump notices are one-shot: once injected, clear
        // them so they never nag on later requests (bands/funds/loop persist).
        guard.clearOneShot(state)
        const last = messages[messages.length - 1]
        if (last?.info?.id === GUARD_MESSAGE_ID) {
          // Same turn, re-request (e.g. a band advanced): update in place.
          const part = (last.parts || []).find((p: any) => p?.type === "text")
          if (part && part.text !== text) part.text = text
          return
        }
        messages.push({
          info: { id: GUARD_MESSAGE_ID, role: "user", sessionID: sid, synthetic: true },
          parts: [{ type: "text", text, synthetic: true }],
        })
      } catch {
        /* never break a request */
      }
    },

    "permission.ask": async (input: any) => {
      try {
        const type = String(input?.type || "")
        const title = String(input?.title || "")
        if (type !== "doom_loop" && !/doom.?loop/i.test(title)) return
        // The runtime's own consecutive-identical-call guard fired: surface it
        // and arm the recovery rule for the next request.
        logEvent({ kind: "doom_loop", sessionID: input?.sessionID, title })
        if (isPrimary(input?.sessionID)) {
          stateFor(input.sessionID).loopPending = true
          await report(`built-in doom-loop guard fired${title ? `: ${title}` : ""}`)
        }
      } catch {
        /* visibility only; never alter the permission decision */
      }
    },
  }
}
