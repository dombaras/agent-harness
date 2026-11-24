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
