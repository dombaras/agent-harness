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
function writerAlive(pid) {
  if (pid === undefined || pid === null) return true
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  if (n === process.pid) return true
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
// A missing, stale, or malformed cache means "no marker", never a setup error.
function readFreshness(directory, status) {
  if (typeof directory !== "string" || directory.length === 0) return null
  try {
    const raw = fs.readFileSync(path.join(directory, ".serve", "harness-freshness.json"), "utf8")
    const doc = JSON.parse(raw)
    if (doc?.status !== status) return null
    const have = typeof doc.have === "string" && doc.have.trim() ? doc.have.trim() : null
    const latest = typeof doc.latest === "string" && doc.latest.trim() ? doc.latest.trim() : null
    const active = typeof doc.active === "string" && doc.active.trim() ? doc.active.trim() : null
    const deployed = readHarnessVersion(directory)
    if (deployed && deployed !== have) return null
    const wrote = Number(doc.wrote)
    const current = mtimeMs(path.join(directory, ".harness.json"))
    if (Number.isFinite(wrote) && current !== null && current > wrote + 1000) return null
    if (!writerAlive(doc.pid)) return null
    const verdict = { have, latest }
    if (active) verdict.active = active
    if (status === "blocked") {
      verdict.reason =
        typeof doc.reason === "string" && doc.reason.trim() ? doc.reason.trim() : "update blocked"
    }
    return verdict
  } catch {
    return null
  }
}

export function readHarnessRestart(directory) {
  return readFreshness(directory, "restart-needed")
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
  if (blocked) parts.push(blocked.reason === "update failed" ? "⚠update failed" : "⚠update blocked")
  return parts.join(" ")
}
