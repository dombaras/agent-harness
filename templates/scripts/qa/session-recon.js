#!/usr/bin/env node
"use strict";
/*
 * session-recon — tool-habit / context-hygiene recon over the local opencode
 * store. Deterministic and dependency-free (reads via `opencode db --format
 * json`, the same stable path as provider-stats.js). Complements
 * `report:cost` (cost/tokens/turns/tiers) with the habits measured in the
 * 2026-09-16 → 09-29 WSL recon: shell file-inspection where the dedicated tools
 * exist, `cd`-chaining, whole-file / repeated reads, guessed paths, whole-tree
 * dumps, hand-rolled polling, and dispatch prompt sizes.
 *
 * The same classification lives in the runtime guard (`context-guard-core.js`),
 * so the report and the nudge can never drift.
 *
 * Nothing is inferred from character counts as a cost; every count is a real
 * store row. When the store is unreachable the CLI fails loudly.
 *
 * Usage:
 *   node scripts/qa/session-recon.js [--since=14d] [--json]
 *   node scripts/qa/session-recon.js --export <file>       # write a fixture
 *   node scripts/qa/session-recon.js --fixture <file>      # read a fixture
 *   node scripts/qa/session-recon.js --root <dir> [--opencode <exe>]
 *
 * Fixture schema (stable): { schema, meta, sessions, parts, guardEvents }.
 */

const fs = require("fs");
const path = require("path");
const PS = require("./provider-stats.js");
const CG = require("./context-guard-core.js");

const SCHEMA = "session-recon/1";
const LARGE_OUTPUT_BYTES = 30000;
const EDIT_TOOLS = new Set(["edit", "write", "patch", "multiedit", "apply_patch"]);

/* Tools that count as "real work started" for the orientation-depth metric: the
 * first edit/write or dispatch marks the end of the orientation prologue. A
 * resume/claim session otherwise re-derives git/serve/capacity state by hand.
 * Both the V1 names and their V2 aliases (`task`->`subagent`) — the guard core
 * does the same, and a drift-guard test enforces it. */
const WORK_TOOLS = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
  "task",
  "subagent",
]);

// ---------------------------------------------------------------- pure core

/* Classify one bash command against the runtime guard's own predicates:
 * `inspect` = read-only shell inspection the dedicated tools cover,
 * `cdWrapped` = a leading shell `cd`, `dump` = a whole-tree output dump. */
function classifyBashCommand(command) {
  const cmd = String(command || "");
  const reroot = CG.rerootBash(cmd); // normalize a leading `cd <tree> &&` first
  const effective = reroot ? reroot.command : cmd;
  return {
    inspect: CG.inspectCommand(effective),
    cdWrapped: /^\s*cd\s/.test(cmd),
    dump: CG.dumpCommand(cmd),
    poll: CG.pollCommand(cmd),
    gate: CG.gateKey(cmd),
  };
}

function parseInput(input) {
  if (input == null) return {};
  if (typeof input === "object") return input;
  try {
    return JSON.parse(input);
  } catch (_) {
    return {};
  }
}

function dayOf(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "unknown";
  return new Date(n).toISOString().slice(0, 10);
}

/* Roll up part-level tool habits. `parts` rows: { session_id, tool, input,
 * outputLen, status, time_created }. Pure: no IO, so it is unit-testable. */
function analyzeTools(parts) {
  const tools = new Map();
  const inspect = new Map();
  const perDay = new Map();
  let bash = 0;
  let cdWrapped = 0;
  let inspectTotal = 0;
  let dumps = 0;
  let bashLarge = 0;
  let readTotal = 0;
  let readWhole = 0;
  let readLarge = 0;
  let readErrors = 0;
  let readRereads = 0;
  let taskCount = 0;
  let taskPromptBytes = 0;
  let taskPromptMax = 0;
  let ghPolling = 0;
  let sleeps = 0;
  let polls = 0;
  let editErrors = 0;
  const pollKinds = new Map();
  const gateRuns = new Map();
  const readSeen = new Map(); // session_id -> Set(filePath)

  for (const row of parts) {
    const tool = String(row.tool || "?");
    tools.set(tool, (tools.get(tool) || 0) + 1);
    const day = dayOf(row.time_created);
    if (!perDay.has(day)) perDay.set(day, { bash: 0, inspect: 0, cdWrapped: 0 });
    const d = perDay.get(day);

    if (tool === "bash" || tool === "shell") {
      bash += 1;
      d.bash += 1;
      const input = parseInput(row.input);
      const { inspect: ins, cdWrapped: cd, dump, poll, gate } = classifyBashCommand(input.command);
      if (ins) {
        inspectTotal += 1;
        d.inspect += 1;
        inspect.set(ins, (inspect.get(ins) || 0) + 1);
      }
      if (cd) {
        cdWrapped += 1;
        d.cdWrapped += 1;
      }
      if (dump) dumps += 1;
      if (poll) {
        polls += 1;
        pollKinds.set(poll, (pollKinds.get(poll) || 0) + 1);
      }
      if (gate) gateRuns.set(gate, (gateRuns.get(gate) || 0) + 1);
      if (Number(row.outputLen) >= LARGE_OUTPUT_BYTES) bashLarge += 1;
      const command = String(input.command || "");
      if (/gh\s+(run watch|run view|pr checks|pr view)\b/.test(command) || /for .*\bgh\b/.test(command)) {
        ghPolling += 1;
      }
      if (/\bsleep\b/.test(command)) sleeps += 1;
    } else if (tool === "read") {
      readTotal += 1;
      const input = parseInput(row.input);
      const ranged = input.offset != null || input.limit != null;
      if (!ranged) readWhole += 1;
      if (Number(row.outputLen) >= LARGE_OUTPUT_BYTES) readLarge += 1;
      if (String(row.status || "") === "error") readErrors += 1;
      const fp = String(input.filePath || "");
      if (fp) {
        const seen = readSeen.get(row.session_id) || new Set();
        if (seen.has(fp)) readRereads += 1;
        seen.add(fp);
        readSeen.set(row.session_id, seen);
      }
    } else if (tool === "task" || tool === "subagent") {
      taskCount += 1;
      const input = parseInput(row.input);
      const bytes = typeof input.prompt === "string" ? input.prompt.length : 0;
      taskPromptBytes += bytes;
      if (bytes > taskPromptMax) taskPromptMax = bytes;
    } else if (EDIT_TOOLS.has(tool)) {
      if (String(row.status || "") === "error") editErrors += 1;
    }
  }

  const toolList = [...tools.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  const inspectList = [...inspect.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  const perDayList = [...perDay.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const orientation = analyzeOrientation(parts);

  return {
    tools: toolList,
    bash,
    inspect: inspectList,
    inspectTotal,
    inspectShare: bash ? inspectTotal / bash : null,
    cdWrapped,
    dumps,
    bashLarge,
    editErrors,
    orientation,
    read: {
      total: readTotal,
      whole: readWhole,
      large: readLarge,
      errors: readErrors,
      rereads: readRereads,
      wholeShare: readTotal ? readWhole / readTotal : null,
    },
    editErrors,
    task: {
      count: taskCount,
      promptBytesTotal: taskPromptBytes,
      promptBytesAvg: taskCount ? Math.round(taskPromptBytes / taskCount) : 0,
      promptBytesMax: taskPromptMax,
    },
    polling: { gh: ghPolling, sleep: sleeps, poll: polls },
    pollKinds: [...pollKinds.entries()]
      .map(([mode, count]) => ({ mode, count }))
      .sort((a, b) => b.count - a.count),
    gateRuns: [...gateRuns.entries()]
      .map(([gate, count]) => ({ gate, count }))
      .sort((a, b) => b.count - a.count),
    perDay: perDayList,
  };
}

/* Orientation depth: how many tool calls a session spends BEFORE its first real
 * work (an edit/write or a dispatch). A resume/claim session that hand-derives
 * git/serve/capacity state shows a long prologue; `orient` exists to collapse it.
 * Pure: returns { sessions, avg, max, long } where `long` counts sessions with a
 * prologue of 10+ calls. */
function analyzeOrientation(parts) {
  const bySession = new Map();
  for (const row of parts) {
    const sid = row.session_id;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(row);
  }
  let total = 0;
  let n = 0;
  let max = 0;
  let long = 0;
  for (const [, rows] of bySession) {
    const sorted = rows
      .slice()
      .sort((a, b) => (Number(a.time_created) || 0) - (Number(b.time_created) || 0));
    let prologue = 0;
    let started = false;
    for (const row of sorted) {
      if (WORK_TOOLS.has(String(row.tool || ""))) {
        started = true;
        break;
      }
      prologue += 1;
    }
    if (!started) continue; // never reached real work (a pure Q&A / no-op session)
    total += prologue;
    n += 1;
    if (prologue > max) max = prologue;
    if (prologue >= 10) long += 1;
  }
  return { sessions: n, avg: n ? Math.round(total / n) : 0, max, long };
}

/* Turn/cost concentration across primary sessions (a session with no parent).
 * The 2026-09-16 → 09-29 window spent ~50% in >60-turn sessions; this makes that
 * visible without cross-referencing provider-stats. */
function analyzeTurnBands(sessions) {
  const bands = [
    { band: "<=30", test: (t) => t <= 30 },
    { band: "31-50", test: (t) => t > 30 && t <= 50 },
    { band: "51-60", test: (t) => t > 50 && t <= 60 },
    { band: "61-80", test: (t) => t > 60 && t <= 80 },
    { band: "81-100", test: (t) => t > 80 && t <= 100 },
    { band: ">100", test: (t) => t > 100 },
  ].map((b) => ({ band: b.band, sessions: 0, cost: 0, test: b.test }));
  const primaries = sessions.filter((s) => !s.parentId);
  for (const s of primaries) {
    const b = bands.find((x) => x.test(s.turns || 0));
    if (!b) continue;
    b.sessions += 1;
    b.cost += s.cost || 0;
  }
  const totalCost = primaries.reduce((a, s) => a + (s.cost || 0), 0);
  return bands.map(({ band, sessions: n, cost }) => ({
    band,
    sessions: n,
    cost,
    costShare: totalCost ? cost / totalCost : null,
  }));
}

function summarizeGuardEvents(events) {
  const kinds = new Map();
  const perDay = new Map();
  for (const e of events) {
    const kind = String(e.kind || "?");
    kinds.set(kind, (kinds.get(kind) || 0) + 1);
    const day = String(e.ts || "").slice(0, 10) || "unknown";
    if (!perDay.has(day)) perDay.set(day, new Map());
    const d = perDay.get(day);
    d.set(kind, (d.get(kind) || 0) + 1);
  }
  return {
    total: events.length,
    kinds: [...kinds.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    perDay: [...perDay.entries()].map(([date, m]) => ({ date, kinds: Object.fromEntries(m) })).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

function parseGuardEvents(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch (_) {
      /* a torn final line is ignored, not fatal */
    }
  }
  return out;
}

function analyze(stats) {
  const habits = analyzeTools(stats.parts || []);
  return {
    habits,
    turnBands: analyzeTurnBands(stats.sessions || []),
    guard: summarizeGuardEvents(stats.guardEvents || []),
  };
}

// ---------------------------------------------------------------- collect

/* Tool parts come from the SAME table generation the store resolved — on V2 they
 * are embedded in `session_message.data.content[]`, never the frozen V1 `part`
 * mirror (F-15). The flavour-aware query lives in provider-stats so the two
 * consumers cannot drift. */
function readReconPartsSql(sessionIds, flavour) {
  return PS.toolPartsSql(sessionIds, flavour);
}

function readGuardEvents(root) {
  try {
    return parseGuardEvents(fs.readFileSync(path.join(root, ".agents", "guard-events.jsonl"), "utf8"));
  } catch (_) {
    return [];
  }
}

/* Collect observed sessions + tool parts for one project root. Injectable `runDb`
 * keeps it unit-testable without a live opencode install. */
function collectRecon(opts = {}) {
  const root = opts.root ? PS.normalizeRoot(opts.root) : PS.defaultRoot();
  const opencode = opts.runDb ? opts.opencode || "opencode" : opts.opencode || PS.resolveOpencode();
  if (!opts.runDb && !opencode) {
    throw new Error("opencode CLI not found — install it, or set OPENCODE_BIN / pass --opencode <path>");
  }
  const runDb = opts.runDb || ((sql) => PS.runDbJson(opencode, sql));

  const stats = PS.collectStats({ root, since: opts.since, opencode, runDb, now: opts.now, store: opts.store });
  const ids = stats.sessions.map((s) => s.id);
  const flavour = (stats.meta && stats.meta.store && stats.meta.store.flavour) || "v1";
  const parts = ids.length ? PS.queryChunked(runDb, ids, (chunk) => readReconPartsSql(chunk, flavour)) : [];
  const guardEvents = opts.guardEvents != null ? opts.guardEvents : readGuardEvents(root);
  return { meta: { ...stats.meta, schema: SCHEMA, root }, sessions: stats.sessions, parts, guardEvents };
}

function readFixture(file) {
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!doc || doc.schema !== SCHEMA || !Array.isArray(doc.sessions) || !Array.isArray(doc.parts)) {
    throw new Error(`${file} is not a ${SCHEMA} fixture`);
  }
  return {
    meta: { ...(doc.meta || {}), schema: SCHEMA },
    sessions: doc.sessions,
    parts: doc.parts,
    guardEvents: doc.guardEvents || [],
  };
}

function writeFixture(file, stats) {
  const doc = {
    schema: SCHEMA,
    meta: stats.meta,
    sessions: stats.sessions,
    parts: stats.parts,
    guardEvents: stats.guardEvents,
  };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return path.resolve(file);
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const out = { json: false, since: null, exportFile: null, fixture: null, opencode: null, root: null, guardEvents: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--since") out.since = argv[++i];
    else if (a.startsWith("--since=")) out.since = a.slice("--since=".length);
    else if (a === "--export") out.exportFile = argv[++i];
    else if (a === "--fixture") out.fixture = argv[++i];
    else if (a === "--opencode") out.opencode = argv[++i];
    else if (a === "--root") out.root = argv[++i];
    else if (a === "--guard-events") out.guardEvents = parseGuardEvents(fs.readFileSync(argv[++i], "utf8"));
  }
  return out;
}

function pct(x) {
  return x == null ? "n/a" : (x * 100).toFixed(1) + "%";
}

function printHuman(stats, agg) {
  const { meta } = stats;
  const since = meta.since ? meta.since.arg : "all time";
  console.log(`Session recon — ${meta.root} (${since})\n`);
  const h = agg.habits;
  if (!h.bash && !h.read.total) {
    console.log(meta.note ? `No sessions: ${meta.note}` : "No tool activity in this window.");
    return;
  }
  console.log(`Tool calls: bash ${h.bash} · read ${h.read.total} · task ${h.task.count}`);
  console.log(
    `Shell file-inspection (dedicated tools cover these): ${h.inspectTotal}` +
      (h.inspectShare == null ? "" : ` (${pct(h.inspectShare)} of bash)`) +
      ` — ${h.inspect.map((i) => i.tool + " " + i.count).join(", ") || "none"}`
  );
  console.log(`\`cd\`-wrapped bash: ${h.cdWrapped} · whole-tree dumps: ${h.dumps} · bash outputs > 30KB: ${h.bashLarge}`);
  console.log(
    `Reads: whole-file ${h.read.whole}` +
      (h.read.wholeShare == null ? "" : ` (${pct(h.read.wholeShare)})`) +
      ` · > 30KB ${h.read.large} · in-session re-reads ${h.read.rereads} · failed (guessed path) ${h.read.errors}` +
      ` · failed edits ${h.editErrors}`
  );
  console.log(
    `Dispatch prompts: ${h.task.count} (avg ${h.task.promptBytesAvg} B, max ${h.task.promptBytesMax} B) · ` +
      `gh polling cmds ${h.polling.gh} · sleep cmds ${h.polling.sleep}`
  );
  console.log(
    `Hand-rolled polls (use the bounded waiter): ${h.polling.poll}` +
      (h.pollKinds.length ? ` — ${h.pollKinds.map((p) => p.mode + " " + p.count).join(", ")}` : "")
  );
  if (h.gateRuns.length) {
    console.log(`Gate runs (re-run with no edit = batch instead): ${h.gateRuns.map((g) => g.gate + " " + g.count).join(", ")}`);
  }
  if (h.orientation && h.orientation.sessions) {
    console.log(
      `Orientation prologue (calls before first edit/dispatch): avg ${h.orientation.avg}, max ${h.orientation.max}, ` +
        `${h.orientation.long} session(s) with 10+ — use \`orient\` to collapse it`
    );
  }

  console.log("\nTurn bands (primary sessions):");
  for (const b of agg.turnBands) {
    if (!b.sessions) continue;
    console.log(
      `  ${b.band.padEnd(8)} ${String(b.sessions).padStart(4)} sessions  ${PS.money(b.cost).padStart(10)}  ${pct(b.costShare).padStart(6)} of cost`
    );
  }

  if (agg.guard.total) {
    console.log(`\nGuard events: ${agg.guard.total} — ${agg.guard.kinds.map((k) => k.kind + " " + k.count).join(", ")}`);
  }
  console.log("\nAll counts are observed opencode-store rows.");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "Usage: node scripts/qa/session-recon.js [--since=14d] [--json]\n" +
        "       [--export <file>] [--fixture <file>] [--root <dir>] [--opencode <path>] [--guard-events <file>]"
    );
    return;
  }
  const stats = args.fixture
    ? readFixture(args.fixture)
    : collectRecon({ root: args.root || PS.defaultRoot(), since: args.since, opencode: args.opencode, guardEvents: args.guardEvents });
  const agg = analyze(stats);
  if (args.exportFile) {
    const file = writeFixture(args.exportFile, stats);
    console.error(`session-recon: wrote ${file}`);
  }
  if (args.json) console.log(JSON.stringify({ schema: SCHEMA, ...stats, aggregates: agg }, null, 2));
  else printHuman(stats, agg);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("session-recon: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = {
  SCHEMA,
  LARGE_OUTPUT_BYTES,
  classifyBashCommand,
  parseInput,
  dayOf,
  analyzeTools,
  analyzeTurnBands,
  analyzeOrientation,
  summarizeGuardEvents,
  parseGuardEvents,
  analyze,
  readReconPartsSql,
  readGuardEvents,
  collectRecon,
  readFixture,
  writeFixture,
  parseArgs,
};
