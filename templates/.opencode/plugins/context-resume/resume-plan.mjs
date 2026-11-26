/*
 * resume-plan — pure decision core for F-052's TUI auto clear-resume.
 *
 * F-051's server guard writes `.agents/context-resume.json` when a primary
 * session in a FEATURE worktree crosses the `intervene` request level. The
 * runner (`agent-harness run`) consumes that marker in run-loop-core.mjs. A TUI
 * session has no runner, so this module lets the TUI plugin consume the SAME
 * marker through the SAME gates: freshness (the marker was written after the
 * session started), feature match, checkpoint progress past the marker's
 * `checkpoint_count`, and the durable reset cap. No rule is re-implemented
 * here — `decideRunLoop` is the single decision core.
 *
 * Pure and dependency-free (run-loop-core.mjs is pure), and its entire import
 * graph is ESM: the TUI plugin loader evaluates plugins as ESM-only, so a
 * CommonJS `.js`/`.cjs` import here fails the whole plugin with
 * `export '…' not found`.
 */
import {
  decideRunLoop,
  DEFAULT_MAX_CONTEXT_RESETS,
} from "../../../scripts/qa/run-loop-core.mjs"

export const RESUME_SCHEMA = 1
export const RESUME_MARKER_REL = ".agents/context-resume.json"
export const STORAGE_KEY = "context-resume"
export { DEFAULT_MAX_CONTEXT_RESETS }

/* Same contract as context-guard-core.featureFromBranch: only the harness's
 * own branch shape (`f-051` -> `F-051`) names a feature, so a docs branch can
 * never fabricate one. Kept local because the TUI part must not import the
 * server guard core; the test pins parity with the original. */
export function featureFromBranch(branch) {
  const m = String(branch || "").trim().match(/^[fF]-(\d+)\b/)
  return m ? "F-" + m[1] : null
}

/* Parse the marker file text. A malformed file is "no marker", never a throw
 * inside the TUI event loop. */
export function parseMarker(text) {
  try {
    const parsed = JSON.parse(String(text || ""))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    if (!parsed.sessionID || !parsed.at) return null
    return parsed
  } catch {
    return null
  }
}

/* Identity of one crossing. The durable `handled` record stores this, so the
 * same marker can never trigger twice (a TUI restart included). */
export function markerKey(marker) {
  if (!marker) return null
  return [
    marker.feature || "",
    marker.sessionID || "",
    String(marker.checkpoint_count ?? ""),
    marker.at,
  ].join("|")
}

function ignore(reason) {
  return { action: "ignore", reason }
}

/*
 * Decide what the TUI should do when a session goes idle.
 *
 *   { action: "ignore", reason }                  — not ours / stale / handled
 *   { action: "resume", reason, feature, prompt, key, nextResets }
 *   { action: "stop",   reason, feature, key, resets, landed? }
 *
 * Inputs are text + already-parsed facts, so the plugin owns only IO:
 *   marker            parsed `.agents/context-resume.json` (or null)
 *   idleSessionID     the session that just ended its execution
 *   sessionCreatedAt  Session.Info.time.created (ms), for the freshness gate
 *   branch            current branch of the session's checkout (best-effort)
 *   handoffText       `.agents/handoffs/<feature>.md`
 *   backlogText       `BACKLOG.md`
 *   handled           durable markerKey already consumed for this worktree
 *   resets            durable auto-resume count for this feature
 *   maxResets         durable cap (defaults to the runner's 3)
 */
export function planResume(input) {
  const src = input || {}
  const marker = src.marker
  if (!marker) return ignore("no context-resume marker")
  if (Number(marker.schema) !== RESUME_SCHEMA) return ignore("unsupported marker schema")
  if (!src.idleSessionID || marker.sessionID !== src.idleSessionID) {
    return ignore("marker names another session")
  }

  // The guard only writes markers in linked feature worktrees, but a copied or
  // stale marker must still prove it belongs here: the branch and the marker
  // have to name the same feature. A checkout whose branch IS known and is not a
  // feature branch (main, a docs branch) can never auto-resume; an unreadable
  // branch falls back to the marker, which the guard only writes in a worktree.
  const branchKnown = typeof src.branch === "string" && src.branch.length > 0
  const branchFeature = featureFromBranch(src.branch)
  if (branchKnown && !branchFeature) {
    return ignore(`branch ${src.branch} is not a feature worktree`)
  }
  const markerFeature = marker.feature ? String(marker.feature).toUpperCase() : null
  if (!markerFeature) return ignore("marker names no feature")
  if (branchFeature && branchFeature !== markerFeature) {
    return ignore(`marker feature ${markerFeature} does not match branch feature ${branchFeature}`)
  }
  const feature = branchFeature || markerFeature

  const key = markerKey(marker)
  if (src.handled && String(src.handled) === key) return ignore("marker already handled")

  // Freshness: a marker written before this session started is a leftover from
  // an earlier context (the runner's `phaseStartedAt` gate, ported to the TUI's
  // session lifetime). An unreadable timestamp is never trusted.
  const at = Date.parse(String(marker.at))
  if (!Number.isFinite(at)) return ignore("marker timestamp is unreadable")
  const created = Number(src.sessionCreatedAt)
  if (Number.isFinite(created) && at < created) {
    return ignore("stale marker written before this session started")
  }

  const resets = Math.max(0, Number(src.resets) || 0)
  const maxRaw = Number(src.maxResets)
  const maxResets =
    Number.isFinite(maxRaw) && maxRaw >= 0 ? maxRaw : DEFAULT_MAX_CONTEXT_RESETS

  const decision = decideRunLoop({
    backlogText: String(src.backlogText || ""),
    handoffText: String(src.handoffText || ""),
    feature,
    // One bounded context has already run (the one that hit the ceiling).
    phasesRun: 1,
    maxPhases: 2,
    lastExit: 0,
    marker,
    // Our own freshness check already ran; hand run-loop a phase start that
    // can never reject the marker a second time for a missing session clock.
    phaseStartedAt: Number.isFinite(created) ? created : at,
    // Progress means the checkpoint moved PAST the crossing, not merely exists.
    priorCheckpointCount: marker.checkpoint_count,
    contextResets: resets,
    maxContextResets: maxResets,
  });

  if (decision.action === "resume") {
    return {
      action: "resume",
      reason: decision.reason,
      feature: decision.feature || feature,
      prompt: decision.prompt,
      key,
      resets,
      nextResets: resets + 1,
    }
  }
  if (decision.action === "done") {
    return {
      action: "stop",
      reason: decision.reason,
      feature,
      key,
      resets: 0,
      landed: true,
    }
  }
  return { action: "stop", reason: decision.reason, feature, key, resets }
}
