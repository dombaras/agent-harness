import fs from "node:fs"
import path from "node:path"

// Read the harness version a repo was deployed with. `.harness.json` is written
// by `agent-harness init`/`update`; it is the source of truth for the badge
// (package.json in a project belongs to the project, not the harness).
//
// Never throws: a missing, unreadable, malformed, or version-less file means
// "this is not a harness-provisioned checkout", and the badge renders nothing.
export function readHarnessVersion(directory) {
  if (typeof directory !== "string" || directory.length === 0) return null
  try {
    const raw = fs.readFileSync(path.join(directory, ".harness.json"), "utf8")
    const version = JSON.parse(raw)?.version
    return typeof version === "string" && version.trim().length > 0 ? version.trim() : null
  } catch {
    return null
  }
}

function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0)
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1
  }
  return 0
}

// The cached npm verdict `scripts/harness-update.js refresh` writes at session
// start (`.serve/harness-update.json`). The badge only decorates: a missing,
// stale, or malformed cache means "no arrow", never an error inside setup().
export function readHarnessUpdate(directory) {
  if (typeof directory !== "string" || directory.length === 0) return null
  try {
    const raw = fs.readFileSync(path.join(directory, ".serve", "harness-update.json"), "utf8")
    const doc = JSON.parse(raw)
    const deployed = readHarnessVersion(directory)
    const latest = typeof doc?.latest === "string" && doc.latest.trim() ? doc.latest.trim() : null
    if (!deployed || !latest || compareVersions(deployed, latest) >= 0) return null
    return { deployed, latest }
  } catch {
    return null
  }
}

function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs
  } catch {
    return null
  }
}

// A verdict carries the process that wrote it. A service restart leaves the
// file behind, so a verdict whose writer is gone describes a process that no
// longer exists (F-038). A missing pid is an older verdict: its version/deploy
// checks still apply. A present-but-unusable pid is not trusted.
//
// Pid reuse: Linux can hand the dead writer's number to an unrelated process,
// which made a stale ↻restart look alive. When the verdict carries the writer's
// /proc start identity, compare it; a mismatch means the writer is gone. A
// reader without /proc falls back to plain liveness.
function procIdentity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")
    const start = fields[19]
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
    return start && boot ? { boot, start } : null
  } catch {
    return null
  }
}

function writerAlive(pid, boot, start) {
  if (pid === undefined || pid === null) return true
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  if (n === process.pid) return true
  if (typeof boot === "string" && boot && typeof start === "string" && start) {
    const now = procIdentity(n)
    if (now && (now.boot !== boot || now.start !== start)) return false
  }
  try {
    process.kill(n, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

// The global `harness-freshness` plugin's verdict (`.serve/harness-freshness.json`):
// `restart-needed` means the on-disk harness is current but the running opencode
// process predates the last write, so the server-side plugins in effect are the
// OLD ones (H-44, deploy != activate). The badge reads it so the footer can say
// "restart" instead of implying the deployed version is already active.
//
// The verdict explains ONE deploy and ONE process, so it is only rendered while
// both still hold: if the checkout has moved to another version (a later deploy
// rewrote `.harness.json`), or the verdict predates that write, or the writing
// process is gone, the verdict cannot describe the running service and is
// dropped. Without these checks a dead process's `restart-needed` file outlives
// the restart that resolved it, and the badge says ↻restart forever (F-038).
// The two statuses have different lifetimes (F-045):
//   * `restart-needed` belongs to a PROCESS — the deploy landed but this service
//     still runs the previous build. It dies with its writer (a restart resolved
//     it) and is dropped by a later deploy.
//   * `blocked` belongs to the TREE — the auto-update failed or was refused. It
//     must survive the process that recorded it; only a later deploy
//     (`deployed !== have`) or a newer `.harness.json` write clears it.
// A pre-F-045 success wrote `status: "refreshed"` naming the OLD build in `have`.
// That is the same activation gap, so it is read as restart-needed once the
// deployed version equals the record's `latest` (no rewrite required).
// A missing, stale, or malformed cache means "no marker", never a setup error.
function readFreshness(directory, status) {
  if (typeof directory !== "string" || directory.length === 0) return null
  try {
    const raw = fs.readFileSync(path.join(directory, ".serve", "harness-freshness.json"), "utf8")
    const doc = JSON.parse(raw)
    const legacy = status === "restart-needed" && doc?.status === "refreshed"
    if (doc?.status !== status && !legacy) return null
    const deployed = readHarnessVersion(directory)
    const latest = typeof doc.latest === "string" && doc.latest.trim() ? doc.latest.trim() : null
    let have = typeof doc.have === "string" && doc.have.trim() ? doc.have.trim() : null
    let active = typeof doc.active === "string" && doc.active.trim() ? doc.active.trim() : null
    if (legacy) {
      if (!deployed || !latest || deployed !== latest) return null
      active = have // the old build the record named before the deploy
      have = deployed
    }
    if (deployed && deployed !== have) return null
    const wrote = Number(doc.wrote)
    const current = mtimeMs(path.join(directory, ".harness.json"))
    if (Number.isFinite(wrote) && current !== null && current > wrote + 1000) return null
    // A restart verdict is about the process that wrote it; a blocked tree
    // outlives that process (F-045).
    if (status === "restart-needed" && !writerAlive(doc.pid, doc.pidBoot, doc.pidStart)) return null
    const verdict = { have, latest }
    if (active) verdict.active = active
    const startedAt = Number(doc.startedAt)
    if (Number.isFinite(startedAt)) verdict.writerStartedAt = startedAt
    if (status === "blocked") {
      verdict.reason =
        typeof doc.reason === "string" && doc.reason.trim() ? doc.reason.trim() : "update blocked"
    }
    return verdict
  } catch {
    return null
  }
}

// A tree can be served by more than one opencode process (the shared background
// service plus per-client stdio servers). A `restart-needed` record written by
// an OLDER process therefore cannot describe THIS process's build: when this
// client loaded the deployed version after that record was written, the record
// belongs to another, stale server and must not paint ↻restart in this window.
// `loaded` is the build this process read at setup; `startedAt` is its start.
export function readHarnessRestart(directory, { loaded, startedAt } = {}) {
  const verdict = readFreshness(directory, "restart-needed")
  if (!verdict) return null
  const mine = Number(startedAt)
  const theirs = Number(verdict.writerStartedAt)
  const current = typeof loaded === "string" && loaded === verdict.have
  if (current && Number.isFinite(mine) && Number.isFinite(theirs) && mine > theirs) return null
  return verdict
}

// `blocked` means the global plugin refused or failed to apply a newer harness
// (locally-modified harness files, a diverged branch, a stale project main).
// The footer must say so persistently: otherwise it advertises the stale
// version as current and the user has to rediscover the failed auto-update
// every session (F-044). The same provenance/deploy checks apply, so a failed
// run from a process that has since restarted, or from an older deploy, is not
// rendered.
export function readHarnessBlocked(directory) {
  return readFreshness(directory, "blocked")
}

// The footer text. `current` is what `.harness.json` says now (the deployed
// version); `loaded` is what this process read when it started. A restart
// verdict means the deployed files are NOT the ones in memory, so naming only
// `current` advertises a version the service does not run (H-44). Render the
// loaded build first and the deployed one as the target:
//
//   harness v0.4.18 → v0.5.1 ↻restart
//
// A verdict may name the service's active build (`active`); otherwise the
// setup-time read is the best local evidence. When both reads agree there is no
// gap to show, so the badge stays short. Returns null for a non-harness tree.
export function formatHarnessBadge({ current, loaded, update, restart, blocked } = {}) {
  const deployed = current || loaded
  if (!deployed) return null
  const active = restart ? restart.active || loaded || deployed : deployed
  const inactive = Boolean(restart) && active !== deployed
  const parts = [`harness v${inactive ? active : deployed}`]
  if (inactive) parts.push(`→ v${deployed}`)
  if (update?.latest) parts.push(`↑${update.latest}`)
  if (restart) parts.push("↻restart")
  if (blocked) {
    parts.push(
      blocked.reason === "update failed"
        ? "⚠update failed"
        : blocked.reason === "update available"
          ? "⚠update pending"
          : "⚠update blocked"
    )
  }
  return parts.join(" ")
}
