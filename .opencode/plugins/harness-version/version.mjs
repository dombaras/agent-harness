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
export function readHarnessRestart(directory) {
  if (typeof directory !== "string" || directory.length === 0) return null
  try {
    const raw = fs.readFileSync(path.join(directory, ".serve", "harness-freshness.json"), "utf8")
    const doc = JSON.parse(raw)
    if (doc?.status !== "restart-needed") return null
    const have = typeof doc.have === "string" && doc.have.trim() ? doc.have.trim() : null
    const latest = typeof doc.latest === "string" && doc.latest.trim() ? doc.latest.trim() : null
    const deployed = readHarnessVersion(directory)
    if (deployed && deployed !== have) return null
    const wrote = Number(doc.wrote)
    const current = mtimeMs(path.join(directory, ".harness.json"))
    if (Number.isFinite(wrote) && current !== null && current > wrote + 1000) return null
    if (!writerAlive(doc.pid)) return null
    return { have, latest }
  } catch {
    return null
  }
}
