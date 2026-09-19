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
    "CONTEXT GUARD — checkpoint warning: the orchestrator is approaching its turn/context budget (`checkpoint_warning_turn` and the request-token levels in `.agents/memory/orchestration.md`). Finish the current phase step, then write ONE compact deterministic checkpoint to `.agents/handoffs/<feature-id>.md`. Do not start a new phase in this transcript.",
  checkpoint:
    "CONTEXT GUARD — soft turn budget reached: checkpoint ONCE now — task id/feature/objective/phase, completed and active dispatches, files changed, contracts, known facts, decisions, risks, next_action — into `.agents/handoffs/<feature-id>.md`, then STOP this transcript at the current phase boundary; a fresh bounded context resumes from the checkpoint. Do not begin the next phase here, and do not write a second checkpoint in this transcript. FINALIZATION CARVE-OUT: if implementation + verification are complete and only the finalization tail remains (docs/CHANGELOG, archive, commit, ship, watch), do NOT stop — run `npm run finalize -- --feature <id>` ONCE and let it run to completion; that single call archives, commits, ships, and watches to landed + CI + UAT deploy. If a `ship`/`finalize` watch is already running, let it finish — never replace it with `--no-watch` to escape the budget, and resume a deliberate pause only with `npm run finalize -- --feature <id> --watch-only` (or `ship --watch-only`).",
  "new-context":
    "CONTEXT GUARD — strong new-context preference: do not keep growing this transcript. Checkpoint once now, then continue only in a fresh bounded context that reads the checkpoint plus the current task — never the replayed transcript. If only the finalization tail remains, run `npm run finalize -- --feature <id>` once instead of stopping — it is one call and runs to landed + deploy.",
  hard:
    "CONTEXT GUARD — hard safety ceiling reached: stop starting new work, checkpoint once, and finish. A running tool call still completes — never kill it mid-operation. FINALIZATION CARVE-OUT: if only the finalization tail remains, run `npm run finalize -- --feature <id>` once and allow it to finish — it archives, commits, ships, and watches to landed + deploy in one call. If that running step is the `ship`/`finalize` watch, allow it to finish and report the landed SHA; a stopped watch is a pending landing, resumable only with `npm run finalize -- --feature <id> --watch-only` (or `ship --watch-only`).",
});

const LOOP_TEXT =
  "CONTEXT GUARD — repeated identical tool call detected (`identical_tool_calls` in `.agents/memory/orchestration.md`). Do not repeat it again: change instructions, context, model, decomposition, or diagnostics — or report the blocker. A retry must materially change something.";

/* No-material-progress nudge. The F-256 pause showed the orchestrator writing
 * five checkpoints while warned and then stopping mid-phase; a checkpoint with
 * no code/state change is not progress. Armed when whole turns pass with no
 * file/state mutation (`no_state_change_turns`). */
const NO_STATE_TEXT =
  "CONTEXT GUARD — no material state change detected across several turns (`no_state_change_turns` in `.agents/memory/orchestration.md`). Stop re-reading or re-checkpointing and make a materially changing action: edit code, run the failing gate with NEW diagnostics, change the decomposition/model — or report the blocker. Another checkpoint with no state change is not progress.";

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

/* A tool call that MATERIALLY changes repository state (as opposed to a read,
 * grep, test run, or dispatch). Used only by the no-state-change detector: a
 * whole turn with none of these is spinning, and the recovery nudge fires. A
 * `task` dispatch counts as material — a subagent that edits files is progress
 * even though the orchestrator's own tool arguments changed nothing. */
const MATERIAL_TOOLS = new Set(["write", "edit", "patch", "multiedit", "apply_patch", "task"]);
const MATERIAL_BASH_RE =
  /(^|[^a-z])(git\s+(commit|push|apply|am|merge|rebase|cherry-pick|stash|add)\b)|\|\s*tee\b|\bsed\s+-i\b|\b(rm|mv|cp|mkdir|touch)\b|>>?\s*[^&\s]|\bnpm\s+(install|ci|i)\b/;

function isMaterial(tool, args) {
  const name = String(tool || "").toLowerCase();
  if (MATERIAL_TOOLS.has(name)) return true;
  if (name === "bash") return MATERIAL_BASH_RE.test(String(args?.command || ""));
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
    // no-state-change detector
    materialSeen: false,
    noStateTurns: 0,
    noStatePending: false,
    // same-failure detector
    lastFailureKey: null,
    consecutiveFailures: 0,
    failurePending: false,
    failureFlagged: false,
  };
}

/* Record an assistant message. `message.updated` fires repeatedly per message,
 * so dedupe by id; a new id is one orchestrator turn. Returns the transitions
 * (band + request level + no-state) for the plugin to log — never the raw
 * every-request state, so the JSONL only carries crossings.
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
  if (!id || state.assistantIds.has(id)) return out;
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

  // Request tokens/level first, then derive the combined pressure band so a
  // context-token crossing is reflected on the same turn it is observed.
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

/* The git subcommand in command position of one shell segment, or null. Env
 * assignments and the common wrappers (`sudo git ...`) are skipped; any `-C`/
 * `--git-dir`/... global option is stepped over (the guard deliberately does not
 * chase them, so a foreign-repo checkout is never mis-blocked). */
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
  while (j < tokens.length) {
    const t = tokens[j];
    if (GIT_GLOBAL_WITH_ARG.has(t)) {
      j += 2;
      continue;
    }
    if (/^--(git-dir|work-tree|namespace|exec-path)=/.test(t)) {
      j += 1;
      continue;
    }
    if (t.startsWith("-")) {
      j += 1;
      continue;
    }
    return { subcommand: t, args: tokens.slice(j + 1) };
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

module.exports = {
  DEFAULT_TURNS,
  DEFAULT_STUCK,
  DEFAULT_REQUEST,
  BAND_TEXT,
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
};
