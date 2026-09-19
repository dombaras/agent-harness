#!/usr/bin/env node
"use strict";
/*
 * run-loop — pure decision core for the end-to-end auto-resume runner
 * (`agent-harness run`).
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
 * section (the ship watch + archive are the completion contract). */
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
    `Continue from its next_action through gates, commit, and \`npm run ship\` ` +
    `(watch to landed + UAT deploy), then record the handoff and archive the row.`
  );
}

/* The finalization-phase instruction: implementation + verification are done, so
 * the fresh context must NOT re-run the doc chain or the gates — it only has to
 * land the change. `npm run finalize` archives, commits, ships, and watches in
 * one blocking call, which is short enough to survive any remaining budget. */
function finalizePrompt(feature) {
  return (
    `Finalize the bounded work unit ${feature} — implementation + verification are ` +
    `already complete; do NOT replay the doc chain, re-read the transcript, or re-run ` +
    `the full gates. Run \`node scripts/checkpoint.js resume --feature ${feature}\` to ` +
    `read the state, ensure the CHANGELOG entry exists (one \`docs\` dispatch if it is ` +
    `missing), then run \`npm run finalize -- --feature ${feature}\` ONCE and let it ` +
    `run to completion: it archives the row, commits the tail, ships the branch, and ` +
    `watches the merge train + CI + UAT deploy. If it pauses enqueued, resume with ` +
    `\`npm run finalize -- --feature ${feature} --watch-only\`.`
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
    "needed; this is the explicit go. Follow .opencode/command/next.md, report the " +
    "picked row first, and work it through to a shipped branch."
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

  if (feature && isArchived(input.backlogText, feature)) {
    return { action: "done", reason: `${feature} is archived on the board (landed)`, feature };
  }
  const outcome = handoffOutcome(input.handoffText);
  if (feature && outcome && DONE_OUTCOMES.has(outcome)) {
    return { action: "done", reason: `${feature} handoff outcome is \`${outcome}\``, feature };
  }

  if (phasesRun >= maxPhases) {
    return { action: "stop", reason: `phase cap reached (${maxPhases}) before landing`, feature };
  }

  // A failed phase stops the loop unless the board/handoff above proved landing.
  if (Number.isFinite(input.lastExit) && input.lastExit !== 0) {
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

  const next = feature || inProgressFeature(input.backlogText);
  if (!next) {
    return {
      action: "stop",
      reason: "no In-progress feature found after the phase — cannot resume safely",
      feature: null,
    };
  }
  const finalizing = finalizationReady(input.handoffText);
  return {
    action: "resume",
    reason: finalizing
      ? `finalizing ${next} in a fresh bounded context (implementation complete)`
      : `resuming ${next} in a fresh bounded context`,
    feature: next,
    prompt: finalizing ? finalizePrompt(next) : resumePrompt(next),
  };
}

module.exports = {
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
  finalizationReady,
  initialPrompt,
  decideRunLoop,
};
