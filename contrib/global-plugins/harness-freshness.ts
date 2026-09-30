import type { Plugin } from "@opencode-ai/plugin"
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
// restart opencode to load the updated plugins.
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
// Set AGENT_HARNESS_FRESHNESS=dry to detect+report without applying (testing).

const NOTICE_ID = "harness-freshness"
const HARNESS_HOME = process.env.AGENT_HARNESS_HOME || path.join(os.homedir(), "develop", "agent-harness")
const LATEST_PKG = path.join(HARNESS_HOME, "package.json")
const CLI = path.join(HARNESS_HOME, "bin", "agent-harness.js")
const DRY = process.env.AGENT_HARNESS_FRESHNESS === "dry"

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

export const HarnessFreshness: Plugin = async ({ directory, client }) => {
  const notices = new Map<string, string>()
  const checked = new Set<string>()

  const report = async (message: string, level: "info" | "warn" | "error" = "info") => {
    try {
      await client.app.log({ body: { service: "harness-freshness", level, message } })
    } catch {
      /* logging is best-effort */
    }
  }
  const toast = async (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    try {
      await client.tui.showToast({ body: { message, variant } })
    } catch {
      /* toast is best-effort (headless/server mode has no TUI) */
    }
  }

  const block = async (sid: string, reason: string, advice: string) => {
    const text =
      `HARNESS FRESHNESS — do NOT begin work yet.\n\n` +
      `${reason}\n\nNext steps:\n${advice}\n\n` +
      `Relay this to the user and wait for their instructions before continuing.`
    notices.set(sid, text)
    await toast(`harness stale — ${reason.split(/[.\n]/)[0]}. See the session notice.`, "warning")
    await report(`blocked (${sid}): ${reason}`, "warn")
  }

  const writeStatus = (tree: string, status: Record<string, unknown>) => {
    try {
      const dir = path.join(tree, ".serve")
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, "harness-freshness.json"), JSON.stringify(status, null, 2) + "\n")
    } catch {
      /* observability only */
    }
  }

  const evaluate = async (sid: string, dir: string) => {
    const latest = readVersion(LATEST_PKG)
    if (!latest) return // no authoritative checkout here
    const top = git(dir, ["rev-parse", "--show-toplevel"])
    if (!top.ok) return // not a git tree
    const tree = top.out
    const cfg = path.join(tree, ".harness.json")
    if (!fs.existsSync(cfg)) return // not a harness project
    const have = readVersion(cfg)
    if (have && cmpVer(have, latest) >= 0) {
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
          `  node ${CLI} update --target ${mainTop}\n  # then restart opencode; the worktree can then fast-forward.`
        )
      }
      const ref = git(mainTop, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "main"
      if (!git(tree, ["merge-base", "--is-ancestor", "HEAD", ref]).ok) {
        writeStatus(tree, { ...base, status: "blocked", reason: "branch has its own commits" })
        return block(
          sid,
          `This worktree's branch (${git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]).out}) has commits of ` +
            `its own, so the harness refresh needs a merge/rebase, not a fast-forward.`,
          `  git -C ${tree} merge ${ref}      # or: git -C ${tree} rebase ${ref}\n  # then restart opencode.`
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
          `  commit or stash them, then restart opencode to auto-refresh.`
        )
      }
      if (DRY) {
        writeStatus(tree, { ...base, status: "stale-would-ff", ref })
        await report(`[dry] would fast-forward ${tree} ${have} -> ${latest} (${ref})`)
        return
      }
      const m = git(tree, ["merge", "--ff-only", ref], 30000)
      if (m.ok) {
        notices.delete(sid)
        writeStatus(tree, { ...base, status: "refreshed", ref, at: new Date().toISOString() })
        await toast(`harness refreshed ${have} → ${latest}; restart opencode to load the updated plugins`, "success")
        await report(`refreshed worktree ${tree}: ${have} -> ${latest} (ff ${ref})`)
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
      return block(sid, `A git merge/rebase is already in progress in the main checkout.`, `  finish or abort it, then restart opencode.`)
    }
    if (DRY) {
      writeStatus(tree, { ...base, status: "stale-would-update" })
      await report(`[dry] would update main checkout ${tree} ${have} -> ${latest}`)
      return
    }
    writeStatus(tree, { ...base, status: "updating" })
    await report(`updating main checkout ${tree}: ${have} -> ${latest}`)
    try {
      const child = spawn(process.execPath, [CLI, "update", "--target", tree], {
        cwd: tree,
        stdio: ["ignore", "pipe", "pipe"],
      })
      let out = ""
      child.stdout?.on("data", (d) => (out += d))
      child.stderr?.on("data", (d) => (out += d))
      child.on("error", (e: any) =>
        void block(sid, `Deploy could not start: ${e?.message || e}`, `  node ${CLI} update --target ${tree}`)
      )
      child.on("close", (code) => {
        if (code === 0) {
          notices.delete(sid)
          writeStatus(tree, { ...base, status: "refreshed", at: new Date().toISOString() })
          void toast(`harness updated ${have} → ${latest}; restart opencode to load the updated plugins`, "success")
        } else {
          const tail = out.trim().split(/\r?\n/).slice(-6).join("\n")
          writeStatus(tree, { ...base, status: "blocked", reason: "update failed", detail: tail })
          void block(
            sid,
            `The harness deploy failed (exit ${code}) — usually a locally-modified harness file (update fails closed):\n${tail}`,
            `  fix it upstream in templates/, or back up and re-run:\n  node ${CLI} update --target ${tree} --accept-harness`
          )
        }
      })
    } catch (e: any) {
      await block(sid, `Deploy threw: ${e?.message || e}`, `  node ${CLI} update --target ${tree}`)
    }
  }

  return {
    event: async ({ event }: any) => {
      try {
        if (event?.type === "session.deleted") {
          const sid = event?.properties?.info?.id
          if (typeof sid === "string" && sid) {
            notices.delete(sid)
            checked.delete(sid)
          }
          return
        }
        if (event?.type !== "session.created") return
        const info = event?.properties?.info
        const sid = info?.id
        if (typeof sid !== "string" || !sid) return
        if (info?.parentID) return // child/subagent session
        if (checked.has(sid)) return
        checked.add(sid)
        const dir = typeof info?.directory === "string" && info.directory ? info.directory : directory
        await evaluate(sid, dir)
      } catch (err: any) {
        await report(`check failed: ${err?.message || err}`, "warn")
      }
    },

    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      try {
        const messages = output?.messages
        if (!Array.isArray(messages) || messages.length === 0) return
        let sid: string | null = null
        for (let i = messages.length - 1; i >= 0; i--) {
          const id = messages[i]?.info?.sessionID
          if (typeof id === "string" && id) {
            sid = id
            break
          }
        }
        if (!sid) return
        const text = notices.get(sid)
        if (!text) return
        notices.delete(sid) // one-shot: the model already saw it and must wait
        const last = messages[messages.length - 1]
        if (last?.info?.id === NOTICE_ID) return
        messages.push({
          info: { id: NOTICE_ID, role: "user", sessionID: sid, synthetic: true },
          parts: [{ type: "text", text, synthetic: true }],
        })
      } catch {
        /* never break a request */
      }
    },
  }
}
