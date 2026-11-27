/*
 * run-loop-core — pure ESM decision core for the end-to-end auto-resume runner
 * (`agent-harness run`) and the TUI auto clear-resume plugin.
 *
 * ESM is load-bearing: OpenCode's TUI plugin loader evaluates its whole plugin
 * graph as ESM-only, so a TUI entry must never reach a CommonJS `.js`/`.cjs`
 * module (it sees no exports). The CJS facade `run-loop.js` re-exports this
 * file for the runner and `scripts/finalize.js`.
 *
 * The problem it solves: a full agentic dev cycle (pick → plan → implement → QA
 * → gates → ship → land → UAT deploy) needs more turns than one bounded context
 * can hold, and the context-guard's soft budget therefore stops the session
 * mid-phase. A primary session cannot spawn its own replacement, so without a
 * runner the "fresh bounded context" half of the policy is a manual `/resume`
 * per phase. This module encodes the deterministic decision — "is the feature
 * landed, should we resume a fresh bounded context, or stop?" — so the CLI can
 * chain phases automatically and stop on a real boundary.
 *
 * Pure and dependency-free: every input is text the CLI already has, so the
 * whole loop is unit-testable without invoking opencode.
 */

/* Body of a `## <heading>` section, up to the next heading (mirrors
 * agent-report.js). Tolerant of a trailing qualifier in the heading. */
function sectionText(src, heading) {
  const re = new RegExp("^#{1,6}\\s*" + heading + "\\b.*$", "im");
  const m = String(src || "").match(re);
  if (!m) return "";
  const after = String(src).slice(m.index + m[0].length);
  const tail = after.match(/^#{1,6}\s/m);
  return (tail ? after.slice(0, tail.index) : after).trim();
}

/* First data row's first cell in a section, skipping the header + separator.
 * `| F-256 | P1 | user-flows | ... |` -> `F-256`. */
function firstRowId(sectionSrc) {
  let header = false;
  for (const raw of String(sectionSrc || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^\|.*\|$/.test(line)) continue;
    if (/^\|(\s*:?-+:?\s*\|)+\s*$/.test(line)) continue;
    const cells = line.slice(1, -1).split("|").map((c) => c.trim());
    if (!header) {
      header = true;
      continue; // header row
    }
    if (cells[0]) return cells[0];
  }
  return null;
}

/* The feature currently In progress on the board, or null. Used after the first
 * phase to learn the id the `/next` workflow claimed. */
function inProgressFeature(backlogText) {
  return firstRowId(sectionText(backlogText, "In progress"));
}

/* A feature is landed once `backlog_archive` moved its row into the Archive
 * section (the archive is the completion contract). */
function isArchived(backlogText, feature) {
  if (!feature) return false;
  const archive = sectionText(backlogText, "Archive");
  return new RegExp("^\\|\\s*" + feature.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\|", "m").test(archive);
}

/* The handoff's recorded outcome, if any (`## Session metadata` bullet). */
function handoffOutcome(handoffText) {
  const meta = sectionText(handoffText, "Session metadata");
  const m = meta.match(/^[-*]\s*outcome\s*:\s*(.+)$/im);
  return m ? m[1].trim().toLowerCase() : null;
}

/* The terminal success outcomes (mirror agent-report.js OUTCOMES). */
const DONE_OUTCOMES = new Set(["shipped", "resolved"]);

/* The plain-language resume instruction. Deliberately NOT a slash command:
 * `opencode run` receives a message, so the runner must work without assuming
 * the TUI's command surface. */
function resumePrompt(feature) {
  return (
    `Resume the bounded work unit ${feature} from its checkpoint only. ` +
    `Run \`node scripts/checkpoint.js resume --feature ${feature}\` and treat that ` +
    `block as the full state of the work — do not replay any previous transcript. ` +
    `Continue from its next_action through the gates, then run ` +
    `\`npm run finalize -- --feature ${feature}\` (archive + commit + land on main + ` +
    `confirm green CI), and record the handoff.`
  );
}

/* The finalization-phase instruction: implementation + verification are done, so
 * the fresh context must NOT re-run the doc chain or the gates — it only has to
 * land the change. `npm run finalize` archives, commits, lands the branch on
 * main, and confirms CI in one blocking call, which is short enough to survive
 * any remaining budget. */
function finalizePrompt(feature) {
  return (
    `Finalize the bounded work unit ${feature} — implementation + verification are ` +
    `already complete; do NOT replay the doc chain, re-read the transcript, or re-run ` +
    `the full gates. Run \`node scripts/checkpoint.js resume --feature ${feature}\` to ` +
    `read the state, ensure the CHANGELOG entry exists (one \`docs\` dispatch if it is ` +
    `missing), then run \`npm run finalize -- --feature ${feature}\` ONCE and let it ` +
    `run to completion: it archives the row, commits the tail, lands the branch ` +
    `directly on main, and waits for green CI. The deploy runs after CI.`
  );
}

/* The checkpoint's `phase` / `next_action` values, when recorded. Used to send a
 * resumed context straight to finalization instead of the generic resume. */
function checkpointPhase(handoffText) {
  const block = sectionText(handoffText, "Checkpoint");
  const m = block.match(/^-\s*phase:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

function checkpointNextAction(handoffText) {
  const block = sectionText(handoffText, "Checkpoint");
  const m = block.match(/^-\s*next_action:\s*(.+)$/im);
  return m ? m[1].trim() : null;
}

/* The checkpoint's monotonic counter (`checkpoint_count`, written by
 * scripts/checkpoint.js). It is how the runner tells "the fresh context
 * recorded the state it just reached" from "the context died without progress". */
function checkpointCount(handoffText) {
  const block = sectionText(handoffText, "Checkpoint");
  const m = block.match(/^-\s*checkpoint_count:\s*(\d+)\s*$/im);
  return m ? Number(m[1]) : null;
}

/* True when a handoff carries a checkpoint a fresh context can seed from: a
 * positive checkpoint_count, or a recorded next_action (the runner's progress
 * predicate). A context boundary without one can NEVER be resumed — writing a
 * marker for it only produces a silent no-op (F-064). */
function hasResumableCheckpoint(handoffText) {
  const count = checkpointCount(handoffText)
  return (Number.isFinite(count) && count > 0) || !!checkpointNextAction(handoffText);
}

/* ---------------------------------------------------- context-reset handshake
 *
 * A primary session cannot relaunch itself at the context ceiling, so the guard
 * writes `.agents/context-resume.json` when a session in a FEATURE worktree
 * crosses the `intervene` request level (see context-guard-core.js
 * `contextResumeMarker`). The marker is only a *claim* that the phase ended at a
 * context boundary rather than on a real failure: the runner accepts it only
 * when it is FRESH (written after the phase started), matches the feature, and
 * the phase made progress (the checkpoint advanced or a next_action exists).
 * Pure, so every rule is unit-testable without the plugin or a subprocess. */
const DEFAULT_MAX_CONTEXT_RESETS = 3;

/* --------------------------------------------------- technical-failure policy
 *
 * F-067: every observed stop gets a fallback checkpoint, but only a stop that MADE
 * PROGRESS may relaunch a fresh context. A pure infrastructure failure — network,
 * provider availability/rate limit, auth, memory/disk/process, funds/quota —
 * relaunching would burn budget against a broken environment. A logical/work
 * failure (failing test, lint/type error, bad edit, tool error) IS resumable and
 * is bounded by the same 3-context-reset cap as the checkpoint bands.
 *
 * Conservative on purpose: only a recognised signature is technical; an unknown
 * failure text stays resumable, so a classifier gap cannot silently disable the
 * loop. A context-window overflow is a boundary, never technical (the caller
 * checks `contextOverflow` first where that distinction matters).
 *
 * Status codes are anchored to an HTTP/status context: a bare `500` is a
 * plausible token count, so the classifier never reads it as a provider error.
 */
const TECHNICAL_FAILURE_PATTERNS = [
  // Network / DNS / TLS / transport.
  /\b(?:econnreset|econnrefused|econnaborted|etimedout|enotfound|eai_again|epipe|ehostunreach|enetunreach|ehostdown|esockettimedout|enetdown)\b/i,
  /\b(?:socket hang ?up|connection (?:reset|refused|closed|timed out|lost)|network (?:error|failure|unreachable|down)|dns (?:error|lookup|resolution)|getaddrinfo|err_(?:tls|ssl)[a-z_]*|unable to verify (?:the first |peer )?certificate|tls (?:handshake|certificate)|ssl (?:error|handshake|certificate)|certificate (?:error|expired|invalid)|timed out|timeout|fetch failed)\b/i,
  // Provider availability / rate limiting.
  /\b(?:http|status|code|error|response)\b[^\n]{0,16}\b(?:429|5\d\d)\b/i,
  /\b(?:429|too many requests|rate[- ]?limit(?:ed|ing)?)\b/i,
  /\b(?:internal server error|bad gateway|service unavailable|gateway timeout|overloaded)\b/i,
  // Auth.
  /\b(?:unauthori[sz]ed|forbidden|invalid api key|incorrect api key|authentication (?:error|failed)|permission denied|access denied|token (?:expired|invalid)|not authenticated)\b/i,
  /\b(?:http|status|code|error|response)\b[^\n]{0,16}\b40[13]\b/i,
  // Resource / process crash.
  /\b(?:enomem|oom|out of memory|heap out of memory|enospc|no space left|cannot allocate memory|killed|sigkill|sigterm|sigsegv|sigabrt|sigbus|segmentation fault|core dumped)\b/i,
  // Funds / quota: a hard pause; the user must top up first.
  /\b(?:insufficient (?:balance|funds|credits?|quota)|funds? (?:error|exhausted)|quota (?:exceeded|exhausted)|credits? (?:exhausted|expired|insufficient)|usage limit|billing (?:error|issue)|payment required|top[- ]?up)\b/i,
  /\b(?:http|status|code|error|response)\b[^\n]{0,16}\b402\b/i,
];

/* True when `text` names a pure infrastructure/provider/resource failure. The
 * empty/unknown text is never technical: the caller keeps the resumable path. */
function isTechnicalFailure(text) {
  const src = String(text == null ? "" : text);
  if (!src.trim()) return false;
  return TECHNICAL_FAILURE_PATTERNS.some((re) => re.test(src));
}

function contextResetStatus(input) {
  const marker = input?.marker && typeof input.marker === "object" ? input.marker : null;
  if (!marker) return { marker: null, fresh: false, featureMatch: false, progressed: false };
  const at = Date.parse(String(marker.at || ""));
  const started = Number(input?.phaseStartedAt);
  const fresh = Number.isFinite(at) && Number.isFinite(started) && at >= started;
  const wanted = input?.feature ? String(input.feature) : null;
  const claimed = marker.feature ? String(marker.feature) : null;
  // With no feature known yet (phase 0 claimed one), the marker supplies it.
  const featureMatch =
    claimed != null && (wanted == null || wanted.toUpperCase() === claimed.toUpperCase());
  const priorRaw = input?.priorCheckpointCount;
  const prior = priorRaw == null || priorRaw === "" ? null : Number(priorRaw);
  const current = checkpointCount(input?.handoffText);
  const advanced = Number.isFinite(current) && (Number.isFinite(prior) ? current > prior : current > 0);
  const progressed = advanced || !!checkpointNextAction(input?.handoffText);
  return { marker, fresh, featureMatch, progressed, feature: claimed, from: prior, to: current };
}

/* True when the checkpoint shows only the deterministic tail remains: the phase
 * names a verify/finalize/ship state, or next_action points at archive/ship. */
function finalizationReady(handoffText) {
  const phase = String(checkpointPhase(handoffText) || "");
  const next = String(checkpointNextAction(handoffText) || "");
  return /(final|verif|ship|deploy|done|complete)/i.test(phase) || /(finaliz|ship|deploy|archive)/i.test(next);
}

function initialPrompt() {
  return (
    "Pull the next item off the Queue and start working on it — no confirmation " +
    "needed; this is the explicit go. Follow .opencode/commands/next.md, report the " +
    "picked row first, and work it through to a landed change."
  );
}

/*
 * Decide the runner's next step.
 *
 *   { action: "done",  reason, feature }   — landed (archived / shipped outcome)
 *   { action: "resume", reason, feature, prompt }
 *   { action: "stop",  reason, feature }   — phase cap / no work / non-zero exit
 *
 * The order matters: a landed feature is always done, even at the phase cap; a
 * missing feature is never resumed (no guessing); a non-zero phase exit stops
 * unless the board already proves the work landed.
 */
function decideRunLoop(input) {
  const feature = input && input.feature ? String(input.feature) : null;
  const phasesRun = Number(input && input.phasesRun) || 0;
  const maxPhases = Number(input && input.maxPhases) || 4;
  const resetsRun = Number(input && input.contextResets) || 0;
  const maxResetsRaw = Number(input && input.maxContextResets);
  const maxContextResets =
    Number.isFinite(maxResetsRaw) && maxResetsRaw >= 0 ? maxResetsRaw : DEFAULT_MAX_CONTEXT_RESETS;
  const reset = contextResetStatus(input || {});
  const boundaryFeature = reset.feature || feature;

  if (feature && isArchived(input.backlogText, feature)) {
    return { action: "done", reason: `${feature} is archived on the board (landed)`, feature };
  }
  const outcome = handoffOutcome(input.handoffText);
  if (feature && outcome && DONE_OUTCOMES.has(outcome)) {
    return { action: "done", reason: `${feature} handoff outcome is \`${outcome}\``, feature };
  }

  // F-067: a technical/infrastructure failure stops even when a fresh, matching,
  // progressed context marker exists. The fallback checkpoint is already written,
  // so the work is resumable manually once the environment recovers.
  if (input && input.technicalFailure === true) {
    return {
      action: "stop",
      reason: `phase failed on a technical/infrastructure error${feature ? ` for ${feature}` : ""} — checkpoint recorded; resume manually after the environment recovers (never auto-relaunch against a broken provider/network/disk)`,
      feature,
    };
  }

  if (phasesRun >= maxPhases) {
    return { action: "stop", reason: `phase cap reached (${maxPhases}) before landing`, feature };
  }

  // A guard marker only turns the phase exit into a resumable context boundary
  // when it is fresh, matches the feature, and the phase recorded progress.
  // Same-length checkpoints (a re-write that adds nothing) mean the context died
  // without advancing the work — never relaunch that loop.
  const boundary = reset.fresh && reset.featureMatch && reset.progressed;
  if (reset.fresh && reset.featureMatch && !reset.progressed) {
    return {
      action: "stop",
      reason: `context boundary for ${boundaryFeature} did not advance the checkpoint — no resumable checkpoint was recorded, so a fresh context has nothing to seed from`,
      feature: boundaryFeature,
    };
  }
  if (boundary && resetsRun >= maxContextResets) {
    return {
      action: "stop",
      reason: `context reset cap reached (${maxContextResets}) on ${boundaryFeature} before landing — inspect instead of relaunching`,
      feature: boundaryFeature,
    };
  }

  // A failed phase stops the loop unless the board/handoff above proved landing
  // or the guard recorded a genuine context boundary with recorded progress.
  if (Number.isFinite(input.lastExit) && input.lastExit !== 0 && !boundary) {
    return {
      action: "stop",
      reason: `phase exited ${input.lastExit} and the work is not landed — inspect before resuming`,
      feature,
    };
  }

  if (phasesRun === 0) {
    return feature
      ? {
          action: "resume",
          reason: `starting on ${feature}`,
          feature,
          prompt: finalizationReady(input.handoffText) ? finalizePrompt(feature) : resumePrompt(feature),
        }
      : {
          action: "resume",
          reason: "starting the next-item workflow",
          feature: null,
          prompt: initialPrompt(),
        };
  }

  const next = feature || boundaryFeature || inProgressFeature(input.backlogText);
  if (!next) {
    return {
      action: "stop",
      reason: "no In-progress feature found after the phase — cannot resume safely",
      feature: null,
    };
  }
  const finalizing = finalizationReady(input.handoffText);
  const reason = finalizing
    ? `finalizing ${next} in a fresh bounded context (implementation complete)`
    : boundary
      ? `context boundary after checkpoint ${reset.to ?? "?"} — resuming ${next} in a fresh bounded context`
      : `resuming ${next} in a fresh bounded context`;
  return {
    action: "resume",
    reason,
    feature: next,
    prompt: finalizing ? finalizePrompt(next) : resumePrompt(next),
    contextReset: boundary,
  };
}

export {
  sectionText,
  firstRowId,
  inProgressFeature,
  isArchived,
  handoffOutcome,
  DONE_OUTCOMES,
  resumePrompt,
  finalizePrompt,
  checkpointPhase,
  checkpointNextAction,
  checkpointCount,
  hasResumableCheckpoint,
  DEFAULT_MAX_CONTEXT_RESETS,
  isTechnicalFailure,
  contextResetStatus,
  finalizationReady,
  initialPrompt,
  decideRunLoop,
};
