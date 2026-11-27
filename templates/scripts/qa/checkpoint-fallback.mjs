/*
 * checkpoint-fallback — deterministic checkpoint writer for OBSERVED stops.
 *
 * F-067: a bounded-context session must never end without a resume state, even
 * when the model never called `scripts/checkpoint.js`. This module is the pure
 * ESM core shared by the TUI plugin, the server guard, and the runner. It has no
 * dependency beyond node builtins, so the TUI's ESM-only plugin graph can import
 * it directly (a CommonJS `.js`/`.cjs` import would kill the whole plugin). The
 * CJS facade `checkpoint-fallback.js` re-exports it for the guard/runner.
 *
 * The fallback is intentionally weaker than a model checkpoint and says so with
 * `auto: true`. It preserves the prior state (objective/phase/completed/active/
 * contracts/facts/decisions/risks), refreshes `files_changed`, records
 * `session` + `stop_reason`, and increments `checkpoint_count`. It NEVER
 * overwrites a checkpoint the model wrote during this session, and writing it
 * twice for the same session is a no-op (idempotent). The one gap it cannot
 * close is an unobserved hard kill (SIGKILL/OOM/power loss): the heartbeat file
 * written during the session is the bound on that gap, and `orient` surfaces it.
 */
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"

export const HEARTBEAT_REL = ".agents/auto-checkpoint.json"
export const HEARTBEAT_SCHEMA = 1
export const HEARTBEAT_MAX_AGE_MS = 30 * 60 * 1000
export const MAX_FILES_CHANGED = 40
export const DEFAULT_NEXT_ACTION =
  "Inspect the prior session and working tree, then continue from the last verified state."

const MARKER = "<!-- agent-harness checkpoint — machine-written; edit via scripts/checkpoint.js -->"
const HEADING_RE = /^#{1,6}\s*Checkpoint\b.*$/im
const HANDOFF_REL = ".agents/handoffs"

/* Split a handoff around its `## Checkpoint` section (same contract as
 * scripts/checkpoint.js; pinned by the fallback tests). */
export function splitCheckpoint(src) {
  const text = String(src == null ? "" : src)
  const m = text.match(HEADING_RE)
  if (!m) return { before: text, body: null, after: "" }
  const start = m.index
  const rest = text.slice(start + m[0].length)
  const next = rest.match(/^#{1,6}\s/m)
  const end = next ? start + m[0].length + next.index : text.length
  return { before: text.slice(0, start), body: text.slice(start, end), after: text.slice(end) }
}

/* Parse the checkpoint block's scalars + lists. Unknown keys are kept, so the
 * fallback preserves forward-compatible state instead of dropping it. */
export function parseBlock(body) {
  const state = {}
  let current = null
  for (const raw of String(body == null ? "" : body).split(/\r?\n/)) {
    const scalar = raw.match(/^- ([a-z_]+):\s*(.*)$/)
    if (scalar) {
      current = null
      if (scalar[2] === "") current = scalar[1]
      else state[scalar[1]] = scalar[2]
      continue
    }
    const item = raw.match(/^\s{2,}- (.*)$/)
    if (item && current) {
      if (!Array.isArray(state[current])) state[current] = []
      if (item[1] !== "(none recorded)") state[current].push(item[1])
    }
  }
  const count = Array.isArray(state.checkpoint_count)
    ? Number(state.checkpoint_count[0] || 0)
    : Number(state.checkpoint_count || 0)
  state.checkpoint_count = Number.isFinite(count) ? count : 0
  return state
}

const SCALARS = ["objective", "phase", "next_action", "session", "stop_reason", "auto"]
const LISTS = ["completed", "active", "files_changed", "contracts", "known_facts", "decisions", "risks"]

function listOf(value) {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim())
  if (value == null) return []
  return String(value)
    .split(/\s*;\s*/)
    .map((v) => v.trim())
    .filter(Boolean)
}

function renderBlock(feature, state, count) {
  const lines = ["## Checkpoint (resume)", "", MARKER, ""]
  lines.push(`- feature: ${feature}`)
  for (const key of SCALARS) {
    const value = state[key] == null || state[key] === "" ? "unknown" : String(state[key])
    lines.push(`- ${key}: ${value}`)
  }
  for (const key of LISTS) {
    lines.push(`- ${key}:`)
    const items = listOf(state[key])
    if (items.length === 0) lines.push("  (none recorded)")
    else for (const item of items) lines.push(`  - ${item}`)
  }
  lines.push(`- checkpoint_count: ${count}`)
  return lines.join("\n") + "\n"
}

/* `git status --porcelain` -> bounded repo-relative paths. Best-effort: an
 * unavailable git (or a non-repo root) is an empty list, never a throw. */
export function gitFilesChanged(root, limit = MAX_FILES_CHANGED) {
  let out = ""
  try {
    out = execFileSync("git", ["-C", String(root || "."), "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    })
  } catch {
    return []
  }
  const files = []
  for (const line of String(out).split(/\r?\n/)) {
    if (!line.trim()) continue
    // "XY path" (rename: "XY old -> new"): keep the destination.
    const body = line.slice(3).trim()
    const target = body.includes(" -> ") ? body.slice(body.lastIndexOf(" -> ") + 4) : body
    if (!target) continue
    files.push(target.replace(/^"|"$/g, ""))
    if (files.length >= Math.max(1, Number(limit) || MAX_FILES_CHANGED)) break
  }
  return files
}

function handoffFile(root, feature, handoffPath) {
  if (handoffPath) return path.resolve(handoffPath)
  return path.join(String(root || "."), HANDOFF_REL, String(feature) + ".md")
}

/*
 * Write the fallback checkpoint for an observed stop.
 *
 * Returns { written, reason, file, count }. `written: false` is a normal outcome:
 * a model checkpoint exists for this session, a newer checkpoint landed after
 * the caller captured `baselineCount`, or this session's fallback is already on
 * disk (idempotent).
 *
 * Inputs:
 *   root             project/worktree root (required)
 *   feature          feature id (required)
 *   handoffPath      explicit handoff path (main-checkout slugs)
 *   sessionID        the stopping session (required)
 *   stopReason       succeeded | failed | interrupted | phase-exit | unknown
 *   baselineCount    checkpoint_count observed at session start (null unknown)
 *   sessionStartedAt ms when this session started (newer-checkpoint guard)
 *   filesChanged     explicit list; when null, read `git status --porcelain`
 */
export function writeFallbackCheckpoint(input) {
  const src = input || {}
  const root = String(src.root || "")
  const feature = String(src.feature || "").trim()
  const sessionID = String(src.sessionID || "").trim()
  if (!root) throw new Error("writeFallbackCheckpoint requires root")
  if (!feature) throw new Error("writeFallbackCheckpoint requires feature")
  if (!sessionID) throw new Error("writeFallbackCheckpoint requires sessionID")

  const file = handoffFile(root, feature, src.handoffPath)
  let text = ""
  let mtime = 0
  try {
    text = fs.readFileSync(file, "utf8")
    mtime = fs.statSync(file).mtimeMs
  } catch {
    text = ""
    mtime = 0
  }
  const parts = splitCheckpoint(text)
  const state = parts.body ? parseBlock(parts.body) : {}
  const currentCount = Number(state.checkpoint_count) || 0

  if (state.session === sessionID && String(state.auto) === "true") {
    return { written: false, reason: "fallback checkpoint already written for this session", file, count: currentCount }
  }

  const baselineRaw = src.baselineCount
  const baseline =
    baselineRaw == null || baselineRaw === "" ? null : Number.isFinite(Number(baselineRaw)) ? Number(baselineRaw) : null
  if (baseline != null && currentCount > baseline) {
    return { written: false, reason: "a newer checkpoint landed during this session", file, count: currentCount }
  }
  // A model checkpoint naming this session already covers the stop, even when
  // the count baseline was never captured (a plugin reload).
  if (baseline == null && state.session === sessionID) {
    return { written: false, reason: "a model checkpoint already covers this session", file, count: currentCount }
  }
  // Never overwrite a checkpoint another session wrote after this session began.
  const started = Number(src.sessionStartedAt)
  if (
    baseline == null &&
    Number.isFinite(started) &&
    started > 0 &&
    currentCount > 0 &&
    state.session &&
    state.session !== sessionID &&
    mtime >= started
  ) {
    return { written: false, reason: "a newer checkpoint from another session exists", file, count: currentCount }
  }

  const files =
    src.filesChanged == null ? gitFilesChanged(root) : listOf(src.filesChanged)
  const next = {
    objective: state.objective,
    phase: state.phase,
    next_action: src.nextAction || DEFAULT_NEXT_ACTION,
    session: sessionID,
    stop_reason: String(src.stopReason || "unknown"),
    auto: "true",
    completed: state.completed,
    active: state.active,
    files_changed: files,
    contracts: state.contracts,
    known_facts: state.known_facts,
    decisions: state.decisions,
    risks: state.risks,
  }
  const count = currentCount + 1
  const block = renderBlock(feature, next, count)
  const before = parts.before.replace(/\s*$/, "")
  const after = parts.after.replace(/^\s*/, "")
  const head = parts.body
    ? before
    : (before ||
        `# Where we stopped (handoff) — ${feature}\n\nDate: unknown\n\n## Dispatch log\n- (auto-checkpoint only — dispatch log recorded at wrap-up)\n`)
  const body = [head, "", block.trim(), after ? "\n" + after : ""].join("\n").replace(/\n{4,}/g, "\n\n\n")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n", "utf8")
  return { written: true, reason: `fallback checkpoint recorded at ${count}`, file, count }
}

/* ------------------------------------------------------------- heartbeat
 *
 * Written every material step while a session runs. An OBSERVED stop removes it;
 * a file left behind is evidence of an unobserved end (SIGKILL/OOM/power loss),
 * which `orient` surfaces as "prior session ended unobserved". Best-effort: a
 * failed write never breaks a session.
 */
export function writeHeartbeat(input) {
  const src = input || {}
  const root = String(src.root || "")
  if (!root) return null
  const file = path.join(root, HEARTBEAT_REL)
  const atRaw = Number(src.now)
  const now = Number.isFinite(atRaw) ? atRaw : Date.now()
  const doc = {
    schema: HEARTBEAT_SCHEMA,
    session: src.sessionID ? String(src.sessionID) : null,
    feature: src.feature ? String(src.feature) : null,
    pid: Number.isInteger(src.pid) && src.pid > 0 ? src.pid : null,
    activity: src.activity == null ? null : String(src.activity).slice(0, 200),
    stop_reason: src.stopReason == null ? null : String(src.stopReason),
    at: new Date(now).toISOString(),
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8")
    return doc
  } catch {
    return null
  }
}

/* Remove the heartbeat for an observed stop. A different session's heartbeat is
 * left alone (another checkout/session owns it). */
export function clearHeartbeat(root, sessionID) {
  const dir = String(root || "")
  if (!dir) return false
  const file = path.join(dir, HEARTBEAT_REL)
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"))
    if (sessionID && doc && doc.session && String(doc.session) !== String(sessionID)) return false
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

/*
 * Status of the heartbeat left on disk:
 *   none    — no heartbeat (clean)
 *   live    — a live pid and a fresh stamp (another session is running here)
 *   unclean — unobserved end: the pid is gone or the stamp is stale
 * `isAlive(pid)` is the caller's oracle (the TUI passes process.kill(pid, 0));
 * with no oracle a pid is treated as dead, so an unproven heartbeat surfaces
 * instead of hiding a hard kill.
 */
export function heartbeatStatus(root, options = {}) {
  const dir = String(root || "")
  const file = path.join(dir, HEARTBEAT_REL)
  let doc = null
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return { state: "none", heartbeat: null, ageMs: null, file }
  }
  if (!doc || typeof doc !== "object") return { state: "none", heartbeat: null, ageMs: null, file }
  const at = Date.parse(String(doc.at || ""))
  const nowRaw = Number(options.now)
  const now = Number.isFinite(nowRaw) ? nowRaw : Date.now()
  const ageMs = Number.isFinite(at) ? now - at : null
  const maxRaw = Number(options.maxAgeMs)
  const maxAgeMs = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : HEARTBEAT_MAX_AGE_MS
  const isAlive = typeof options.isAlive === "function" ? options.isAlive : null
  const pid = Number.isInteger(doc.pid) && doc.pid > 0 ? doc.pid : null
  const alive = pid && isAlive ? isAlive(pid) : false
  const stale = ageMs == null || ageMs >= maxAgeMs
  if (doc.stop_reason) return { state: "none", heartbeat: doc, ageMs, file }
  if (alive && !stale) return { state: "live", heartbeat: doc, ageMs, file }
  return { state: "unclean", heartbeat: doc, ageMs, file }
}
