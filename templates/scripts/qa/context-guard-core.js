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

const REQUEST_LEVELS = ["observe", "warn", "checkpoint", "intervene"];

/* Injected text is CONSTANT per band — never interpolated with the turn count —
 * so the appended system tail stays byte-stable and cache-friendly (the guard
 * must not turn every request into a fresh cache write). */
const BAND_TEXT = Object.freeze({
  warning:
    "CONTEXT GUARD — checkpoint warning: the orchestrator is approaching its turn budget (`checkpoint_warning_turn` in `.agents/memory/orchestration.md`). Finish the current step, then write compact deterministic state to `.agents/handoffs/<feature-id>.md` before starting more work.",
  checkpoint:
    "CONTEXT GUARD — soft turn budget reached: checkpoint now — task id/feature/objective/phase, completed and active dispatches, files changed, contracts, known facts, decisions, risks, next_action — into `.agents/handoffs/<feature-id>.md`, and prefer a fresh bounded context over continuing this transcript.",
  "new-context":
    "CONTEXT GUARD — strong new-context preference: do not keep growing this transcript. Checkpoint, then continue in a fresh bounded context that reads the checkpoint plus the current task only — never the replayed transcript.",
  hard:
    "CONTEXT GUARD — hard safety ceiling reached: stop starting new work, checkpoint, and finish. A running tool call still completes — never kill it mid-operation.",
});

const LOOP_TEXT =
  "CONTEXT GUARD — repeated identical tool call detected (`identical_tool_calls` in `.agents/memory/orchestration.md`). Do not repeat it again: change instructions, context, model, decomposition, or diagnostics — or report the blocker. A retry must materially change something.";

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
  if (String(tool || "") === "bash") {
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
const EXEMPT_TOOLS = new Set(["todowrite", "question", "task", "batch", "backlog_list", "session_info"]);

const SERVE_POLL = /serve\.js\s+(list|status)\b/;

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

function bandText(band) {
  return BAND_TEXT[band] || null;
}

/* The ordered guard texts a request should carry: the highest reached turn band,
 * then the funds stop, then the loop-recovery rule. Pure, so the plugin stays a
 * thin IO layer and the composition is unit-testable. Returns [] when there is
 * nothing to say. */
function guardTexts(state, thresholds) {
  const texts = [];
  const band = turnBand(state?.turns, thresholds?.turns);
  if (band) {
    const text = bandText(band);
    if (text) texts.push(text);
  }
  if (state?.fundsPending) texts.push(state.fundsNotice || FUNDS_TEXT);
  if (state?.loopPending) texts.push(LOOP_TEXT);
  return texts;
}

/* The single block injected into the conversation TAIL (never the system prompt,
 * so the cached prefix stays byte-stable). Null when there is nothing to inject. */
function composeGuardText(state, thresholds) {
  const texts = guardTexts(state, thresholds);
  return texts.length ? texts.join("\n\n") : null;
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
  };
}

/* Record an assistant message. `message.updated` fires repeatedly per message,
 * so dedupe by id; a new id is one orchestrator turn. Returns the transitions
 * (band + request level) for the plugin to log — never the raw every-request
 * state, so the JSONL only carries crossings. */
function noteAssistant(state, message, thresholds) {
  const out = {
    newTurn: false,
    turns: state.turns,
    band: state.band,
    bandChanged: false,
    requestLevel: state.requestLevel,
    requestChanged: false,
    requestTokens: null,
  };
  const id = message?.id;
  if (!id || state.assistantIds.has(id)) return out;
  state.assistantIds.add(id);
  state.turns += 1;
  out.newTurn = true;
  out.turns = state.turns;

  const band = turnBand(state.turns, thresholds?.turns);
  if (band !== state.band) {
    state.band = band;
    out.band = band;
    out.bandChanged = true;
  }

  const tokens = requestTokensOf(message);
  if (tokens != null) state.requestTokens = tokens;
  out.requestTokens = state.requestTokens;
  const level = requestLevel(state.requestTokens, thresholds?.request);
  if (level !== state.requestLevel) {
    state.requestLevel = level;
    out.requestLevel = level;
    out.requestChanged = true;
  }
  return out;
}

/* Count identical tool+args calls cumulatively per session ("the worst sessions
 * ran the same tool 100-150x" is cumulative, not consecutive). The first breach
 * of `identical_tool_calls` is flagged once; `loopPending` stays true while the
 * identical call repeats and clears on the next materially different call, so
 * the recovery rule is injected exactly while the loop persists. */
function noteToolCall(state, tool, args, stuck) {
  const exempt = isLoopExempt(tool, args);
  if (exempt) {
    return { counted: false, count: 0, loop: false, firstFlag: false, keyHash: null };
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
  return { counted: true, count, loop, firstFlag, keyHash: shortHash(key) };
}

/* One JSON object per line — the Phase B telemetry substrate, read without a
 * sqlite dependency. `ts` leads so a plain `sort` works. */
function formatGuardEvent(event) {
  return JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n";
}

module.exports = {
  DEFAULT_TURNS,
  DEFAULT_STUCK,
  DEFAULT_REQUEST,
  BAND_TEXT,
  LOOP_TEXT,
  FUNDS_TEXT,
  fundsText,
  fundsError,
  fundsArmText,
  modelLabel,
  parseThresholds,
  turnBand,
  bandText,
  guardTexts,
  composeGuardText,
  requestLevel,
  requestTokensOf,
  stableStringify,
  shortHash,
  isLoopExempt,
  loopKey,
  createSessionState,
  noteAssistant,
  noteToolCall,
  formatGuardEvent,
};
