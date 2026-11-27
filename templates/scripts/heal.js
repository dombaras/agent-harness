#!/usr/bin/env node
"use strict";
/*
 * heal — the harness self-healing control loop (F-076).
 *
 * Phase 0 is deliberately read-only: `status`, `kpi`, and `report` answer "is
 * the harness healthy, what is red, and what is the trend" from the existing
 * signal sources. `run` ingests facts into the local KPI ledger; in observe mode
 * it never creates a repair item, never touches the board, and never writes
 * product code. The acting verbs (`plan`, `playbook`, `improve`, `watch`) exist
 * with their documented refusal until their phase lands — a loud "not yet" is
 * safer than a silent no-op.
 *
 * Usage:
 *   node scripts/heal.js status  [--json] [--root <dir>] [--heal-dir <dir>]
 *   node scripts/heal.js kpi     [--json] [--since=14d]
 *   node scripts/heal.js report  [--json] [--since=14d] [--no-write]
 *   node scripts/heal.js run     [--dry-run] [--json]
 *   node scripts/heal.js plan    [--json]
 *   node scripts/heal.js pause | resume
 *   node scripts/heal.js playbook [list]
 *   node scripts/heal.js improve | watch
 *
 * Exit: 0 handled/healthy, 1 needs work/escalation, 2 invalid/refused.
 */

const fs = require("fs");
const path = require("path");
const healLib = require("./qa/heal-lib.js");
const kpiLib = require("./qa/kpi-lib.js");
const store = require("./qa/heal-store.js");

const POLICY_REL = path.join(".agents", "heal.json");
const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-write") args.noWrite = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--version") args.version = true;
    else if (a.startsWith("--root=")) args.root = a.slice(7);
    else if (a === "--root") args.root = argv[++i];
    else if (a.startsWith("--heal-dir=")) args.healDir = a.slice(11);
    else if (a === "--heal-dir") args.healDir = argv[++i];
    else if (a.startsWith("--since=")) args.since = a.slice(8);
    else if (a === "--since") args.since = argv[++i];
    else if (a.startsWith("--")) args[a.slice(2)] = true;
    else args._.push(a);
  }
  return args;
}

function projectRoot(args) {
  return path.resolve(args.root || process.cwd());
}

function storeOpts(args) {
  return { healDir: args.healDir };
}

/* Read the project policy. No file means `mode: off` (scope §Backward
 * compatible); an invalid file refuses (exit 2) instead of guessing. */
function loadPolicy(root) {
  const file = path.join(root, POLICY_REL);
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return { policy: { ...healLib.DEFAULT_POLICY, mode: "off" }, file, exists: false };
    throw new Error(`${POLICY_REL} is not valid JSON: ${e.message}`);
  }
  return { policy: healLib.validatePolicy(doc), file, exists: true };
}

function savePolicy(root, policy) {
  const file = path.join(root, POLICY_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(policy, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
  return file;
}

function parseSince(value, fallbackDays = 14) {
  if (value == null) return fallbackDays * DAY_MS;
  const m = String(value).match(/^(\d+(?:\.\d+)?)\s*d$/i);
  if (m) return Number(m[1]) * DAY_MS;
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new Error(`invalid --since value: ${value}`);
  return Date.now() - ms > 0 ? Date.now() - ms : ms;
}

/* Current = the latest sample per KPI inside the window. Baseline = the median
 * of samples for the same KPI in the preceding window of equal length. A KPI
 * without a sample stays unobserved (null), never a fabricated pass. */
function metricsFromSamples(samples, opts = {}) {
  const now = opts.now || Date.now();
  const windowMs = opts.windowMs || 14 * DAY_MS;
  const currentStart = now - windowMs;
  const baselineStart = now - 2 * windowMs;
  const current = {};
  const baseline = {};
  const currentAt = {};
  const baselineValues = {};

  for (const s of samples || []) {
    const at = Date.parse(s.at);
    if (!Number.isFinite(at) || typeof s.value !== "number") continue;
    if (at >= currentStart && at <= now) {
      if (!(s.name in current) || at > (currentAt[s.name] || 0)) {
        current[s.name] = s.value;
        currentAt[s.name] = at;
      }
    } else if (at >= baselineStart && at < currentStart) {
      (baselineValues[s.name] ||= []).push(s.value);
    }
  }
  for (const [name, values] of Object.entries(baselineValues)) {
    baseline[name] = kpiLib.median(values);
  }
  return { current, baseline };
}

function buildReport(root, args, opts = {}) {
  const { policy } = loadPolicy(root);
  const state = store.readState(root, storeOpts(args));
  const now = opts.now || Date.now();
  const windowDays = policy.window_days || 14;
  const windowMs = parseSince(args.since, windowDays);
  const { current, baseline } = metricsFromSamples(state.samples, { now, windowMs });
  const safety = state.safety.length > 0 || healLib.safetyViolation({
    high_risk_auto_lands: Number(current.high_risk_auto_lands || 0),
    unauthorized_writes: Number(current.unauthorized_writes || 0),
  });
  const summary = kpiLib.summarize(current, baseline, {
    windowDays: Math.round(windowMs / DAY_MS),
    safetyViolation: safety,
  });
  const latest = store.readLatest(root, storeOpts(args));
  const trend = latest && latest.hhi != null && summary.hhi != null
    ? Math.round((summary.hhi - latest.hhi) * 100) / 100
    : null;
  return {
    schema: "heal-report/1",
    generated_at: new Date(now).toISOString(),
    mode: policy.mode,
    kill_switch: policy.kill_switch === true,
    window_days: Math.round(windowMs / DAY_MS),
    sample_count: (state.samples || []).length,
    safety_violation: safety,
    hhi: summary.hhi,
    trend,
    subscores: summary.subscores,
    rows: summary.rows,
    top_driver: summary.top_driver,
    unobserved: summary.observed === 0,
    items: {
      open: state.items.filter((it) => !["closed", "quarantined"].includes(it.state)).length,
      total: state.items.length,
    },
  };
}

function formatNumber(row) {
  if (row.value == null) return "—";
  if (row.unit === "ratio") return `${Math.round(row.value * 1000) / 10}%`;
  if (row.unit === "usd") return `$${Math.round(row.value * 100) / 100}`;
  return String(Math.round(row.value * 100) / 100);
}

function reportMarkdown(report) {
  const lines = [];
  lines.push(`# Harness health report — ${report.generated_at.slice(0, 10)}`);
  lines.push("");
  lines.push(`Mode: \`${report.mode}\`${report.kill_switch ? " · **KILL SWITCH**" : ""}`);
  lines.push("");
  lines.push(report.hhi == null
    ? "HHI: **unobserved** (no baseline samples yet — run `heal run` daily)."
    : `HHI: **${report.hhi}**${report.trend != null ? ` (${report.trend >= 0 ? "+" : ""}${report.trend} vs last report)` : ""}${report.safety_violation ? " · **0 due to a safety violation**" : ""}`);
  lines.push("");
  if (report.top_driver) {
    const d = report.top_driver;
    lines.push(`Top burn driver: **${d.label}** — ${formatNumber({ ...d, direction: "down", unit: "ratio" })} vs target ${d.target}${d.infinite ? " (infinite burn)" : ` (burn ${d.burn}×)`}.`);
  } else {
    lines.push("Top burn driver: none observed.");
  }
  lines.push("");
  lines.push("| KPI | current | baseline | target | Δ |");
  lines.push("|---|---|---|---|---|");
  for (const row of report.rows.filter((r) => r.value != null || r.baseline != null)) {
    const delta = row.delta == null ? "—" : `${row.delta >= 0 ? "+" : ""}${row.delta}`;
    lines.push(`| ${row.label} | ${formatNumber(row)} | ${row.baseline == null ? "—" : row.baseline} | ${row.target == null ? "—" : row.target} | ${delta} |`);
  }
  if (!report.rows.some((r) => r.value != null || r.baseline != null)) lines.push("| _no samples yet_ | — | — | — | — |");
  lines.push("");
  lines.push(`Observed ${report.rows.filter((r) => r.value != null).length}/${report.rows.length} catalog KPIs · ${report.items.open} open signal(s).`);
  return lines.join("\n");
}

function jsonOnly(args, value) {
  if (args.json) process.stdout.write(JSON.stringify(value, null, 2) + "\n");
  else process.stdout.write(value + "\n");
}

/* ------------------------------------------------------------- ingestion */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function nightlySamples(root) {
  const latest = readJson(path.join(root, ".agents", "qa-runs", "nightly", "latest.json"));
  if (!latest) return [];
  const at = latest.stamp || latest.generated_at || latest.at;
  const out = [];
  if (latest.ok === true || latest.ok === false) {
    out.push({ at, source: "nightly", name: "nightly_pass", value: latest.ok ? 1 : 0, unit: "ratio" });
  }
  const journeys = Array.isArray(latest.journeys) ? latest.journeys : Array.isArray(latest.phases) ? latest.phases : [];
  for (const j of journeys) {
    if (j && typeof j.ok === "boolean" && j.name) {
      out.push({ at, source: "nightly", name: "nightly_journey_pass", value: j.ok ? 1 : 0, unit: "ratio", ok: j.ok });
    }
  }
  return out.filter((s) => s.at);
}

function feedbackSamples(root) {
  const file = path.join(root, ".agents", "qa-runs", "feedback", "ledger.jsonl");
  const { events } = store.readJsonl(file);
  if (!events.length) return [];
  const out = [];
  let failures = 0;
  let flakes = 0;
  for (const e of events) {
    const item = e.item || e;
    if (!item || !item.class) continue;
    if (item.class === "flake") flakes += 1;
    if (e.type === "item" || item.signature) failures += 1;
    if (e.type === "safety" || item.class === "security") {
      out.push({ at: e.at, source: "feedback", name: "security_signals", value: 1, unit: "count" });
    }
  }
  if (failures) out.push({ at: new Date().toISOString(), source: "feedback", name: "flake_rate", value: flakes / failures, unit: "ratio" });
  return out;
}

function gatesSamples(root) {
  const file = path.join(root, ".agents", "qa-runs", "gates", "ledger.jsonl");
  const { events } = store.readJsonl(file);
  const out = [];
  for (const e of events) {
    if (!e || !e.phase || !e.result) continue;
    out.push({ at: e.at, source: "gate", name: "gate_pass_rate", value: e.result === "pass" ? 1 : 0, unit: "ratio" });
  }
  return out;
}

function doctorSamples(root) {
  const file = path.join(root, ".agents", "qa-runs", "doctor", "latest.json");
  const latest = readJson(file);
  if (!latest) return [];
  const at = latest.at || latest.generated_at;
  const out = [];
  if (typeof latest.ok === "boolean") out.push({ at, source: "doctor", name: "doctor_pass_rate", value: latest.ok ? 1 : 0, unit: "ratio" });
  if (typeof latest.drift === "number") out.push({ at, source: "doctor", name: "drift_count", value: latest.drift, unit: "count" });
  return out.filter((s) => s.at);
}

function ingest(root, args) {
  const samples = [...nightlySamples(root), ...feedbackSamples(root), ...gatesSamples(root), ...doctorSamples(root)];
  const written = [];
  if (!args.dryRun) {
    for (const sample of samples) {
      try {
        store.recordSample(root, sample, storeOpts(args));
        written.push(sample);
      } catch (_) {
        /* one malformed source fact never blocks the pass */
      }
    }
    if (!args.noWrite) store.refreshState(root, storeOpts(args));
  }
  return { samples, written };
}

/* ------------------------------------------------------------- commands */

function cmdStatus(root, args) {
  const { policy, exists } = loadPolicy(root);
  const state = store.readState(root, storeOpts(args));
  const latest = store.readLatest(root, storeOpts(args));
  const report = latest ? store.readJson(path.join(store.storePaths(root, storeOpts(args)).dir, latest.report), null) : null;
  let status;
  try {
    status = healLib.statusSummary(state, policy, { report, at: new Date().toISOString() });
  } catch (e) {
    return { code: 2, out: `heal status refused: ${e.message}` };
  }
  const line = healLib.statusLine(status);
  if (args.json) return { code: status.healthy === false ? 1 : 0, out: JSON.stringify({ ...status, policy_exists: exists, line }, null, 2) };
  const lines = [line];
  if (!exists) lines.push("  (no .agents/heal.json — loop is off; run `heal resume` or add a policy to observe)");
  if (status.red.length) lines.push(`  red: ${status.red.map((r) => `${r.source}:${r.title} [${r.tier}]`).join("; ")}`);
  if (status.blocked_items.length) lines.push(`  blocked: ${status.blocked_items.map((b) => `${b.title} (${b.reason})`).join("; ")}`);
  return { code: status.healthy === false ? 1 : 0, out: lines.join("\n") };
}

function cmdKpi(root, args) {
  const report = buildReport(root, args);
  if (args.json) return { code: report.unobserved ? 1 : 0, out: JSON.stringify(report, null, 2) };
  const lines = [`heal kpi — ${report.window_days}d window${report.unobserved ? " (no samples yet)" : ""}`];
  for (const row of report.rows.filter((r) => r.value != null || r.baseline != null)) {
    lines.push(`  ${row.id.padEnd(26)} ${formatNumber(row).padStart(8)}  target ${row.target == null ? "—" : row.target}  Δ ${row.delta == null ? "—" : row.delta}`);
  }
  if (report.unobserved) lines.push("  run `heal run` against a repo with nightly/gate/doctor artifacts to collect a baseline.");
  return { code: report.unobserved ? 1 : 0, out: lines.join("\n") };
}

function cmdReport(root, args) {
  const report = buildReport(root, args);
  report.markdown = reportMarkdown(report);
  let written = null;
  if (!args.noWrite) {
    written = store.writeReport(root, report, storeOpts(args));
    if (!args.json) {
      // eslint-disable-next-line no-console
      console.error(`report: ${written.jsonPath}`);
    }
  }
  if (args.json) return { code: 0, out: JSON.stringify({ ...report, written: written ? { json: written.jsonPath, markdown: written.mdPath } : null }, null, 2) };
  return { code: 0, out: report.markdown };
}

function cmdRun(root, args) {
  const { policy } = loadPolicy(root);
  const ingestResult = ingest(root, args);
  const state = store.readState(root, storeOpts(args));
  const pruned = args.dryRun ? null : store.prune(root, policy, storeOpts(args));
  const report = buildReport(root, { ...args, since: args.since });
  const out = {
    schema: "heal-run-pass/1",
    mode: policy.mode,
    dry_run: args.dryRun === true,
    samples_seen: ingestResult.samples.length,
    samples_written: ingestResult.written.length,
    items_open: state.items.filter((it) => !["closed", "quarantined"].includes(it.state)).length,
    pruned,
    hhi: report.hhi,
    top_driver: report.top_driver,
    repair: "disabled in phase 0 (observe only)",
  };
  if (args.json) return { code: 0, out: JSON.stringify(out, null, 2) };
  return {
    code: 0,
    out: [
      `heal run — ${policy.mode}${args.dryRun ? " (dry-run)" : ""}`,
      `  samples: ${out.samples_written}/${out.samples_seen} written`,
      `  open signals: ${out.items_open}`,
      `  HHI: ${out.hhi == null ? "unobserved" : out.hhi}${out.top_driver ? ` · top driver: ${out.top_driver.label} (${out.top_driver.infinite ? "∞" : out.top_driver.burn + "×"})` : ""}`,
      "  repair: disabled in phase 0 (observe only)",
    ].join("\n"),
  };
}

function cmdPlan(root, args) {
  const { policy } = loadPolicy(root);
  const state = store.readState(root, storeOpts(args));
  const open = state.items.filter((it) => !["closed", "quarantined"].includes(it.state));
  const plan = open.map((item) => {
    const action = healLib.selectAction(item, policy);
    const decision = healLib.eligible(item, policy, state, Date.now());
    return { id: item.id, tier: item.tier, state: item.state, action: action.action, eligible: decision.ok, reason: decision.ok ? action.reason : decision.reason };
  });
  if (args.json) return { code: plan.length ? 1 : 0, out: JSON.stringify({ schema: "heal-plan/1", mode: policy.mode, items: plan }, null, 2) };
  if (!plan.length) return { code: 0, out: "heal plan — no open signals" };
  return {
    code: 1,
    out: ["heal plan", ...plan.map((p) => `  ${p.id} [${p.tier}] ${p.action} — ${p.eligible ? p.reason : `blocked: ${p.reason}`}`)].join("\n"),
  };
}

function setKillSwitch(root, args, value) {
  const loaded = loadPolicy(root);
  const policy = { ...loaded.policy, kill_switch: value };
  const file = savePolicy(root, policy);
  store.appendAudit(root, { kind: value ? "pause" : "resume", actor: "cli", policy: file }, storeOpts(args));
  return { code: 0, out: `heal ${value ? "paused" : "resumed"} — kill_switch=${value} (${file})` };
}

function cmdPlaybook(root, args) {
  const dir = path.join(root, ".agents", "playbooks");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (_) {
    files = [];
  }
  if (args.json) return { code: 0, out: JSON.stringify({ schema: "heal-playbooks/1", dir, files }, null, 2) };
  return { code: 0, out: files.length ? files.map((f) => path.join(dir, f)).join("\n") : `heal playbook — none (${dir})` };
}

function help() {
  return [
    "heal — harness self-healing loop (F-076)",
    "",
    "Usage: node scripts/heal.js <command> [flags]",
    "",
    "Commands:",
    "  status     one bounded health answer (read-only)",
    "  kpi        KPI rows vs a 14-day baseline (read-only)",
    "  report     write a local KPI report under .agents/qa-runs/heal/reports/",
    "  run        one ingestion pass; observe mode never repairs",
    "  plan       show the selected action per open signal (no action taken)",
    "  pause      engage the kill switch",
    "  resume     release the kill switch",
    "  playbook   list .agents/playbooks/*.md",
    "",
    "Not yet implemented (documented refusal): improve (phase 4), watch (phase 1).",
    "Flags: --json --dry-run --no-write --root <dir> --heal-dir <dir> --since=14d",
    "Exit: 0 handled/healthy, 1 needs work, 2 invalid/refused.",
  ].join("\n");
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.version) return { code: 0, out: "heal 0.1.0 (phase 0)" };
  if (args.help || !args._.length) return { code: args._.length ? 0 : 2, out: help() };
  const command = args._[0];
  const root = projectRoot(args);
  try {
    switch (command) {
      case "status": return cmdStatus(root, args);
      case "kpi": return cmdKpi(root, args);
      case "report": return cmdReport(root, args);
      case "run": return cmdRun(root, args);
      case "plan": return cmdPlan(root, args);
      case "pause": return setKillSwitch(root, args, true);
      case "resume": return setKillSwitch(root, args, false);
      case "playbook": return cmdPlaybook(root, args);
      case "improve": return { code: 2, out: "heal improve — not implemented (phase 4: eval-backed improvement proposal)" };
      case "watch": return { code: 2, out: "heal watch — not implemented (phase 1: resident detect & route)" };
      default: return { code: 2, out: `unknown command: ${command}\n\n${help()}` };
    }
  } catch (e) {
    if (e.code === "EHEALPOLICY") return { code: 2, out: `heal refused: ${e.message}` };
    return { code: 2, out: `heal refused: ${e.message}` };
  }
}

if (require.main === module) {
  const result = main();
  if (result.out) process.stdout.write(result.out + (result.out.endsWith("\n") ? "" : "\n"));
  process.exit(result.code);
}

module.exports = { main, parseArgs, loadPolicy, buildReport, metricsFromSamples, reportMarkdown, ingest };
