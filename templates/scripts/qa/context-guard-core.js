"use strict";

/* Context-guard core — pure, dependency-free state machine backing the
 * `.opencode/plugins/context-guard.ts` plugin. Kept separate from the plugin so
 * every rule is unit-testable with `node:test` (threshold parsing, band
 * transitions, loop counting, byte-stable injected text, guard-event JSONL).
 *
 * The plugin owns all IO (files, opencode client); this module owns no globals
 * and mutates only the state object it is handed. Thresholds are never
 * hardcoded here as runtime truth: `parseThresholds` reads the project-owned
 * `.agents/memory/orchestration.md` and falls back to the documented defaults.
 */

const DEFAULT_TURNS = Object.freeze({
  checkpoint_warning_turn: 50,
  soft_turn_budget: 60,
  compaction_target_turn: 60,
  new_context_preference_turn: 80,
  hard_safety_turn_limit: 100,
});

const DEFAULT_STUCK = Object.freeze({
  same_failure_turns: 3,
  identical_tool_calls: 3,
  no_state_change_turns: 4,
  inspect_rearm_every: 10,
  gate_rerun_turns: 3,
});

const DEFAULT_REQUEST = Object.freeze({
  observe: 50000,
  warn: 80000,
  checkpoint: 120000,
  intervene: 160000,
});

/* Band order is resolved by threshold VALUE (descending), not by a fixed list,
 * so a project can retune `orchestration.md` without breaking the guard:
 * `turnBand` returns the highest band the turn count has reached. */
const TURN_BANDS = [
  ["hard_safety_turn_limit", "hard"],
  ["new_context_preference_turn", "new-context"],
  ["compaction_target_turn", "checkpoint"],
  ["checkpoint_warning_turn", "warning"],
];

/* Severity order for combining signals. A band is "higher" when its rank is
 * greater, so the strongest pressure — turn count OR request context — wins. */
const BAND_RANK = Object.freeze({ warning: 1, checkpoint: 2, "new-context": 3, hard: 4 });

const REQUEST_LEVELS = ["observe", "warn", "checkpoint", "intervene"];

/* Request-context pressure mapped onto the SAME bands as turns, so the nudge
 * text is driven by whichever signal is louder. Turn count is a coarse proxy for
 * transcript growth; request context is the real cost driver (~97% cache reads,
 * so cost ≈ Σ context × turns). `observe` is telemetry only. */
const REQUEST_BAND = Object.freeze({
  observe: null,
  warn: "warning",
  checkpoint: "checkpoint",
  intervene: "new-context",
});

/* Injected text is CONSTANT per band — never interpolated with the turn count —
 * so the appended system tail stays byte-stable and cache-friendly (the guard
 * must not turn every request into a fresh cache write). */
const BAND_TEXT = Object.freeze({
  warning:
    "CONTEXT GUARD — checkpoint warning (ADVISORY, not a stop): the orchestrator is approaching its turn/context budget (`checkpoint_warning_turn` and the request-token levels in `.agents/memory/orchestration.md`). Keep working: finish the current phase step and continue the task — do NOT stop mid-phase or ask for permission to continue. Write ONE compact deterministic checkpoint to `.agents/handoffs/<feature-id>.md` at the next natural phase boundary. FINALIZATION CARVE-OUT: if implementation + verification are complete and only the finalization tail remains (docs/CHANGELOG, archive, commit, land, confirm CI), do NOT stop — run `npm run finalize -- --feature <id>` ONCE and let it run to completion; that single call archives, commits, lands the branch directly on main, and confirms green CI (the deploy runs after CI).",
  checkpoint:
    "CONTEXT GUARD — soft turn budget reached: checkpoint ONCE now — task id/feature/objective/phase, completed and active dispatches, files changed, contracts, known facts, decisions, risks, next_action — into `.agents/handoffs/<feature-id>.md`, then STOP this transcript at the current phase boundary; a fresh bounded context resumes from the checkpoint. Do not begin the next phase here, and do not write a second checkpoint in this transcript. FINALIZATION CARVE-OUT: if implementation + verification are complete and only the finalization tail remains (docs/CHANGELOG, archive, commit, land, confirm CI), do NOT stop — run `npm run finalize -- --feature <id>` ONCE and let it run to completion; that single call archives, commits, lands the branch directly on main, and confirms green CI (the deploy runs after CI).",
  "new-context":
    "CONTEXT GUARD — strong new-context preference: do not keep growing this transcript. Checkpoint once now, then continue only in a fresh bounded context that reads the checkpoint plus the current task — never the replayed transcript. If only the finalization tail remains, run `npm run finalize -- --feature <id>` once instead of stopping — it archives, commits, lands directly on main, and confirms CI.",
  hard:
    "CONTEXT GUARD — hard safety ceiling reached: stop starting new work, checkpoint once, and finish. A running tool call still completes — never kill it mid-operation. FINALIZATION CARVE-OUT: if only the finalization tail remains, run `npm run finalize -- --feature <id>` once and allow it to finish — it archives, commits, lands the branch directly on main, and confirms green CI. A landed change is a completed one; a red or unconfirmed CI is the blocker to record.",
});

/* Provenance banner prepended to every injected block. The guard is delivered as
 * a synthetic user-role message (the only shape opencode forwards from the
 * messages transform), so without an explicit banner the model can mistake the
 * nudge for the human speaking. LibraryOS F-259: the model read the no-state
 * nudge as "the user is asking for a status update" and stopped to ask for
 * permission the `/next` command had already granted. Constant text, so the
 * cached prefix stays byte-stable. */
const GUARD_PROVENANCE =
  "AUTOMATED HARNESS NUDGE — this is NOT a user message and NOT a user request. It is mechanical context-budget guidance from the agent harness. Keep executing the current task; the real user's explicit instruction takes precedence over this nudge except at the hard safety ceiling.";

const LOOP_TEXT =
  "CONTEXT GUARD — repeated identical tool call detected (`identical_tool_calls` in `.agents/memory/orchestration.md`). Do not repeat it again: change instructions, context, model, decomposition, or diagnostics — or report the blocker. A retry must materially change something.";

/* No-material-progress nudge. The F-256 pause showed the orchestrator writing
 * five checkpoints while warned and then stopping mid-phase; a checkpoint with
 * no code/state change is not progress. Armed when whole turns pass with no
 * file/state mutation (`no_state_change_turns`). */
const NO_STATE_TEXT =
  "CONTEXT GUARD — no material state change detected across several turns (`no_state_change_turns` in `.agents/memory/orchestration.md`). Stop re-reading or re-checkpointing and make a materially changing action NOW: edit code, run the failing gate with NEW diagnostics, change the decomposition/model, or gather new runtime evidence (a DB query, a runtime probe, a live reproduction) — investigation that produces new facts counts as progress. Continue the task; do not stop or ask for permission. Another checkpoint with no state change is not progress.";

/* Same-failure nudge. Distinct from `identical_tool_calls`: the failure is the
 * same even when the arguments differ. Armed when the same failure signature
 * repeats across tool calls (`same_failure_turns`). */
const FAILURE_TEXT =
  "CONTEXT GUARD — the same failure is repeating (`same_failure_turns` in `.agents/memory/orchestration.md`). Do not retry the identical action: change instructions, context, model, decomposition, or diagnostics — or report the blocker. A second attempt must materially change something.";

/* Provider funds/quota failures are a hard stop in `.agents/memory/model-routing.md`:
 * the harness must pause and wait for the user's top-up instead of degrading
 * inline. The regex is deliberately narrow (balance/funds/credits/limits/402) so
 * ordinary task failures never trigger the stop. */
const FUNDS_RE =
  /insufficient (?:balance|funds|credits?)|out of (?:credits?|funds)|credit balance|(?:usage|quota) (?:limit|exceeded)|exceeded your (?:usage|quota)|payment required|status(?:Code)?["'\s:]*402/i;

/* The failure label is the concrete account to top up (`opencode/gpt-5.6-luna`,
 * `deepseek/deepseek-v4-pro`), taken from the observed dispatch metadata — never
 * guessed. `where` names the surface that observed it (tool/event). Both are
 * interpolated only when known, so the unknown case stays byte-identical to the
 * original generic rule. */
function fundsText(label, where) {
  const who = label ? ` from \`${label}\`` : "";
  const at = where ? ` (observed in ${where})` : "";
  const announce = label
    ? `Announce the failing provider/model (\`${label}\`)`
    : "Announce which provider/model failed";
  return `PROVIDER GUARD — a provider funds/quota error was observed${who}${at} (insufficient balance / credits / usage limit). STOP now: do not retry this call, do NOT do the persona's work inline, and do not silently switch providers. ${announce} and the exact unfinished step, checkpoint the state to \`.agents/handoffs/<feature-id>.md\`, then end the turn and wait for the user's explicit top-up-complete / continue message before resuming.`;
}

const FUNDS_TEXT = fundsText();

function fundsError(text) {
  return FUNDS_RE.test(String(text || ""));
}

/* Only STRUCTURED failure evidence may arm the stop. Scanning the text of every
 * successful tool result false-positives on the harness's own documents: the
 * mandated session-start read of `.agents/memory/model-routing.md` — and any
 * handoff/plan/rulebook that quotes the funds rule — contains the literal
 * trigger phrases, which paused sessions (F-169, LibraryOS) that had never seen
 * a provider failure. Genuine failures carry a signal:
 *   - `error` — a tool that reported failure: a dispatch whose subagent died
 *     with "Subagent failed (...): Insufficient balance", or any thrown tool
 *     error (observed shape: task metadata carries the failed model);
 *   - `bash` with a non-zero `metadata.exit` — the command failed, so a
 *     provider CLI's funds error is in its output.
 * Everything else (read/grep/glob content, successful dispatches and commands)
 * is context, never failure evidence. Returns the text to scan, or null. */
function fundsArmText(tool, output) {
  if (output?.error) return String(output.error);
  if (String(tool || "") === "bash" || String(tool || "") === "shell") {
    const exit = output?.metadata?.exit;
    if (Number.isFinite(exit) && exit !== 0) {
      return typeof output?.output === "string" ? output.output : JSON.stringify(output ?? {});
    }
  }
  return null;
}

/* `provider/model` label from an opencode assistant message (providerID/modelID)
 * or a dispatch metadata model object (provider/model). Null when neither side
 * is known, so a label is only ever reported from observed data. */
function modelLabel(info) {
  if (!info || typeof info !== "object") return null;
  const provider = info.providerID || info.provider;
  const model = info.modelID || info.model;
  if (provider && model) return `${provider}/${model}`;
  if (model) return String(model);
  return null;
}

/* Identical repeats of these are legitimate and must not count as loops:
 * todo list rewrites, user questions, dispatches (retries are governed by the
 * bounded-retry ladder), batched calls, board listings, the session join-key
 * lookup, and the documented serve.js health polling. */
const EXEMPT_TOOLS = new Set(["todowrite", "question", "task", "subagent", "batch", "backlog_list", "session_info"]);

const SERVE_POLL = /serve\.js\s+(list|status)\b/;

/* A tool call that MATERIALLY changes repository state (as opposed to a read,
 * grep, test run, or dispatch). Used only by the no-state-change detector: a
 * whole turn with none of these is spinning, and the recovery nudge fires. A
 * `task` dispatch counts as material — a subagent that edits files is progress
 * even though the orchestrator's own tool arguments changed nothing. */
const MATERIAL_TOOLS = new Set(["write", "edit", "patch", "multiedit", "apply_patch", "task", "subagent"]);
const MATERIAL_BASH_RE =
  /(^|[^a-z])(git\s+(commit|push|apply|am|merge|rebase|cherry-pick|stash|add)\b)|\|\s*tee\b|\bsed\s+-i\b|\b(rm|mv|cp|mkdir|touch)\b|>>?\s*[^&\s]|\bnpm\s+(install|ci|i)\b/;

function isMaterial(tool, args) {
  const name = String(tool || "").toLowerCase();
  if (MATERIAL_TOOLS.has(name)) return true;
  if (name === "bash" || name === "shell") return MATERIAL_BASH_RE.test(String(args?.command || ""));
  return false;
}

/* Parse the machine-read values out of `orchestration.md`. Only the table row
 * SHAPES matter — `| \`key\` | 60 | ... |` for turn/stuck keys and
 * `| warn | 80K | ... |` for request levels. Anything missing falls back to the
 * documented defaults, so a hand-trimmed file still guards. */
function parseThresholds(text) {
  const turns = { ...DEFAULT_TURNS };
  const stuck = { ...DEFAULT_STUCK };
  const request = { ...DEFAULT_REQUEST };
  for (const line of String(text || "").split(/\r?\n/)) {
    const keyed = line.match(/^\|\s*`?([a-z_]+)`?\s*\|\s*(\d+)\s*\|/);
    if (keyed) {
      const value = Number(keyed[2]);
      if (keyed[1] in turns) turns[keyed[1]] = value;
      else if (keyed[1] in stuck) stuck[keyed[1]] = value;
      continue;
    }
    const level = line.match(/^\|\s*(observe|warn|checkpoint|intervene)\s*\|\s*(\d+)\s*K?\+?\s*\|/);
    if (level) request[level[1]] = Number(level[2]) * 1000;
  }
  return { turns, stuck, request };
}

function turnBand(turn, turns) {
  const ordered = TURN_BANDS.map(([key, band]) => ({ band, at: turns ? turns[key] : undefined }))
    .filter((b) => Number.isFinite(b.at))
    .sort((a, b) => b.at - a.at);
  for (const b of ordered) if (turn >= b.at) return b.band;
  return null;
}

function bandRank(band) {
  return BAND_RANK[band] || 0;
}

function requestBand(level) {
  return REQUEST_BAND[level] || null;
}

/* The band the session should act on: the stronger of the turn band and the
 * request-context band. Either signal alone can trigger the nudge, so a small
 * turn count with a bloated context is caught just as a long transcript is. */
function pressureBand(state, thresholds) {
  const turn = turnBand(state?.turns, thresholds?.turns);
  const req = requestBand(state?.requestLevel);
  return bandRank(req) > bandRank(turn) ? req : turn;
}

function bandText(band) {
  return BAND_TEXT[band] || null;
}

/* The ordered guard texts a request should carry: the highest reached turn band,
 * then the funds stop, then the loop-recovery rule. Pure, so the plugin stays a
 * thin IO layer and the composition is unit-testable. Returns [] when there is
 * nothing to say. */
function guardTexts(state, thresholds) {
  const texts = [];
  const band = pressureBand(state, thresholds);
  if (band) {
    const text = bandText(band);
    if (text) texts.push(text);
  }
  if (state?.fundsPending) texts.push(state.fundsNotice || FUNDS_TEXT);
  if (state?.failurePending) texts.push(FAILURE_TEXT);
  if (state?.noStatePending) texts.push(NO_STATE_TEXT);
  if (state?.loopPending) texts.push(LOOP_TEXT);
  if (state?.inspectPending) texts.push(INSPECT_TEXT);
  if (state?.readPending && READ_TEXTS[state.readPending]) texts.push(READ_TEXTS[state.readPending]);
  if (state?.dumpPending) texts.push(DUMP_TEXT);
  if (state?.editMissPending) texts.push(EDIT_MISS_TEXT);
  if (state?.gateRerunPending) texts.push(GATE_RERUN_TEXT);
  if (state?.waitPending) texts.push(WAIT_TEXT);
  return texts;
}

/* The single block injected into the conversation TAIL (never the system prompt,
 * so the cached prefix stays byte-stable). The provenance banner leads so the
 * synthetic user-role message can never be mistaken for the human. Null when
 * there is nothing to inject. */
function composeGuardText(state, thresholds) {
  const texts = guardTexts(state, thresholds);
  return texts.length ? [GUARD_PROVENANCE, ...texts].join("\n\n") : null;
}

function requestLevel(tokens, request) {
  if (!Number.isFinite(tokens)) return null;
  let level = null;
  for (const name of REQUEST_LEVELS) {
    if (Number.isFinite(request?.[name]) && tokens >= request[name]) level = name;
  }
  return level;
}

/* Request-context size the provider reports for an assistant message. Cache
 * reads/writes are part of the request; output tokens are not. */
function requestTokensOf(message) {
  const t = message?.tokens;
  if (!t) return null;
  const cache = t.cache || {};
  return (t.input || 0) + (cache.read || 0) + (cache.write || 0);
}

/* Order-independent JSON so `{a:1,b:2}` and `{b:2,a:1}` are the same call. */
function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + stableStringify(value[k]))
      .join(",") +
    "}"
  );
}

/* Short FNV-1a digest — the guard-event log stores a hash, never the raw args
 * (commands can carry secrets and the log is read by later telemetry passes). */
function shortHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function isLoopExempt(tool, args) {
  const name = String(tool || "");
  if (EXEMPT_TOOLS.has(name)) return true;
  if (name === "bash") {
    const command = String(args?.command || "");
    if (SERVE_POLL.test(command)) return true;
  }
  return false;
}

function loopKey(tool, args) {
  return String(tool || "") + ":" + stableStringify(args ?? {});
}

function createSessionState() {
  return {
    turns: 0,
    assistantIds: new Set(),
    band: null,
    requestLevel: null,
    requestTokens: null,
    toolCounts: new Map(),
    flaggedLoops: new Set(),
    loopPending: false,
    fundsPending: false,
    fundsNotice: null,
    // no-state-change detector
    materialSeen: false,
    noStateTurns: 0,
    noStatePending: false,
    // same-failure detector
    lastFailureKey: null,
    consecutiveFailures: 0,
    failurePending: false,
    failureFlagged: false,
    // tool-choice / read / whole-tree hygiene (advisory one-shot nudges)
    inspectPending: false,
    inspectFlagged: false,
    // inspect re-arm (D): count every inspection, re-arm the advisory after
    // `inspect_rearm_every` further inspections or on a different head.
    inspectCount: 0,
    inspectFlaggedAt: 0,
    inspectLastHead: null,
    readSeen: new Set(),
    readNotices: new Set(),
    readPending: null,
    dumpPending: false,
    dumpFlagged: false,
    // edit-miss (E): a failed edit/write/apply_patch on a guessed path
    editMissPending: false,
    editMissFlagged: false,
    // gate re-run (F): same gate run repeatedly with no intervening edit
    gateRuns: new Map(),
    gateRerunPending: false,
    gateRerunFlagged: new Set(),
    // wait/poll advisory (B)
    waitPending: false,
    waitFlagged: false,
    // structural tool blocks: the first pure inspection of each head / poll of
    // each kind is blocked once per session (see inspectBlockText/pollBlockText).
    blockedInspectHeads: new Set(),
    blockedPollKinds: new Set(),
    // session-start orientation injection: the one-call `orient --brief` block,
    // injected into the cache-safe tail until the session's first material action
    // (then cleared) so a resume/claim prologue re-derives nothing by hand.
    orientPending: false,
    orientText: null,
  };
}

/* Record an assistant message. `message.updated` fires repeatedly per message,
 * so a NEW id is one orchestrator turn; a repeat of a seen id is not. Returns
 * the transitions (band + request level + no-state) for the plugin to log —
 * never the raw every-request state, so the JSONL only carries crossings.
 *
 * Token refresh runs on EVERY emit, including repeats of a seen id. opencode
 * emits a tokenless (all-zero) `message.updated` first, then a later emit for
 * the SAME id carrying the real usage; deduping the whole handler dropped that
 * second emit, so `requestTokens` never left 0 and the request-token band was
 * dead in production (0 `request` guard events ever). Turn counting and the
 * no-state detector still run only on the first emit of an id.
 *
 * A new turn also FINALIZES the previous turn's materiality: its tool calls
 * have all run by now, so `materialSeen` is authoritative for that turn. Whole
 * turns without a material change arm the no-state nudge. */
function noteAssistant(state, message, thresholds) {
  const out = {
    newTurn: false,
    turns: state.turns,
    band: state.band,
    bandChanged: false,
    requestLevel: state.requestLevel,
    requestChanged: false,
    requestTokens: null,
    noStateChanged: false,
    noStatePending: state.noStatePending,
    noStateTurns: state.noStateTurns,
  };
  const id = message?.id;
  if (!id) return out;

  const seen = state.assistantIds.has(id);
  if (!seen) {
    const priorTurns = state.turns;
    state.assistantIds.add(id);
    state.turns += 1;
    out.newTurn = true;
    out.turns = state.turns;

    if (priorTurns > 0) {
      if (state.materialSeen) state.noStateTurns = 0;
      else state.noStateTurns += 1;
      state.materialSeen = false;
      const nsThreshold = Number.isFinite(thresholds?.stuck?.no_state_change_turns)
        ? thresholds.stuck.no_state_change_turns
        : 4;
      if (state.noStateTurns >= nsThreshold && !state.noStatePending) {
        state.noStatePending = true;
        out.noStateChanged = true;
      }
    }
    out.noStatePending = state.noStatePending;
    out.noStateTurns = state.noStateTurns;
  }

  // Token refresh on every emit (first or repeat), then derive the combined
  // pressure band so a context-token crossing is reflected on the same emit it
  // is observed — not just the first, tokenless one.
  const tokens = requestTokensOf(message);
  if (tokens != null) state.requestTokens = tokens;
  out.requestTokens = state.requestTokens;
  const level = requestLevel(state.requestTokens, thresholds?.request);
  if (level !== state.requestLevel) {
    state.requestLevel = level;
    out.requestLevel = level;
    out.requestChanged = true;
  }

  const band = pressureBand(state, thresholds);
  if (band !== state.band) {
    state.band = band;
    out.band = band;
    out.bandChanged = true;
  }
  return out;
}

/* Count identical tool+args calls cumulatively per session ("the worst sessions
 * ran the same tool 100-150x" is cumulative, not consecutive). The first breach
 * of `identical_tool_calls` is flagged once; `loopPending` stays true while the
 * identical call repeats and clears on the next materially different call, so
 * the recovery rule is injected exactly while the loop persists. */
function noteToolCall(state, tool, args, stuck) {
  const material = isMaterial(tool, args);
  if (material) {
    state.materialSeen = true;
    state.noStateTurns = 0;
    state.noStatePending = false;
    state.orientPending = false; // real work began — drop the session-start orient block
    resetGateRuns(state); // a batched edit invalidates prior gate results
  }
  const exempt = isLoopExempt(tool, args);
  if (exempt) {
    return { counted: false, count: 0, loop: false, firstFlag: false, keyHash: null, material };
  }
  const key = loopKey(tool, args);
  const count = (state.toolCounts.get(key) || 0) + 1;
  state.toolCounts.set(key, count);
  const threshold = Number.isFinite(stuck?.identical_tool_calls) ? stuck.identical_tool_calls : 3;
  const loop = count >= threshold;
  let firstFlag = false;
  if (loop && !state.flaggedLoops.has(key)) {
    state.flaggedLoops.add(key);
    firstFlag = true;
  }
  state.loopPending = loop;
  return { counted: true, count, loop, firstFlag, keyHash: shortHash(key), material };
}

/* Track tool-call failures. Distinct from the identical-call counter: the same
 * failure can repeat with different arguments. A success clears the streak; the
 * first time the same failure signature reaches `same_failure_turns` the
 * recovery nudge is armed (and reported once). Pure; the plugin supplies
 * `failureText` from structured tool-result evidence. */
function noteToolResult(state, tool, args, ok, failureText, stuck) {
  const out = { failed: !ok, count: 0, pending: false, firstFlag: false, keyHash: null };
  if (ok) {
    state.lastFailureKey = null;
    state.consecutiveFailures = 0;
    state.failurePending = false;
    state.failureFlagged = false;
    return out;
  }
  const key = String(tool || "") + ":" + shortHash(String(failureText || "").slice(0, 2000));
  if (key === state.lastFailureKey) state.consecutiveFailures += 1;
  else {
    state.lastFailureKey = key;
    state.consecutiveFailures = 1;
  }
  const threshold = Number.isFinite(stuck?.same_failure_turns) ? stuck.same_failure_turns : 3;
  const pending = state.consecutiveFailures >= threshold;
  out.count = state.consecutiveFailures;
  out.keyHash = shortHash(key);
  out.pending = pending;
  if (pending && !state.failureFlagged) {
    state.failureFlagged = true;
    out.firstFlag = true;
  }
  state.failurePending = pending;
  return out;
}

/* One JSON object per line — the Phase B telemetry substrate, read without a
 * sqlite dependency. `ts` leads so a plain `sort` works. */
function formatGuardEvent(event) {
  return JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
}

// ------------------------------------------------------- branch-switch guard
/* A shared checkout's HEAD can be moved out from under a running session by
 * another primary session in the SAME tree (`git checkout <branch>` /
 * `git switch`). The session that was mid-task then commits and pushes on the
 * wrong branch. LibraryOS 2026-09-18: session A's `docs/f-239-record-landing`
 * was replaced by session B's `git checkout main`, and A's later bare
 * `git commit` + `git push` landed directly on main. The plugin blocks a branch
 * switch while another LIVE primary lease shares this checkout, forcing the
 * second session to isolate (`backlog worktree <id> --open`) first.
 *
 * `branchSwitch` is the pure parser; the plugin owns the lease census and the
 * throw. It scans only COMMAND POSITION git (never an argument to echo/grep)
 * and treats any `--` as a path restore (`git checkout -- <paths>`), so the
 * everyday file-restore forms never false-positive. It is deliberately
 * conservative: a single positional without `--` (`git checkout main`,
 * `git checkout .`) is treated as a HEAD move, because in a two-session tree
 * even an in-place restore is a collision worth isolating for. */
const GIT_WRAPPERS = new Set(["sudo", "env", "nohup", "time", "command", "exec"]);

/* Flags whose presence makes `git checkout` a branch/HEAD move rather than a
 * path restore. `-` is `git checkout -` (switch to the previous branch). */
const BRANCH_CHECKOUT_FLAGS = new Set([
  "-b",
  "-B",
  "--orphan",
  "--detach",
  "--track",
  "-t",
  "--guess",
  "--no-guess",
  "-",
]);

const GIT_GLOBAL_WITH_ARG = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function tokenize(segment) {
  const tokens = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s]+)/g;
  let m;
  while ((m = re.exec(String(segment || "")))) tokens.push(m[1] ?? m[2] ?? m[3]);
  return tokens;
}

function isRedirection(token) {
  return /^\d*[<>]/.test(token) || token === "&>" || token === ">&";
}

function basename(token) {
  const parts = String(token || "").split(/[\\/]/);
  return parts[parts.length - 1];
}

/* The raw value of a repo-selecting global option (`-C <path>`, `--git-dir[=]`,
 * `--work-tree[=]`), or null. Kept pure: the caller resolves it against the
 * command cwd and classifies the enclosing checkout (a `--git-dir` pointing at a
 * `.git` directory resolves to its repo root when the classifier walks up). */
function gitRepoSelector(tokens, at) {
  const t = tokens[at];
  if (t === "-C" || t === "--work-tree" || t === "--git-dir") return tokens[at + 1] || null;
  const eq = /^--(git-dir|work-tree)=(.*)$/.exec(t);
  return eq ? eq[2] || null : null;
}

/* The git subcommand in command position of one shell segment, or null. Env
 * assignments and the common wrappers (`sudo git ...`) are skipped. Global
 * options (`-C`, `--git-dir`, `--work-tree`, ...) are stepped over to find the
 * subcommand, but the repo selector is captured as `target` so the caller can
 * classify the checkout the command actually writes to (a `git -C <main>` from
 * an unrelated cwd must not escape the guard). */
function gitSubcommand(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const base = basename(tokens[i]);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || GIT_WRAPPERS.has(base)) {
      i++;
      continue;
    }
    break;
  }
  if (i >= tokens.length || basename(tokens[i]) !== "git") return null;
  let j = i + 1;
  let target = null;
  while (j < tokens.length) {
    const t = tokens[j];
    if (GIT_GLOBAL_WITH_ARG.has(t)) {
      const sel = gitRepoSelector(tokens, j);
      if (sel && !target) target = sel;
      j += 2;
      continue;
    }
    if (/^--(git-dir|work-tree|namespace|exec-path)=/.test(t)) {
      const sel = gitRepoSelector(tokens, j);
      if (sel && !target) target = sel;
      j += 1;
      continue;
    }
    if (t.startsWith("-")) {
      j += 1;
      continue;
    }
    return { subcommand: t, args: tokens.slice(j + 1), target };
  }
  return null;
}

function firstPositional(args) {
  for (const a of args) {
    if (a === "-") return "-";
    if (a.startsWith("-") || isRedirection(a)) continue;
    return a;
  }
  return null;
}

/* { ref } when the shell command moves the checked-out branch, else null. */
function branchSwitch(command) {
  for (const segment of String(command || "").split(/\r?\n|&&|\|\||;|\|/)) {
    const found = gitSubcommand(tokenize(segment));
    if (!found) continue;
    const { subcommand, args } = found;
    if (subcommand === "switch") return { ref: firstPositional(args) };
    if (subcommand !== "checkout") continue;
    if (args.includes("--")) continue; // `... -- <path>` is a restore
    if (args.some((a) => BRANCH_CHECKOUT_FLAGS.has(a))) return { ref: firstPositional(args) };
    const positionals = args.filter((a) => !a.startsWith("-") && !isRedirection(a));
    if (positionals.length !== 1) continue; // 0 args lists status; 2+ is `<tree> <path>`
    const only = positionals[0];
    // `.`/`..`/`./x` are unambiguously paths, never branch names.
    if (only === "." || only === ".." || only.startsWith("./") || only.startsWith("../")) continue;
    return { ref: only };
  }
  return null;
}

/* The error the plugin throws to abort the switch. Names the branch and the
 * other live sessions so the fix (isolate) is mechanical. */
function branchSwitchText(ref, others) {
  const target = ref ? `\`${ref}\`` : "another branch";
  const who =
    Array.isArray(others) && others.length
      ? others.map((s) => `\`${s}\``).join(", ")
      : "another primary session";
  return `SESSION GUARD — blocked a branch switch to ${target}: ${who} is live in the same checkout. Two primary sessions must not share one working tree — the switch would move HEAD under the other session, which could then commit/push on the wrong branch (the 2026-09-18 direct-push-to-main incident). Isolate first: run \`backlog worktree <id> --open\` from the MAIN tree and work in that worktree, or let the other session finish. The switch was NOT executed.`;
}

// ------------------------------------------------------- main-checkout guard
/* `main` is board + shippable code only: every feature works in its own linked
 * worktree, so a session rooted in the shared main checkout must isolate BEFORE
 * it changes code. F-278 (LibraryOS 2026-09-22) was the counter-example: the
 * change was implemented straight into `main`, then `finalize` refused on `main`
 * and the branch switch that would have isolated it was blocked by the
 * branch-switch guard while other live sessions shared the tree — the work was
 * stranded. This classifier is the preventive half: the plugin resolves the
 * target + worktree roots (IO) and throws when a code change or git mutation is
 * aimed at the main checkout.
 *
 * "Code" excludes the harness's own metadata (`.agents/`, `.serve/`, `.git/`,
 * `node_modules/`) and human docs (Markdown/text), so checkpoint / handoff /
 * QA-plan / CHANGELOG maintenance on `main` stays allowed — only source, test,
 * and config edits require a worktree. Pure, so it is unit-testable. */
const NON_CODE_SEGMENTS = new Set([".agents", ".serve", ".git", "node_modules"]);
const NON_CODE_EXT = new Set([".md", ".mdx", ".txt", ".rst"]);
const NON_CODE_BASENAMES = new Set(["BACKLOG.md", "README.md", "CHANGELOG.md"]);

function isCodePath(filePath) {
  const p = String(filePath || "").replace(/\\/g, "/");
  if (!p) return false;
  const segments = p.split("/").filter(Boolean);
  if (segments.some((s) => NON_CODE_SEGMENTS.has(s))) return false;
  const base = segments[segments.length - 1] || "";
  if (NON_CODE_BASENAMES.has(base)) return false;
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? base.slice(dot).toLowerCase() : "";
  return !NON_CODE_EXT.has(ext);
}

/* Git subcommands that write content or history into the current checkout.
 * Read-only git (`status`/`fetch`/`log`/`diff`/`show`) and `worktree add` (the
 * isolation primitive itself) are deliberately absent, so a session on `main`
 * can still inspect and isolate. HEAD moves (`checkout`/`switch`) are owned by
 * the branch-switch guard, so they are left out here to keep one rule per
 * failure mode. */
const GIT_MUTATIONS = new Set([
  "add", "commit", "push", "apply", "am", "merge", "rebase",
  "cherry-pick", "revert", "reset", "clean", "rm", "mv", "stash",
]);

/* A redirect target that never lands in the working tree: discard/stdio, the
 * OS temp dirs, and the gitignored `.serve/` runtime container. */
function isAllowedWriteTarget(target) {
  const s = String(target || "").replace(/^["']|["']$/g, "");
  if (s === "/dev/null" || s === "/dev/stdout" || s === "/dev/stderr") return true;
  if (/^\/dev\/fd\//.test(s)) return true;
  if (/^\/(tmp|var\/tmp)\//.test(s)) return true;
  if (/(^|\/)\.serve\//.test(s)) return true;
  return false;
}

/* Drop single/double quoted substrings before scanning for redirections, so a
 * literal `->` or `>` inside an echo/grep argument is never read as a file
 * write. */
function stripQuoted(text) {
  return String(text || "").replace(/"(?:\\.|[^"\\])*"|'(?:[^']*)'/g, " ");
}

/* Git subcommands whose positional args are path operands (`git add <paths>`),
 * as opposed to history ops that name no paths (`git push`, `git rebase`). For
 * `commit`/`reset` only post-`--` args are pathspecs; a bare trailing arg is
 * ambiguous and stays pathless (conservative). */
const GIT_PATHSPEC_SUBCOMMANDS = new Set(["add", "rm", "mv", "apply"]);

/* Flags that consume the NEXT token as their value, so it must not be mistaken
 * for a pathspec (`git commit -m "docs: fix"`). */
const GIT_VALUE_FLAGS = new Set([
  "-m", "--message", "-F", "--file", "--author", "--date", "--reuse-message",
  "-c", "-C", "--fixup", "--squash", "--template", "--pathspec-from-file",
  "--exclude", "--chmod", "--src-prefix", "--dst-prefix", "--directory",
  "--trailer", "--cleanup",
]);

/* The explicit pathspecs named by one git mutation. Empty means the op carries
 * no static path info (a whole-index `commit`, a `push`, a `rebase`) and the
 * caller must resolve the affected paths at runtime. */
function gitPathspecs(subcommand, args) {
  const out = [];
  let afterDash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (afterDash) {
      out.push(a);
      continue;
    }
    if (a === "--") {
      afterDash = true;
      continue;
    }
    if (a.startsWith("-")) {
      if (GIT_VALUE_FLAGS.has(a)) i += 1;
      continue;
    }
    const partial = (subcommand === "commit" || subcommand === "reset") && (a.includes("/") || a.startsWith("."));
    if (GIT_PATHSPEC_SUBCOMMANDS.has(subcommand) || partial) out.push(a);
  }
  return out;
}

/* The non-git content mutators (`sed -i`, `perl -i`, `patch`, `tee`, redirect)
 * whose target path is named in the command, now resolved against `isCodePath`
 * so an in-place edit to a docs/metadata file does not read as code. */
function contentCodeMutation(tokens, cmd) {
  const head = tokens.find((t) => !isRedirection(t) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
  if (head) {
    const base = basename(head);
    const rest = tokens.slice(tokens.indexOf(head) + 1);
    const operands = rest.filter((t) => !t.startsWith("-"));
    // The FILE operand is the last positional (`sed [opts] script file`,
    // `perl [opts] code file`); a script-only invocation stays conservative.
    const target = operands[operands.length - 1];
    if (base === "sed" && rest.some((t) => /^-i/.test(t)) && (!target || isCodePath(target))) return true;
    if (base === "perl" && rest.some((t) => /^-[^\s]*i/.test(t)) && (!target || isCodePath(target))) return true;
    if (base === "patch") return true;
    if (base === "tee") {
      const teeTarget = rest.find((t) => !t.startsWith("-"));
      if (teeTarget && !isAllowedWriteTarget(teeTarget) && isCodePath(teeTarget)) return true;
    }
  }
  // A redirect into the tree is conservative code regardless of extension: it
  // is a build/command output, not the board/docs maintenance carve-out.
  // The lookbehind skips a `>` that is part of an arrow (`=>`) or comparison
  // (`>=`) — a JS one-liner passed through `npx tsx -e` was read as a redirect.
  // The target class stops at shell metacharacters so `2>/dev/null)` and
  // `>/dev/null;` resolve to the allowed `/dev/null`, not `/dev/null)`.
  const redir = /(?<![=<>!-])>>?\s*([^\s;&|(){}<>'"]+)/g;
  let m;
  while ((m = redir.exec(stripQuoted(cmd)))) {
    if (!isAllowedWriteTarget(m[1])) return true;
  }
  return false;
}

/* Structured view of a shell command: whether it writes source/config content,
 * and every git mutation with its explicit pathspecs + effective repo selector.
 * The plugin refines the pathless git ops (whole-index `commit`/`push`) against
 * the live index; the pure predicate below treats them conservatively. */
function classifyCommand(command) {
  const cmd = String(command || "");
  const result = { contentCode: false, gitOps: [] };
  if (!cmd) return result;
  for (const segment of cmd.split(/\r?\n|&&|\|\||;|\|/)) {
    const tokens = tokenize(segment);
    const found = gitSubcommand(tokens);
    if (found && GIT_MUTATIONS.has(found.subcommand)) {
      const paths = gitPathspecs(found.subcommand, found.args);
      result.gitOps.push({
        subcommand: found.subcommand,
        args: found.args,
        paths,
        target: found.target,
        pathless: paths.length === 0,
      });
    }
    if (!result.contentCode && contentCodeMutation(tokens, segment)) result.contentCode = true;
  }
  return result;
}

/* True when a shell command writes source/config content or git history in the
 * current checkout. A git op whose explicit pathspecs are ALL non-code (e.g.
 * `git add .agents/handoffs/F-1.md BACKLOG.md`) does NOT match — the docs
 * maintenance carve-out. A pathless op (`git commit`, `git push`) stays
 * conservatively true here; the plugin resolves it against the index. Narrow by
 * design: the board CLI, test runs, `gh`, and read-only git never match. */
function isCodeMutationCommand(command) {
  const { contentCode, gitOps } = classifyCommand(command);
  return (
    contentCode ||
    gitOps.some((op) => op.pathless || op.paths.some((p) => isCodePath(p)))
  );
}

/* The error the plugin throws to abort a code change aimed at the main
 * checkout. Names the target and the fix (isolate) so recovery is mechanical.
 * When the feature id is known, the exact command is printed — the F-291 recon
 * showed a bare error sends the agent hunting for the right invocation. */
function mainEditText(kind, target, feature) {
  const what = kind === "bash" ? "a command that mutates this checkout" : `an edit to \`${target}\``;
  const noun = kind === "bash" ? "command" : "edit";
  const cmd = feature
    ? `\`node scripts/backlog.js worktree ${feature}\``
    : "`node scripts/backlog.js worktree <id>`";
  const idNote = feature
    ? `isolate \`${feature}\` first from the main tree: ${cmd}`
    : `isolate FIRST from the main tree: ${cmd} (a human starting the worktree at a terminal adds \`--open\`)`;
  return `SESSION GUARD — blocked ${what}: this session is in the shared MAIN checkout, where code + git history are off-limits before isolation (the F-278 shape: work done on main cannot be finalized — \`finalize\` refuses on main and the branch switch is blocked while other sessions share the tree). ${idNote}, then make the change inside that worktree (set \`workdir\` to it). Only board/.agents/docs maintenance is allowed on main. The ${noun} was NOT executed.`;
}

// ------------------------------------------- tool-choice & read-hygiene guard
/* Advisory (never blocking) steering for the highest-volume avoidable habits
 * measured over the 2026-09-16 → 09-29 WSL sessions: shell file-inspection where
 * the dedicated tools exist, whole-tree output dumps, and re-reading files that
 * are already in context. Every text is CONSTANT so the tail stays byte-stable;
 * the plugin arms each notice at most once per session and clears it after the
 * next injected request (`clearOneShot`). */

/* Shell heads the dedicated Read/Grep/Glob tools cover better. Matched in
 * COMMAND POSITION only, and only when the command has no pipe/redirect (a
 * pipeline is real shell work). `sed`/`awk` are included for the ranged-read
 * shape but excluded when `-i` makes them an in-place edit — that path belongs to
 * the main-checkout classifier. */
const SHELL_INSPECT_TOOLS = new Set([
  "cat", "ls", "find", "grep", "rg", "egrep", "fgrep", "head", "tail",
  "wc", "stat", "file", "more", "less", "tree", "sed", "awk",
]);
const SHELL_WRAPPERS = new Set(["sudo", "command", "env", "nohup", "time", "exec"]);

/* The command-position program + its args in one shell segment, skipping env
 * assignments and common wrappers (`sudo cat ...`). Null when the segment is
 * empty or only wrappers. */
function commandHead(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t) || SHELL_WRAPPERS.has(basename(t))) {
      i++;
      continue;
    }
    break;
  }
  return i < tokens.length ? { head: basename(tokens[i]), args: tokens.slice(i + 1) } : null;
}

/* The inspection head (`cat`, `grep`, …) when the FIRST command of a command
 * line is a read-only shell inspection the dedicated tools cover, else null. The
 * first shell segment is what matters: `grep -rn foo lib/ 2>/dev/null` and
 * `ls -la | head` are still a shell inspection of the tree (the downstream pipe/
 * redirect is output shaping), while `git log | grep x` is not (grep is a filter,
 * not the command). A trailing redirect on the first segment is ignored. */
function inspectCommand(command) {
  const cmd = String(command || "");
  if (!cmd) return null;
  const first = cmd.split(/\r?\n|&&|\|\||;|\|/)[0];
  const found = commandHead(tokenize(first).filter((t) => !isRedirection(t)));
  if (!found || !SHELL_INSPECT_TOOLS.has(found.head)) return null;
  if ((found.head === "sed" || found.head === "awk") && found.args.some((a) => /^-i/.test(a))) return null;
  return found.head;
}

/* Rewrite a single leading `cd <path> && rest` into an explicit bash `workdir`,
 * so the tree is carried by the tool's cwd parameter instead of a shell `cd`
 * (the WSL `cd`-chaining habit — 2,981 calls / 388 sessions). Only the
 * unambiguous shape is transformed: exactly one `cd <literal-path> &&` prefix and
 * no other `cd` in the remainder. A dynamic path (`$VAR`, backticks, `-`) or an
 * explicit `workdir` already present is left untouched. */
function rerootBash(command) {
  const cmd = String(command || "");
  const m = cmd.match(/^\s*cd\s+("[^"]*"|'[^']*'|[^\s&;|]+)\s*&&\s*([\s\S]+)$/);
  if (!m) return null;
  let dir = m[1];
  if ((dir.startsWith('"') && dir.endsWith('"')) || (dir.startsWith("'") && dir.endsWith("'"))) {
    dir = dir.slice(1, -1);
  }
  const rest = m[2];
  if (!dir || dir === "-" || /[$`]/.test(dir)) return null;
  // Only a tree-anchored path is safe to lift into `workdir`: a relative `cd sub`
  // resolves against the current cwd, which the tool cannot reproduce from the
  // launch directory alone.
  if (!/^(?:~\/|\/|[A-Za-z]:[\\/]|\\\\)/.test(dir)) return null;
  if (/(^|[^A-Za-z0-9_])cd\s/.test(rest)) return null; // a second cd changes semantics
  return { workdir: dir, command: rest };
}

/* Pathological whole-tree scans that dump unbounded output. Narrow on purpose —
 * a bare `git diff`/`git status` is legitimate, so only `find` rooted at the
 * filesystem and `ls -R` are flagged. */
function dumpCommand(command) {
  for (const segment of String(command || "").split(/\r?\n|&&|\|\||;|\|/)) {
    const found = commandHead(tokenize(segment).filter((t) => !isRedirection(t)));
    if (!found) continue;
    if (found.head === "find") {
      const root = found.args.find((a) => !a.startsWith("-"));
      if (root === "/" || /^\/(?:mnt|home|usr|etc|var|opt|srv|root)(?:\/|$)/.test(root || "")) return "find";
    }
    if (found.head === "ls" && found.args.some((a) => /^-.*R/.test(a) || a === "-R")) return "ls";
  }
  return null;
}

const INSPECT_TEXT =
  "TOOL GUARD — read-only shell inspection detected. Use the dedicated tools instead of shell `cat`/`ls`/`grep`/`find`/`sed`: `Read` (targeted with `offset`/`limit`), `Grep`, and `Glob`. They honour the project `.ignore` rules, return bounded output, and keep the transcript small. Reserve the shell for real commands and pipelines.";

/* Structural escalation of INSPECT_TEXT. The 0.1.104 advisory did not move the
 * measured habit (shell file-inspection stayed ~33% of bash two weeks later), so
 * the FIRST pure inspection of each head in a primary session is BLOCKED once,
 * with the dedicated-tool instruction. The caller may opt out for the machine
 * with `AGENT_GUARD_TOOLBLOCK=0`; a downstream filter (`git log | grep`) is not a
 * pure inspection and never blocks. */
function inspectBlockText(head) {
  return `TOOL BLOCK — \`${head}\` is a read-only shell inspection the dedicated tools already cover; this one is blocked. Retry with \`Read\` (targeted \`offset\`/\`limit\`), \`Grep\`, or \`Glob\` — they honour the project \`.ignore\`, bound the output, and keep the transcript small. Use the shell only for real commands and pipelines. (Disable this block with \`AGENT_GUARD_TOOLBLOCK=0\`.)`;
}

const READ_TEXTS = Object.freeze({
  reread:
    "TOOL GUARD — you already read this file in this session. Do not re-read it whole; it is already in context. Re-read only a specific changed region with `offset`/`limit`, or use `Grep` to locate the needed lines.",
  whole:
    "TOOL GUARD — a large file was read whole. Search first (`Grep`/`Glob`), then read a targeted `offset`/`limit` range — never read a big file blind (`.agents/AGENTS.md` §5).",
  missing:
    "TOOL GUARD — that path does not exist (a guessed path). Read `.agents/memory/locations.md` (the canonical locations index) or use `Glob` for the real path before reading again — never re-hunt or guess.",
});

const DUMP_TEXT =
  "TOOL GUARD — this command scans the whole tree and dumps unbounded output (`find /`, `ls -R`). Bound it: target specific paths, use `Glob`/`git ls-files`, and keep large output out of context.";

// ------------------------------------------------------- wait/poll guard
/* Hand-rolled polling is a measured waste: the 2026-09 LibraryOS recon found 98
 * `sleep` commands + 81 `gh` polls in 30 days (rising on device-heavy days). A
 * blind `sleep N` either wastes minutes or forces another poll; `gh run watch`
 * blocks but never returns a machine summary. The harness ships a real bounded
 * waiter (`npm run wait` / the `wait` tool, and `run-detached.sh --wait` for the
 * device matrix). This advisory names it once per session. Advisory only — a
 * `sleep` inside a legitimate command pipeline is not a poll. */
const WAIT_TEXT =
  "TOOL GUARD — hand-rolled polling detected (`sleep N; grep log`, or `gh run watch`). Blocking in a loop wastes wall-clock and re-bills context per poll. Use the bounded waiter instead: the `wait` tool (or `npm run wait -- --job <record.json>` / `--ci [--commit <sha>]` / `--file <log> --grep <re>` / `--health <url>` / `--port <n>`), and `scripts/qa/mobile-e2e/run-detached.sh --wait` for a device matrix. It returns the moment the condition is met and a terminal status on timeout.";

/* A `sleep` command that is a poll: a `sleep` segment followed in the SAME
 * command by a log tail/grep or a `gh run watch|view|pr checks`. Pure. */
function pollCommand(command) {
  const cmd = stripQuoted(String(command || ""));
  if (/\bgh\s+run\s+watch\b/.test(cmd)) return "gh-watch";
  if (!/\bsleep\b/.test(cmd)) return null;
  if (/\bgh\s+(run\s+(watch|view)|pr\s+(checks|view))\b/.test(cmd)) return "gh";
  if (/\b(tail|cat|grep|rg|head|sed|awk|less|journalctl)\b/.test(cmd)) return "sleep+log";
  // A bare `sleep N` with no companion read is still a poll when it is the
  // whole first segment (wait-and-pray before re-checking by hand).
  const first = cmd.split(/\r?\n|&&|\|\||;|\|/)[0].trim();
  if (/^sleep\b/.test(first)) return "sleep";
  return null;
}

/* One-shot per session: the first poll-shaped call arms the advisory. */
function notePollCall(state, command) {
  const kind = pollCommand(command);
  if (!kind) return { poll: false, kind: null, firstFlag: false };
  if (state.waitFlagged) return { poll: true, kind, firstFlag: false };
  state.waitFlagged = true;
  state.waitPending = true;
  return { poll: true, kind, firstFlag: true };
}

/* Structural twin of notePollCall: block the FIRST poll of each kind in a
 * primary session (once), naming the bounded waiter. Same opt-out as the
 * inspection block. */
function pollBlockText(kind) {
  return `TOOL BLOCK — hand-rolled polling (\`${kind}\`) is blocked; it wastes wall-clock and re-bills context per poll. Use the bounded waiter: the \`wait\` tool (or \`npm run wait -- --job <record.json>\` / \`--ci [--commit <sha>]\` / \`--file <log> --grep <re>\` / \`--health <url>\` / \`--port <n>\`), or \`scripts/qa/mobile-e2e/run-detached.sh --wait\` for a device matrix. (Disable this block with \`AGENT_GUARD_TOOLBLOCK=0\`.)`;
}

/* Whether the structural tool blocks are enabled for this machine. */
function toolBlockEnabled(env) {
  return String((env || process.env).AGENT_GUARD_TOOLBLOCK || "") !== "0";
}

const READ_LARGE_BYTES = 20000;

/* First read of a path is silent; a second read of the SAME path in one session
 * arms the one-shot re-read nudge. `state.readSeen` is the session's read set. */
function noteReadBefore(state, filePath) {
  const p = String(filePath || "");
  if (!p) return { reread: false, firstFlag: false };
  const reread = state.readSeen.has(p);
  state.readSeen.add(p);
  if (reread && !state.readNotices.has("reread")) {
    state.readNotices.add("reread");
    state.readPending = "reread";
    return { reread: true, firstFlag: true };
  }
  return { reread, firstFlag: false };
}

/* After a read: a failed read arms the guessed-path nudge; a successful
 * whole-file read of a large file arms the whole-file nudge. Each kind fires at
 * most once per session. */
function noteReadAfter(state, args, output, largeBytes = READ_LARGE_BYTES) {
  const failed = !!output?.error || String(output?.status || "") === "error";
  if (failed) {
    if (!state.readNotices.has("missing")) {
      state.readNotices.add("missing");
      state.readPending = "missing";
      return { notice: "missing", firstFlag: true };
    }
    return { notice: null, firstFlag: false };
  }
  const ranged = args?.offset != null || args?.limit != null;
  const bytes = typeof output?.output === "string" ? output.output.length : 0;
  if (!ranged && bytes >= largeBytes && !state.readNotices.has("whole")) {
    state.readNotices.add("whole");
    state.readPending = "whole";
    return { notice: "whole", firstFlag: true };
  }
  return { notice: null, firstFlag: false };
}

/* Clear the one-shot hygiene notices after they have been injected once, so a
 * standing preference does not nag on every later request. */
function clearOneShot(state) {
  state.inspectPending = false;
  state.readPending = null;
  state.dumpPending = false;
  state.editMissPending = false;
  state.gateRerunPending = false;
  state.waitPending = false;
}

// --------------------------------------------------- inspect re-arm (D)
/* The shell-inspection advisory used to fire at most ONCE per session; the recon
 * showed shell inspection still at 31-38% of bash after it shipped, so a single
 * one-shot nudge is not enough. Re-arm it after `inspect_rearm_every` (default
 * 10) FURTHER inspections, or immediately when a DIFFERENT shell head appears
 * (`cat` -> `grep`), so a returning habit gets a fresh, specific reminder without
 * nagging on every call. The text is constant (cache-safe). */
const DEFAULT_INSPECT_REARM_EVERY = 10;

function noteInspect(state, head, rearmEvery) {
  if (!head) return { fire: false, count: state.inspectCount };
  state.inspectCount += 1;
  const every = Number.isFinite(rearmEvery) && rearmEvery > 0 ? rearmEvery : DEFAULT_INSPECT_REARM_EVERY;
  const differentHead = state.inspectLastHead != null && state.inspectLastHead !== head;
  state.inspectLastHead = head;
  const sinceFlag = state.inspectCount - state.inspectFlaggedAt;
  if (state.inspectFlaggedAt === 0 || differentHead || sinceFlag >= every) {
    state.inspectFlaggedAt = state.inspectCount;
    state.inspectPending = true;
    return { fire: true, count: state.inspectCount, differentHead };
  }
  return { fire: false, count: state.inspectCount };
}

// --------------------------------------------------- edit-miss guard (E)
/* A failed `edit`/`write`/`apply_patch` is almost always a guessed or stale
 * path (the recon measured 38 failed edits + 11 failed apply_patch, and a broken
 * `.../.virtualLibrary/...` path was observed live). One-shot advisory: check the
 * locations index / Glob, never re-hunt. Constant text. */
const EDIT_MISS_TEXT =
  "TOOL GUARD — an edit/write targeted a path that does not exist (a guessed or stale path). Check `.agents/memory/locations.md` (the canonical locations index) or use `Glob` to find the real path before editing again — never re-hunt or guess. If the file moved, locate it first, then edit the real path.";

function noteEditAfter(state, failed) {
  if (!failed) return { firstFlag: false };
  if (state.editMissFlagged) return { firstFlag: false };
  state.editMissFlagged = true;
  state.editMissPending = true;
  return { firstFlag: true };
}

// --------------------------------------------------- gate re-run guard (F)
/* Running the same gate repeatedly with no intervening edit ("edit -> gate ->
 * edit -> gate", or re-running an unchanged gate as a ritual) is a measured
 * waste (153 gate runs in two days; `tsc`/`test:quick` ~25x each). Track each
 * gate's run count; reset on a material edit. Arm when the SAME gate runs
 * `gate_rerun_turns` (default 3) times with zero edits since its previous run.
 * Constant text; one nudge per gate per session. */
const GATE_RERUN_TEXT =
  "TOOL GUARD — the same gate is being re-run with no code change in between (`tsc`/`test:quick`/`lint`). Batch a coherent set of edits, THEN run the gate once (`.agents/rules/00-operating.md` §Gate batching). A re-run is warranted only after a real edit, a new failure, an integration/rebase, or when the dispatch requires it.";

const DEFAULT_GATE_RERUN_TURNS = 3;

/* Normalize a bash command to the gate it runs, or null when it is not a gate.
 * Only the project-level gates that the recon showed repeating. Pure. */
function gateKey(command) {
  const cmd = String(command || "");
  if (/\btsc\b.*--noEmit|\bnpx\s+tsc\b/.test(cmd)) return "tsc";
  const m = cmd.match(/\bnpm\s+run\s+(test:[a-z-]+|lint[a-z:-]*|build)\b/);
  if (m) return m[1];
  if (/\beslint\b/.test(cmd)) return "eslint";
  return null;
}

/* Record a gate run. Any material edit (via `noteToolCall`) resets all counters,
 * so a gate re-run after an edit never counts. Returns { fire, key, count }. */
function noteGateRun(state, command, threshold) {
  const key = gateKey(command);
  if (!key) return { fire: false, key: null, count: 0 };
  const entry = state.gateRuns.get(key) || { count: 0, atFlag: 0 };
  entry.count += 1;
  state.gateRuns.set(key, entry);
  const t = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_GATE_RERUN_TURNS;
  const sinceFlag = entry.count - entry.atFlag;
  if (!state.gateRerunFlagged.has(key) && sinceFlag >= t) {
    state.gateRerunFlagged.add(key);
    entry.atFlag = entry.count;
    state.gateRerunPending = true;
    return { fire: true, key, count: entry.count };
  }
  return { fire: false, key, count: entry.count };
}

/* A material edit resets the gate counters: the batched edit invalidates the
 * previous gate result, so the next run is legitimate. */
function resetGateRuns(state) {
  state.gateRuns = new Map();
}

module.exports = {
  DEFAULT_TURNS,
  DEFAULT_STUCK,
  DEFAULT_REQUEST,
  BAND_TEXT,
  GUARD_PROVENANCE,
  NO_STATE_TEXT,
  FAILURE_TEXT,
  LOOP_TEXT,
  FUNDS_TEXT,
  BAND_RANK,
  REQUEST_BAND,
  fundsText,
  fundsError,
  fundsArmText,
  modelLabel,
  parseThresholds,
  turnBand,
  bandRank,
  requestBand,
  pressureBand,
  bandText,
  guardTexts,
  composeGuardText,
  requestLevel,
  requestTokensOf,
  stableStringify,
  shortHash,
  isLoopExempt,
  isMaterial,
  loopKey,
  createSessionState,
  noteAssistant,
  noteToolCall,
  noteToolResult,
  formatGuardEvent,
  branchSwitch,
  branchSwitchText,
  isCodePath,
  isCodeMutationCommand,
  classifyCommand,
  gitPathspecs,
  isAllowedWriteTarget,
  stripQuoted,
  mainEditText,
  INSPECT_TEXT,
  READ_TEXTS,
  DUMP_TEXT,
  WAIT_TEXT,
  EDIT_MISS_TEXT,
  GATE_RERUN_TEXT,
  inspectBlockText,
  pollBlockText,
  toolBlockEnabled,
  pollCommand,
  notePollCall,
  noteInspect,
  noteEditAfter,
  gateKey,
  noteGateRun,
  resetGateRuns,
  DEFAULT_INSPECT_REARM_EVERY,
  DEFAULT_GATE_RERUN_TURNS,
  READ_LARGE_BYTES,
  SHELL_INSPECT_TOOLS,
  commandHead,
  inspectCommand,
  rerootBash,
  dumpCommand,
  noteReadBefore,
  noteReadAfter,
  clearOneShot,
};
