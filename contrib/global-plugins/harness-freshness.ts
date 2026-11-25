import type { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync, spawn } from "node:child_process"

// harness-freshness — a GLOBAL opencode plugin (this dir is loaded for every
// project/session, independent of a project's own harness version) that keeps a
// session's checkout on the latest local harness.
//
// Why global: a check shipped inside the project harness can't catch a stale
// harness — the stale copy is what loads. And opencode loads config/plugins once
// at startup, so an in-session update only changes files on disk; the agent must
// restart the opencode service to load the updated plugins.
//
// "Latest" is the authoritative local checkout (`AGENT_HARNESS_HOME`, default
// ~/develop/agent-harness). On each primary session start it compares the
// checkout's `.harness.json` version. If stale it refreshes ONLY when that is
// provably safe for the active branch:
//
//   * linked worktree + project main already latest + worktree HEAD is an
//     ancestor of main (a fast-forward) + no local changes overlap the incoming
//     files  -> `git merge --ff-only <main>`  (never rewrites history, never
//     creates a merge commit)
//   * main checkout                        -> `agent-harness update --target`
//     (the sanctioned deploy; it fails closed on locally-modified harness files)
//
// Anything else (diverged branch, overlapping dirty files, stale project main,
// update failure) is NOT auto-changed: it records a BLOCKED notice, injected
// into the session tail so the agent must relay it and wait for the user.
//
// The check also runs once per session on its first activity. A session that
// survives an opencode service restart never re-fires `session.created`, so a
// `restart-needed` verdict written by the previous process would otherwise
// outlive the very restart that resolved it (the footer badge keeps saying
// ↻restart and the notice stays stale).
//
// Re-evaluation needs session activity, and an idle restored session produces
// none — so a verdict also carries the writing process (pid + start) and the
// deploy it explains (`have`, `wrote`). The badge rejects a verdict from a dead
// process or one that names an older deploy, instead of waiting for activity
// that may never come (F-038).
//
// Set AGENT_HARNESS_FRESHNESS=dry to detect+report without applying (testing).

const HARNESS_HOME = process.env.AGENT_HARNESS_HOME || path.join(os.homedir(), "develop", "agent-harness")
const LATEST_PKG = path.join(HARNESS_HOME, "package.json")
const CLI = path.join(HARNESS_HOME, "bin", "agent-harness.js")
const DRY = process.env.AGENT_HARNESS_FRESHNESS === "dry"

// When this module is evaluated, the opencode process is (essentially) starting.
// If the checkout's `.harness.json` was written AFTER this instant, the running
// process loaded the OLD plugins/config — a deploy that has not yet activated.
// The version compares "current" but the process is stale (F-19/H-44).
const PROCESS_START = Date.now()

/* A verdict describes the process that wrote it, so every verdict carries that
 * process's identity. After a service restart the previous pid is gone: a
 * `restart-needed` file left behind by a dead process must never keep the badge
 * (or a notice) alive over a restart that already happened (F-038). */
const PROCESS_PID = process.pid

/* What opencode actually loads once at startup: config, instructions, plugins,
 * agents, commands, skills. A harness write that touched only metadata/docs
 * changes nothing this process holds in memory, so demanding a restart for it is
 * a false positive — the reported 2026-11-25 case rewrote `.harness.json` alone
 * (0.4.16 -> 0.4.17) and blocked the session over a restart that would have
 * changed nothing while the badge already read 0.4.17. */
const LOADED_AT_START = ["opencode.json", "AGENTS.md", ".opencode"]

function writeTime(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return null
  }
}

/* The build this process actually loaded: `.harness.json` as it stood at
 * process start. Reading it now names the deployed build, not the running one.
 * The deploy commits that file, so git history can recover the pre-deploy
 * version; when git cannot answer (no repo, uncommitted tree), omit `active`
 * and let the badge fall back to its own setup-time read. */
function versionAt(tree: string, when: number): string | null {
  const before = new Date(when).toISOString()
  const sha = git(tree, ["log", "-1", `--before=${before}`, "--format=%H", "--", ".harness.json"])
  if (!sha.ok || !sha.out) return null
  const body = git(tree, ["show", `${sha.out}:.harness.json`])
  if (!body.ok || !body.out) return null
  try {
    const version = JSON.parse(body.out)?.version
    return typeof version === "string" && version.trim() ? version.trim() : null
  } catch {
    return null
  }
}

/* Paths under `rel` whose mtime is newer than `after` (recursive, bounded by the
 * three small startup surfaces above). Missing paths are simply not touched. */
function touchedAfter(root: string, after: number, rel = "", out: string[] = []): string[] {
  const abs = rel ? path.join(root, rel) : root
  let st: fs.Stats
  try {
    st = fs.statSync(abs)
  } catch {
    return out
  }
  if (st.isDirectory()) {
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      return out
    }
    for (const e of entries) touchedAfter(root, after, rel ? path.join(rel, e.name) : e.name, out)
    return out
  }
  if (st.mtimeMs > after) out.push(rel)
  return out
}

type GitResult = { ok: boolean; out: string; err: string }

function git(cwd: string, args: string[], timeout = 10000): GitResult {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "pipe"],
    })
    return { ok: true, out: String(out).trim(), err: "" }
  } catch (e: any) {
    return {
      ok: false,
      out: String(e?.stdout || "").trim(),
      err: String(e?.stderr || e?.message || "").trim(),
    }
  }
}

function readVersion(p: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(p, "utf8")).version
    return typeof v === "string" && v ? v : null
  } catch {
    return null
  }
}

function cmpVer(a: string, b: string): number {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0)
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/* The registry's latest, cached once a day in the user cache so a session start
 * never pays a network round-trip twice. Best-effort: offline / no npm / a
 * registry miss all return null and the local checkout remains authoritative. */
function npmLatest(): string | null {
  if (process.env.AGENT_HARNESS_NO_UPDATE_CHECK === "1") return null
  try {
    const root = path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "opencode-agent-harness"
    )
    const file = path.join(root, "npm-latest.json")
    try {
      const cached = JSON.parse(fs.readFileSync(file, "utf8"))
      const at = Date.parse(cached?.checkedAt)
      if (typeof cached?.version === "string" && Number.isFinite(at) && Date.now() - at < 86400000) {
        return cached.version
      }
    } catch {
      /* cold cache */
    }
    const out = execFileSync(
      process.env.AGENT_HARNESS_NPM || "npm",
      ["view", "opencode-agent-harness", "version", "--json", "--fetch-timeout=5000", "--fetch-retries=0"],
      { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }
    )
    const parsed = JSON.parse(String(out).trim())
    const version = typeof parsed === "string" && parsed.trim() ? parsed.trim() : null
    if (!version) return null
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), version }) + "\n")
    return version
  } catch {
    return null
  }
}

/* A real Node interpreter to run the harness CLI. opencode is a Bun-compiled
 * standalone binary, so within a plugin `process.execPath` is the opencode
 * executable, NOT Node — spawning it with the CLI path just re-launches opencode
 * (prints its help, exits 1), which made every main-checkout refresh "fail" and
 * block the session. Mirrors `templates/scripts/qa/tool-lib.js` `nodeBin()`: an
 * OPENCODE_NODE override, then Bun's PATH resolver (skipping WSL /mnt entries so
 * a native node beats the interop Windows node.exe), then a bare "node". */
function nodeBin(): string {
  const override = process.env.OPENCODE_NODE
  if (override) return override
  const bun = (globalThis as any).Bun
  if (bun && typeof bun.which === "function") {
    const pathEnv = String(process.env.PATH || "")
    const native =
      process.platform === "linux"
        ? pathEnv
            .split(":")
            .filter((p) => p && !p.startsWith("/mnt/"))
            .join(":")
        : pathEnv
    const found = bun.which("node", native ? { PATH: native } : {}) || bun.which("node")
    if (found) return found
  }
  return "node"
}

const HarnessFreshness: Plugin = {
  id: "harness-freshness",
  async setup(ctx) {
    const notices = new Map<string, string>()
    const checked = new Set<string>()
    const roots = new Map<string, string>()

    // V1 called `client.app.log`; V2 server plugins log to the console.
    const report = (message: string, level: "info" | "warn" | "error" = "info") => {
      const line = `harness-freshness: ${message}`
      if (level === "error") console.error(line)
      else if (level === "warn") console.warn(line)
      else console.log(line)
    }

    const block = async (sid: string, reason: string, advice: string) => {
      const text =
        `HARNESS FRESHNESS — do NOT begin work yet.\n\n` +
        `${reason}\n\nNext steps:\n${advice}\n\n` +
        `Relay this to the user and wait for their instructions before continuing.`
      notices.set(sid, text)
      report(`blocked (${sid}): ${reason}`, "warn")
    }

    const advise = (sid: string, have: string, latest: string) => {
      notices.set(
        sid,
        `HARNESS UPDATE AVAILABLE — v${have} -> v${latest} (npm).\n\n` +
          `Run: npx opencode-agent-harness@latest update\n` +
          `Then restart the opencode service (the server process, not just the TUI) so the updated plugins/config load.\n\n` +
          `This is advisory — continue the task; relay it to the user when convenient.`
      )
      report(`update available ${have} -> ${latest} (npm)`)
    }

    const writeStatus = (tree: string, status: Record<string, unknown>) => {
      try {
        const dir = path.join(tree, ".serve")
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(
          path.join(dir, "harness-freshness.json"),
          JSON.stringify({ pid: PROCESS_PID, startedAt: PROCESS_START, ...status }, null, 2) + "\n"
        )
      } catch {
        /* observability only */
      }
    }

    /* Apply through the local harness checkout when this machine has one (the
     * development path), otherwise through the published CLI at the exact version
     * we just compared. `npx` keeps the registry path self-contained: no stale
     * project copy is trusted to install its own successor. */
    const applyCommand = (tree: string, latest: string) => {
      if (fs.existsSync(CLI)) return { bin: nodeBin(), args: [CLI, "update", "--target", tree] }
      return {
        bin: process.env.AGENT_HARNESS_NPX || (process.platform === "win32" ? "npx.cmd" : "npx"),
        args: ["--yes", `opencode-agent-harness@${latest}`, "update", "--target", tree],
      }
    }

    /* Files changed on disk do not change the plugins/config this process already
     * loaded. A session-start apply is therefore real only after a restart, and the
     * session must say so rather than pretend the new behavior is active. */
    const announce = (sid: string, have: string | null, latest: string, tree: string) => {
      notices.set(
        sid,
        `HARNESS UPDATED — ${have ? `v${have} -> v${latest}` : `v${latest}`} in ${tree}.\n\n` +
          `The files are current, but this opencode service is still running the previous ones.\n` +
          `Restart the opencode service (the server process, not just the TUI) now to load the update.`
      )
    }

    /* Files on disk do not change the plugins/config this process already
     * loaded. A session-start apply is therefore real only after a restart, but
     * the task itself does not depend on the new build — so this is advice, never
     * a gate: blocking here made a resumed session refuse to start over a restart
     * that had not happened yet. */
    const adviseRestart = (sid: string, have: string, touched: string[]) => {
      const what = touched.length
        ? ` (${touched.slice(0, 3).join(", ")}${touched.length > 3 ? ", …" : ""})`
        : ""
      notices.set(
        sid,
        `HARNESS UPDATED ON DISK${what} — v${have} is deployed, but this opencode service started ` +
          `before the write, so the plugins/config in effect are still the previous build.\n\n` +
          `Restart the opencode service (the server process, not just the TUI) when convenient to ` +
          `load it. Continue the current task now — do not stop or wait for the restart.`
      )
      report(`restart pending: ${have}${what}`)
    }

    const evaluate = async (sid: string, dir: string) => {
      // Newest harness this machine can see: a local checkout may lead the
      // registry (development), the registry may lead a machine with no checkout.
      const local = readVersion(LATEST_PKG)
      const npm = npmLatest()
      const latest = [local, npm].filter((v): v is string => !!v).sort(cmpVer).pop() || null
      if (!latest) return // no authoritative source here
      const source = npm && cmpVer(npm, local || "0") > 0 ? "npm" : "local"
      const top = git(dir, ["rev-parse", "--show-toplevel"])
      if (!top.ok) return // not a git tree
      const tree = top.out
      const cfg = path.join(tree, ".harness.json")
      if (!fs.existsSync(cfg)) return // not a harness project
      const have = readVersion(cfg)
      if (have && cmpVer(have, latest) >= 0) {
        // Version is current, but the RUNNING process may still predate the last
        // harness write (deploy != activate, F-19/H-44). That only matters for
        // the files opencode holds in memory: a metadata-only write (e.g. a
        // `.harness.json` version bump) activates nothing, so it is current.
        const wrote = writeTime(cfg)
        if (wrote && wrote > PROCESS_START) {
          const touched = [
            ...new Set(LOADED_AT_START.flatMap((p) => touchedAfter(tree, PROCESS_START, p))),
          ]
          if (touched.length) {
            const active = versionAt(tree, PROCESS_START)
            writeStatus(tree, {
              status: "restart-needed",
              have,
              latest,
              ...(active && active !== have ? { active } : {}),
              wrote,
              touched: touched.slice(0, 8),
              at: new Date().toISOString(),
            })
            adviseRestart(sid, have, touched)
            return
          }
        }
        notices.delete(sid)
        writeStatus(tree, { status: "current", have, latest, at: new Date().toISOString() })
        return
      }

      const wl = git(tree, ["worktree", "list", "--porcelain"])
      const first = (wl.out || "").split(/\r?\n/).find((l) => l.startsWith("worktree "))
      const mainTop = first ? first.slice("worktree ".length).trim() : tree
      const mainHave = readVersion(path.join(mainTop, ".harness.json"))
      const isWorktree = path.resolve(mainTop) !== path.resolve(tree)
      const base = { have, latest, tree, main: mainTop, kind: isWorktree ? "worktree" : "main" }

      if (isWorktree) {
        if (!mainHave || cmpVer(mainHave, latest) < 0) {
          writeStatus(tree, { ...base, status: "blocked", reason: "project main checkout stale" })
          return block(
            sid,
            `This worktree is on harness ${have} (latest ${latest}), but the project's MAIN checkout ` +
              `(${mainTop}) is itself stale${mainHave ? ` at ${mainHave}` : ""}.`,
            `  node ${CLI} update --target ${mainTop}\n  # then restart the opencode service; the worktree can then fast-forward.`
          )
        }
        const ref = git(mainTop, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "main"
        if (!git(tree, ["merge-base", "--is-ancestor", "HEAD", ref]).ok) {
          writeStatus(tree, { ...base, status: "blocked", reason: "branch has its own commits" })
          return block(
            sid,
            `This worktree's branch (${git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]).out}) has commits of ` +
              `its own, so the harness refresh needs a merge/rebase, not a fast-forward.`,
            `  git -C ${tree} merge ${ref}      # or: git -C ${tree} rebase ${ref}\n  # then restart the opencode service.`
          )
        }
        const incoming = new Set(
          git(tree, ["diff", "--name-only", `HEAD..${ref}`]).out.split(/\r?\n/).filter(Boolean)
        )
        const dirty = git(tree, ["status", "--porcelain"])
          .out.split(/\r?\n/)
          .filter(Boolean)
          .map((l) => l.slice(3).trim().replace(/^"(.*)"$/, "$1"))
        const overlap = dirty.filter((f) => incoming.has(f))
        if (overlap.length) {
          writeStatus(tree, { ...base, status: "blocked", reason: "overlapping local changes", overlap })
          return block(
            sid,
            `Local changes overlap the files a harness refresh would touch: ${overlap.join(", ")}.`,
            `  commit or stash them, then restart the opencode service to auto-refresh.`
          )
        }
        if (DRY) {
          writeStatus(tree, { ...base, status: "stale-would-ff", ref })
          report(`[dry] would fast-forward ${tree} ${have} -> ${latest} (${ref})`)
          return
        }
        const m = git(tree, ["merge", "--ff-only", ref], 30000)
        if (m.ok) {
          notices.delete(sid)
          writeStatus(tree, { ...base, status: "refreshed", ref, at: new Date().toISOString() })
          report(`refreshed worktree ${tree}: ${have} -> ${latest} (ff ${ref}) — restart the opencode service to load the updated plugins`)
        } else {
          writeStatus(tree, { ...base, status: "blocked", reason: "fast-forward failed", detail: m.err || m.out })
          await block(sid, `Fast-forward refresh failed: ${(m.err || m.out || "unknown").split(/\r?\n/)[0]}`, `  git -C ${tree} merge ${ref}`)
        }
        return
      }

      // Main checkout stale relative to the authoritative local harness. Only the
      // sanctioned deploy is correct here; it fails closed on locally-modified
      // harness files, so a run is safe, but it commits+pushes — run it async and
      // block only if it actually fails.
      const inProgress =
        fs.existsSync(path.join(tree, ".git", "MERGE_HEAD")) ||
        fs.existsSync(path.join(tree, ".git", "rebase-merge")) ||
        fs.existsSync(path.join(tree, ".git", "rebase-apply"))
      if (inProgress) {
        writeStatus(tree, { ...base, status: "blocked", reason: "git operation in progress" })
        return block(sid, `A git merge/rebase is already in progress in the main checkout.`, `  finish or abort it, then restart the opencode service.`)
      }
      if (DRY) {
        writeStatus(tree, { ...base, status: "stale-would-update" })
        report(`[dry] would update main checkout ${tree} ${have} -> ${latest}`)
        return
      }
      writeStatus(tree, { ...base, status: "updating", source })
      report(`updating main checkout ${tree}: ${have} -> ${latest} (${source})`)
      const cmd = applyCommand(tree, latest)
      const shown = fs.existsSync(CLI)
        ? `node ${CLI} update --target ${tree}`
        : `npx --yes opencode-agent-harness@${latest} update --target ${tree}`
      try {
        const child = spawn(cmd.bin, cmd.args, {
          cwd: tree,
          stdio: ["ignore", "pipe", "pipe"],
        })
        let out = ""
        child.stdout?.on("data", (d) => (out += d))
        child.stderr?.on("data", (d) => (out += d))
        child.on("error", (e: any) =>
          void block(sid, `Deploy could not start: ${e?.message || e}`, `  ${shown}`)
        )
        child.on("close", (code) => {
          if (code === 0) {
            writeStatus(tree, { ...base, status: "refreshed", source, at: new Date().toISOString() })
            report(`updated main checkout ${tree}: ${have} -> ${latest} (${source}) — restart the opencode service to load it`)
            announce(sid, have, latest, tree)
          } else {
            const tail = out.trim().split(/\r?\n/).slice(-6).join("\n")
            writeStatus(tree, { ...base, status: "blocked", reason: "update failed", source, detail: tail })
            void block(
              sid,
              `The harness deploy failed (exit ${code}) — usually a locally-modified harness file (update fails closed):\n${tail}`,
              `  fix it upstream in templates/, or back up and re-run:\n  ${shown} --accept-harness`
            )
          }
        })
      } catch (e: any) {
        await block(sid, `Deploy threw: ${e?.message || e}`, `  ${shown}`)
      }
    }

    /* A session that predates this process (it survived an opencode service
     * restart) never re-fires `session.created`. Re-evaluate once per session on
     * its first activity so a `restart-needed` verdict written by the previous
     * process is replaced instead of outliving the restart that resolved it. An
     * unknown root is skipped: the event envelope carries the session's own
     * location, so its traffic supplies it without guessing the server cwd. */
    const childSessions = new Set<string>()
    const consider = async (sid: string, dir: string | null | undefined) => {
      if (!sid || checked.has(sid) || childSessions.has(sid)) return
      const root = dir || roots.get(sid)
      if (!root) return
      checked.add(sid)
      await evaluate(sid, root)
    }

    // V1 used an `event` hook; V2 plugins subscribe to the event stream in setup.
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            // V2 envelope: the payload is `event.data` (V1's `properties` field does
            // not exist). A child session carries `data.parentID`. The project
            // directory moved to the TOP-LEVEL `event.location` in opencode 2.4:
            // `data.location` is empty for `session.created`, so falling back to
            // `ctx.location` (the server cwd, e.g. $HOME) silently skipped every
            // project. Resolve the event's own location first.
            const d: any = (event as any)?.data || {}
            const eventDir = (event as any)?.location?.directory
            const sid = typeof d.sessionID === "string" ? d.sessionID : ""
            const dir =
              typeof eventDir === "string" && eventDir
                ? eventDir
                : typeof d.location?.directory === "string" && d.location.directory
                  ? d.location.directory
                  : null
            if (sid && dir && !roots.has(sid)) roots.set(sid, dir)
            if (event?.type === "session.deleted") {
              if (sid) {
                notices.delete(sid)
                checked.delete(sid)
                roots.delete(sid)
                childSessions.delete(sid)
              }
              continue
            }
            /* A cleared/compacted session starts a fresh context: re-check at that
             * boundary instead of trusting the session.created verdict from before
             * the context was replaced. */
            if (event?.type === "session.compaction.ended") {
              if (!sid) continue
              checked.delete(sid)
              await consider(sid, dir)
              continue
            }
            if (!sid) continue
            if (event?.type === "session.created" && d.parentID) {
              childSessions.add(sid) // child/subagent session
              continue
            }
            /* Any session-scoped event is activity: created, message, tool, idle.
             * `consider` makes this a once-per-session check in this process, so a
             * restored session has its verdict re-evaluated on the first event it
             * produces after a restart. */
            const startDir =
              event?.type === "session.created" ? dir || ctx.location.directory : dir
            await consider(sid, startDir)
          } catch (err: any) {
            report(`check failed: ${err?.message || err}`, "warn")
          }
        }
      } catch (err: any) {
        if (!controller.signal.aborted) report(`event stream failed: ${err?.message || err}`, "warn")
      }
    })()

    // V1 used `experimental.chat.messages.transform`; V2 surfaces the session
    // context hook, which carries the session id directly.
    await ctx.session.hook("context", (event: any) => {
      try {
        const sid = event?.sessionID
        if (typeof sid !== "string" || !sid) return
        /* First activity of a session restored across an opencode service
         * restart: re-evaluate here so the stale verdict is replaced before the
         * reply (the badge re-reads the file every render). Fire-and-forget —
         * never delay the request on git/npm. */
        void consider(sid, roots.get(sid)).catch(() => {})
        const text = notices.get(sid)
        if (!text) return
        notices.delete(sid) // one-shot: the model already saw it and must wait
        const messages = event?.messages
        if (!Array.isArray(messages)) return
        const last = messages[messages.length - 1]
        const lastText =
          typeof last?.content === "string"
            ? last.content
            : Array.isArray(last?.content)
              ? last.content.map((p: any) => (p && typeof p.text === "string" ? p.text : "")).join("")
              : ""
        if (last?.role === "user" && lastText === text) return // already injected
        messages.push({ role: "user", content: [{ type: "text", text }] })
      } catch {
        /* never break a request */
      }
    })

    return () => controller.abort()
  },
}

export default HarnessFreshness
