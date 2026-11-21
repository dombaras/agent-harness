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
