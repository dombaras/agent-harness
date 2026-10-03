#!/usr/bin/env node
"use strict";
/*
 * nightly — unattended full-E2E cycle for the day's landed code.
 *
 * The day loop lands features on `main` behind cheap gates; the device/Maestro
 * tier is deliberately NOT run during the day (it is slow and needs the emulator
 * + GPU). This script is the off-hours half: at ~02:00 a systemd timer runs the
 * full battery against a dedicated `nightly` worktree fast-forwarded to
 * `origin/main`, writes a machine-readable report, and reconciles the board:
 *
 *   - a journey that fails and has no row            → backlog add   [nightly:flow=<j>]
 *   - a shipped row (archived, pending validation)
 *       whose journey now passes                     → mark nightly-validated
 *       whose journey still fails (journey-level)    → backlog reopen the same row
 *   - a journey failure that already has a row       → annotate, never duplicate
 *
 * The decision core (`decideReconcile`) is pure and unit-tested; this file owns
 * only IO. Reports live under `.agents/qa-runs/nightly/<stamp>/`; the loop state
 * (reopen counts, first-seen) lives in `.agents/qa-runs/nightly/state.json`.
 *
 * Usage:
 *   node scripts/nightly.js run   [--root <dir>] [--dry-run] [--phase <name>] [--json]
 *   node scripts/nightly.js report [--root <dir>] [--json]
 *   node scripts/nightly.js status [--root <dir>]
 *
 * Config: `.agents/nightly.json` (project-owned, create-if-missing). See
 * docs/nightly-testing.md.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SCHEMA = "nightly/1";

/* Default phase battery. `gate` phases map to package.json scripts (a missing
 * script is SKIPPED, never failed — same semantics as run-gates.js). `heavy`
 * phases are run capped through `serve.js run`. `device-e2e` is the built-in
 * mobile sequence (device-up → Maestro matrix → device-down), included only when
 * the project ships the mobile-e2e tier. */
const DEFAULT_CONFIG = {
  schema: SCHEMA,
  worktree: null,
  seedCmd: null,
  waitForQuietMin: 30,
  stalePendingNights: 3,
  keepDays: 30,
  fileBacklog: true,
  notify: "",
  phases: [
    { name: "static-unit", kind: "gate", script: "test:quick", heavy: false, timeoutMin: 20 },
    { name: "api", kind: "gate", script: "test:api", heavy: false, timeoutMin: 30 },
    { name: "routes", kind: "gate", script: "test:routes", heavy: false, timeoutMin: 20 },
    { name: "web-e2e", kind: "gate", script: "test:e2e", heavy: true, timeoutMin: 30 },
    { name: "device-e2e", kind: "device-e2e", heavy: true, timeoutMin: 90 },
  ],
};

// ---------------------------------------------------------------- pure core

/* The journey a nightly row tracks, from its Task cell marker. */
function nightlyFlow(text) {
  const m = String(text || "").match(/\[nightly:flow=([A-Za-z0-9._-]+)\]/i);
  return m ? m[1] : null;
}

/* A row is validated once its note records the confirming nightly run. */
function isValidated(text) {
  return /nightly-validated/i.test(String(text || ""));
}

/* Normalize an error line into a stable-ish signature (paths/numbers elided).
 * Used for the report and for spotting a changed signature on the same journey,
 * NOT for row matching (which is journey-level). */
function normalizeSignature(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "0xn")
    .replace(/\d+/g, "n")
    .replace(/(?:\/[\w.\-]+){2,}/g, "/path")
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9 <>_:/.\-]+/g, "")
    .trim()
    .slice(0, 160);
}

function shortHash(s) {
  let h = 5381;
  const str = String(s || "");
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 8);
}

/* Resolve the configured phases against what this project actually wires.
 * Returns { phases, skipped }: missing `gate` scripts and the device phase (when
 * the tier is absent) are reported as skipped, never run. Pure. */
function resolvePhases(config, scripts, hasDeviceE2e) {
  const phases = [];
  const skipped = [];
  for (const p of (config && config.phases) || []) {
    if (!p || !p.name) continue;
    if (p.kind === "gate") {
      if (!p.script || !(p.script in (scripts || {}))) {
        skipped.push({ name: p.name, reason: `gate "${p.script || "?"}" not wired in package.json` });
        continue;
      }
      phases.push({ ...p, cmd: `npm run ${p.script}` });
    } else if (p.kind === "cmd") {
      if (!p.cmd) {
        skipped.push({ name: p.name, reason: "cmd phase has no cmd" });
        continue;
      }
      phases.push({ ...p });
    } else if (p.kind === "device-e2e") {
      if (!hasDeviceE2e) {
        skipped.push({ name: p.name, reason: "mobile-e2e tier not present" });
        continue;
      }
      phases.push({ ...p });
    } else {
      skipped.push({ name: p.name, reason: `unknown kind "${p.kind}"` });
    }
  }
  return { phases, skipped };
}

function daysBetween(a, b) {
  const t1 = Date.parse(a);
  const t2 = Date.parse(b);
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return 0;
  return Math.max(0, Math.round((t2 - t1) / 86400000));
}

/*
 * Decide the board reconciliation. Pure.
 *
 *   input.failures  [{ flow, phase, signature, reason }]  — failed journeys/phases
 *   input.exercised [flow, ...]                           — flows this run reached
 *   input.rows      [{ id, section, task, closed }]       — whole-board snapshot
 *   input.state     { flows: { <flow>: { reopenCount, firstSeen, lastSeen,
 *                                        lastSignature, validatedAt } } }
 *   input.now       ISO timestamp
 *
 * Journey-level matching: one row per failing journey, reopened until green.
 *   actions: { kind: reopen|validate|add|annotate|pending, ... }
 */
function decideReconcile(input) {
  const failures = Array.isArray(input.failures) ? input.failures : [];
  const exercised = new Set((input.exercised || []).map((f) => String(f).toLowerCase()));
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const now = input.now || new Date().toISOString();
  const staleDays = Number.isFinite(input.stalePendingDays) ? input.stalePendingDays : 3;

  const failedFlows = new Map();
  for (const f of failures) {
    if (f && f.flow) failedFlows.set(String(f.flow).toLowerCase(), f);
  }

  const byFlow = new Map();
  for (const r of rows) {
    const flow = nightlyFlow(r.task);
    if (!flow) continue;
    const k = flow.toLowerCase();
    if (!byFlow.has(k)) byFlow.set(k, []);
    byFlow.get(k).push(r);
  }

  const actions = [];
  const flows = { ...((input.state && input.state.flows) || {}) };
  const ensured = (k) => {
    if (!flows[k]) flows[k] = { reopenCount: 0, firstSeen: now, lastSeen: now };
    return flows[k];
  };

  // Direction A — archived rows awaiting validation that did NOT fail.
  for (const [k, list] of byFlow) {
    if (failedFlows.has(k)) continue; // the failure pass handles it
    for (const r of list) {
      if (r.section !== "archive" || isValidated(r.closed)) continue;
      const st = ensured(k);
      if (exercised.has(k)) {
        flows[k] = { ...st, lastSeen: now, validatedAt: now };
        actions.push({ kind: "validate", id: r.id, flow: k });
      } else {
        const stale = st.firstSeen ? daysBetween(st.firstSeen, now) >= staleDays : false;
        actions.push({ kind: "pending", id: r.id, flow: k, reason: "not exercised this run", stale });
      }
    }
  }

  // Direction B — failures.
  for (const [k, f] of failedFlows) {
    const list = byFlow.get(k) || [];
    const openish = list.find((r) => r.section !== "archive");
    if (openish) {
      actions.push({ kind: "annotate", id: openish.id, flow: k, reason: "already tracked (open)" });
      continue;
    }
    const archived = list.find((r) => r.section === "archive");
    if (archived) {
      const st = ensured(k);
      const reopenCount = (st.reopenCount || 0) + 1;
      flows[k] = { ...st, reopenCount, lastSeen: now, lastSignature: f.signature || st.lastSignature };
      actions.push({
        kind: "reopen",
        id: archived.id,
        flow: k,
        reopenCount,
        priority: reopenCount >= 2 ? "P1" : "P2",
        signature: f.signature || null,
      });
      continue;
    }
    flows[k] = { ...ensured(k), lastSeen: now, lastSignature: f.signature || null };
    actions.push({ kind: "add", flow: k, phase: f.phase || null, signature: f.signature || null, reason: f.reason || "" });
  }

  return { actions, state: { flows } };
}

// ---------------------------------------------------------------- IO helpers

function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, "BACKLOG.md"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function loadConfig(root) {
  const p = path.join(root, ".agents", "nightly.json");
  const raw = readJson(p, null);
  if (!raw) return { ...DEFAULT_CONFIG, _missing: true, _path: p };
  return { ...DEFAULT_CONFIG, ...raw, phases: Array.isArray(raw.phases) ? raw.phases : DEFAULT_CONFIG.phases, _path: p };
}

function readScripts(root) {
  const pkg = readJson(path.join(root, "package.json"), null);
  return pkg && pkg.scripts ? pkg.scripts : {};
}

function reportsDir(root) {
  return path.join(root, ".agents", "qa-runs", "nightly");
}

function latestPath(root) {
  return path.join(reportsDir(root), "latest.json");
}

function statePath(root) {
  return path.join(reportsDir(root), "state.json");
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function tail(text, lines = 15) {
  const arr = String(text || "").split(/\r?\n/).filter(Boolean);
  return arr.slice(-lines).join("\n");
}

function run(root, cmd, timeoutMs) {
  const r = spawnSync(cmd, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    code: r.status == null ? (r.signal ? 124 : 1) : r.status,
    signal: r.signal || null,
    output: (r.stdout || "") + (r.stderr || ""),
  };
}

function runNode(root, args, timeoutMs) {
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { code: r.status == null ? 1 : r.status, output: (r.stdout || "") + (r.stderr || "") };
}

function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 120000 });
  return { code: r.status == null ? 1 : r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

// ---------------------------------------------------------------- phases

function runPhase(root, phase, opts) {
  const timeoutMs = (phase.timeoutMin || 30) * 60000;
  if (phase.kind === "device-e2e") return runDeviceE2e(root, phase, opts);
  const cmd = phase.cmd;
  if (opts.dryRun) return { name: phase.name, status: "pass", dryRun: true, cmd, output: "" };
  let res;
  if (phase.heavy) {
    const args = ["scripts/serve.js", "run", "--cmd", cmd, "--name", `nightly-${phase.name}`];
    if (phase.memMax) args.push("--mem-max", phase.memMax);
    if (phase.cpuMax) args.push("--cpu-max", phase.cpuMax);
    res = runNode(root, args, timeoutMs);
  } else {
    res = run(root, cmd, timeoutMs);
  }
  return {
    name: phase.name,
    status: res.code === 0 ? "pass" : "fail",
    code: res.code,
    output: tail(res.output, 15),
  };
}

function runDeviceE2e(root, phase, opts) {
  const me = path.join("scripts", "qa", "mobile-e2e");
  const reportFile = path.join(root, ".serve", "mobile-e2e-last-run.json");
  const flows = [];
  const steps = [];
  if (opts.dryRun) {
    return { name: phase.name, status: "pass", dryRun: true, cmd: "device-e2e", output: "", flows };
  }
  const step = (label, cmd, timeoutMin) => {
    const r = run(root, cmd, (timeoutMin || phase.timeoutMin || 90) * 60000);
    steps.push({ label, code: r.code, output: tail(r.output, 8) });
    return r;
  };

  const up = step("device-up", `bash ${me}/device-up.sh`, phase.timeoutMin);
  if (up.code !== 0) {
    try {
      run(root, `bash ${me}/device-down.sh --emulator`, 120000);
    } catch (_) {
      /* best-effort teardown */
    }
    return { name: phase.name, status: "fail", code: up.code, output: tail(up.output, 20), flows, steps };
  }

  const matrix = step("matrix", `bash ${me}/run-detached.sh --flows all --reuse-session --wait`, phase.timeoutMin);
  const report = readJson(reportFile, null);
  if (report && Array.isArray(report.flows)) {
    for (const f of report.flows) {
      flows.push({ name: f.name, status: f.status, reason: f.reason || "", durationMs: f.durationMs });
    }
  }

  step("device-down", `bash ${me}/device-down.sh --emulator`, 5);
  if (fs.existsSync(path.join(root, "package.json")) && readScripts(root)["mobile-e2e:reset"]) {
    run(root, "npm run mobile-e2e:reset", 300000);
  }

  const failed = flows.filter((f) => f.status !== "pass");
  const ok = matrix.code === 0 && failed.length === 0;
  return {
    name: phase.name,
    status: ok ? "pass" : "fail",
    code: matrix.code,
    output: tail(matrix.output, 20),
    flows,
    steps,
  };
}

// ---------------------------------------------------------------- prepare

/* Fast-forward (or create) the dedicated nightly worktree to origin/main so the
 * device build compiles exactly the day's landed code, never the live tree. */
function prepareWorktree(root, config, opts) {
  if (opts.noWorktree) return { root, note: "worktree disabled (--no-worktree)" };
  const repo = path.basename(root);
  const dir = config.worktree
    ? path.resolve(root, config.worktree)
    : path.resolve(root, "..", ".worktrees", repo, "nightly");

  if (opts.dryRun) return { root: dir, note: `[dry-run] would sync worktree ${dir}` };

  const list = git(root, ["worktree", "list", "--porcelain"]);
  const exists = list.out.split(/\r?\n/).some((l) => l.startsWith("worktree ") && path.resolve(l.slice(9).trim()) === dir);

  if (!exists) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(root, ["fetch", "origin", "--quiet"]);
    const base = git(root, ["rev-parse", "--verify", "origin/main"]).code === 0 ? "origin/main" : "HEAD";
    // A leftover `nightly` branch (its worktree was removed) must be reused, not
    // recreated — `git worktree add -b nightly` fails when the branch exists.
    const hasBranch = git(root, ["rev-parse", "--verify", "nightly"]).code === 0;
    const add = hasBranch
      ? git(root, ["worktree", "add", "--no-track", dir, "nightly"])
      : git(root, ["worktree", "add", "--no-track", "-b", "nightly", dir, base]);
    if (add.code !== 0) return { root, error: `could not create nightly worktree: ${add.err || add.out}` };
    // Bootstrap the fresh checkout exactly as `backlog worktree` does (project
    // convention script): node_modules / generated client / .env / hooks. A
    // reused worktree keeps its bootstrap, so only the create path runs it.
    const setup = [path.join(dir, "scripts", "worktree-setup.js"), path.join(root, "scripts", "worktree-setup.js")].find((p) =>
      fs.existsSync(p)
    );
    if (setup) run(dir, `node ${setup} ${dir}`, 20 * 60000);
  } else {
    git(dir, ["fetch", "origin", "--quiet"]);
    if (git(dir, ["rev-parse", "--verify", "origin/main"]).code === 0) {
      git(dir, ["checkout", "nightly"]);
      const reset = git(dir, ["reset", "--hard", "origin/main"]);
      if (reset.code !== 0) return { root, error: `could not fast-forward nightly worktree: ${reset.err || reset.out}` };
    }
  }
  return { root: dir, note: `nightly worktree ${dir} @ ${git(dir, ["rev-parse", "--short", "HEAD"]).out || "?"}` };
}

/* Wait (bounded) for live human sessions to end so nightly never fights a live
 * agent for the single heavy-tier budget. Returns { quiet, waitedMin, live }. */
function waitForQuiet(root, config, opts) {
  if (opts.dryRun) return { quiet: true, waitedMin: 0, live: 0 };
  let leases = null;
  try {
    leases = require(path.join(root, "scripts", "qa", "lease-lib.js"));
  } catch (_) {
    return { quiet: true, waitedMin: 0, live: 0, note: "lease-lib unavailable — skipping quiesce check" };
  }
  const deadline = Date.now() + (config.waitForQuietMin || 0) * 60000;
  let live = 0;
  for (;;) {
    try {
      live = leases.liveLeases(root).length;
    } catch (_) {
      live = 0;
    }
    if (live === 0) return { quiet: true, waitedMin: Math.round((Date.now() - (deadline - (config.waitForQuietMin || 0) * 60000)) / 60000), live: 0 };
    if (Date.now() >= deadline) return { quiet: false, waitedMin: config.waitForQuietMin || 0, live };
    spawnSync(process.execPath, ["-e", "setTimeout(()=>{},5000)"]);
  }
}

// ---------------------------------------------------------------- reconcile

function boardRows(root) {
  const r = runNode(root, ["scripts/backlog.js", "list", "--all", "--json"], 30000);
  if (r.code !== 0) return null;
  try {
    return JSON.parse(r.output);
  } catch (_) {
    return null;
  }
}

/* Execute the reconcile actions through the canonical `backlog.js` CLI (so the
 * board transaction commits + publishes each change). Board ops run in the MAIN
 * checkout, never the disposable nightly worktree. */
function applyReconcile(boardRoot, actions, ctx) {
  const applied = [];
  const evidence = (flow) =>
    `nightly ${ctx.date} flow=${flow} sig=${ctx.signature(flow) || "?"} report=${ctx.reportRel}`;

  for (const a of actions) {
    if (a.kind === "add") {
      const task = `[nightly:flow=${a.flow}] ${a.flow} e2e failed`;
      const r = runNode(
        boardRoot,
        ["scripts/backlog.js", "add", task, "--p", "P2", "--evidence", evidence(a.flow)],
        30000
      );
      applied.push({ ...a, ok: r.code === 0, out: tail(r.output, 3) });
    } else if (a.kind === "reopen") {
      const reason = `nightly ${ctx.date}: still failing — ${a.flow}${a.signature ? ` (sig ${a.signature})` : ""} [nightly:reopen=${a.reopenCount}]`;
      const r = runNode(
        boardRoot,
        ["scripts/backlog.js", "reopen", a.id, "--reason", reason, "--p", a.priority || "P2"],
        30000
      );
      applied.push({ ...a, ok: r.code === 0, out: tail(r.output, 3) });
    } else if (a.kind === "validate") {
      const r = runNode(
        boardRoot,
        ["scripts/backlog.js", "archive", a.id, "--closed", `nightly-validated ${ctx.date} (${ctx.reportRel})`],
        30000
      );
      applied.push({ ...a, ok: r.code === 0, out: tail(r.output, 3) });
    } else {
      applied.push({ ...a, ok: true, out: "no board change" });
    }
  }
  return applied;
}

// ---------------------------------------------------------------- report

function buildFailureList(phaseResults) {
  const failures = [];
  const exercised = [];
  for (const p of phaseResults) {
    // A phase that ran without per-journey results (a gate/cmd phase) is
    // "exercised" by its own name, so a flow=<phase> row can be validated on a
    // green night. A matrix phase reports journeys instead (below).
    if ((p.status === "pass" || p.status === "fail") && !(p.flows && p.flows.length)) exercised.push(p.name);
    if (p.flows && p.flows.length) {
      for (const f of p.flows) {
        exercised.push(f.name);
        if (f.status !== "pass") {
          failures.push({ flow: f.name, phase: p.name, signature: shortHash(normalizeSignature(f.reason || f.name)), reason: f.reason || "" });
        }
      }
    } else if (p.status === "fail") {
      failures.push({ flow: p.name, phase: p.name, signature: shortHash(normalizeSignature(p.output || p.name)), reason: tail(p.output, 3) });
    }
  }
  return { failures, exercised };
}

function writeReport(root, report) {
  const dir = path.join(reportsDir(root), report.stamp);
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = path.join(dir, "report.json");
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n", "utf8");

  const lines = [];
  lines.push(`# Nightly E2E — ${report.verdict === "pass" ? "PASS" : "FAIL"} (${report.stamp})`);
  lines.push("");
  lines.push(`- target: ${report.target} @ ${report.head || "?"}`);
  lines.push(`- wall: ${(report.durationMs / 60000).toFixed(1)} min`);
  lines.push(`- phases: ${report.phases.map((p) => `${p.name}=${p.status}`).join(", ")}`);
  if (report.failures.length) {
    lines.push("");
    lines.push("## Failures");
    for (const f of report.failures) lines.push(`- **${f.flow}** (${f.phase}): ${f.reason || "see report"}`);
  }
  if (report.reconcile && report.reconcile.length) {
    lines.push("");
    lines.push("## Board reconciliation");
    for (const a of report.reconcile) lines.push(`- ${a.kind} ${a.id || a.flow}${a.flow && a.id ? ` (${a.flow})` : ""}${a.ok === false ? " — FAILED" : ""}`);
  }
  lines.push("");
  lines.push("Full report: " + path.relative(root, jsonPath));
  fs.writeFileSync(path.join(dir, "report.md"), lines.join("\n") + "\n", "utf8");
  fs.writeFileSync(latestPath(root), JSON.stringify(report, null, 2) + "\n", "utf8");
  return { jsonPath, mdPath: path.join(dir, "report.md") };
}

function pruneOldReports(root, keepDays) {
  const base = reportsDir(root);
  if (!fs.existsSync(base)) return;
  const cutoff = Date.now() - (keepDays || 30) * 86400000;
  for (const name of fs.readdirSync(base)) {
    const p = path.join(base, name);
    let st;
    try {
      st = fs.statSync(p);
    } catch (_) {
      continue;
    }
    if (st.isDirectory() && /^\d{4}-\d{2}-\d{2}T/.test(name) && st.mtimeMs < cutoff) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (_) {
        /* best-effort */
      }
    }
  }
}

// ---------------------------------------------------------------- commands

function cmdRun(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const config = loadConfig(root);
  const scripts = readScripts(root);
  const hasDeviceE2e = fs.existsSync(path.join(root, "scripts", "qa", "mobile-e2e", "device-up.sh"));
  const { phases, skipped } = resolvePhases(config, scripts, hasDeviceE2e);
  const selected = opts.phase ? phases.filter((p) => p.name === opts.phase) : phases;

  const started = Date.now();
  const runStamp = stamp();
  const phaseResults = [];
  const notes = [];

  console.log(`nightly — ${root} (${selected.length} phase(s)${opts.dryRun ? ", dry-run" : ""})`);
  if (config._missing) notes.push(`no .agents/nightly.json — using defaults (${config._path})`);

  const wt = prepareWorktree(root, config, opts);
  if (wt.error) {
    notes.push(wt.error);
  } else if (wt.note) {
    notes.push(wt.note);
  }
  const testRoot = wt.error ? root : wt.root;

  const quiet = waitForQuiet(root, config, opts);
  if (!quiet.quiet) notes.push(`still busy after ${quiet.waitedMin} min (${quiet.live} live session(s)) — proceeding`);

  if (!opts.dryRun && config.seedCmd) {
    const s = run(testRoot, config.seedCmd, 300000);
    notes.push(`seed: ${s.code === 0 ? "ok" : "FAILED"}`);
  }

  for (const phase of selected) {
    const t0 = Date.now();
    const res = runPhase(testRoot, phase, opts);
    res.ms = Date.now() - t0;
    phaseResults.push(res);
    console.log(`  ${res.status === "pass" ? "\u2713" : "\u2717"} ${res.name} (${(res.ms / 1000).toFixed(1)}s)`);
  }

  const { failures, exercised } = buildFailureList(phaseResults);
  const rows = boardRows(root) || [];
  const flatRows = [];
  for (const section of ["inprogress", "queued", "open", "archive"]) {
    const list = section === "inprogress" ? rows.inprogress : section === "archive" ? rows.archive : rows[section];
    for (const r of list || []) {
      flatRows.push({ id: r.id, section: section === "inprogress" ? "inprogress" : section, task: r.task || "", closed: r.closed || r.handoff || "" });
    }
  }

  const priorState = readJson(statePath(root), { flows: {} });
  const decision = decideReconcile({
    failures,
    exercised,
    rows: flatRows,
    state: priorState,
    stalePendingDays: config.stalePendingNights,
    now: new Date().toISOString(),
  });

  const reportRel = path.join(".agents", "qa-runs", "nightly", runStamp, "report.json");
  let reconcile = decision.actions.map((a) => ({ ...a, ok: true, out: "not executed" }));
  if (!opts.dryRun && config.fileBacklog !== false && !opts.phase) {
    const ctx = {
      date: new Date().toISOString().slice(0, 10),
      reportRel,
      signature: (flow) => {
        const f = failures.find((x) => x.flow.toLowerCase() === flow.toLowerCase());
        return f ? f.signature : "";
      },
    };
    reconcile = applyReconcile(root, decision.actions, ctx);
    fs.mkdirSync(reportsDir(root), { recursive: true });
    fs.writeFileSync(statePath(root), JSON.stringify(decision.state, null, 2) + "\n", "utf8");
  }

  const verdict = failures.length === 0 && reconcile.every((a) => a.ok !== false) ? "pass" : "fail";
  const report = {
    schema: "nightly/1",
    stamp: runStamp,
    target: testRoot,
    boardRoot: root,
    head: git(testRoot, ["rev-parse", "--short", "HEAD"]).out || null,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    verdict,
    phases: phaseResults.map((p) => ({ name: p.name, status: p.status, ms: p.ms, code: p.code || 0, output: p.output || "" })),
    skipped,
    failures,
    exercised,
    reconcile,
    notes,
  };

  if (!opts.dryRun) {
    writeReport(root, report);
    pruneOldReports(root, config.keepDays);
    if (config.notify) {
      const n = run(root, `${config.notify} ${path.join(reportsDir(root), runStamp, "report.json")}`, 30000);
      if (n.code !== 0) notes.push("notify command failed");
    }
  }

  console.log(`\nRESULT: ${verdict.toUpperCase()} — ${phaseResults.filter((p) => p.status === "pass").length}/${phaseResults.length} phases passed, ${failures.length} failure(s)`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  process.exitCode = verdict === "pass" ? 0 : 1;
}

function cmdReport(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const latest = readJson(latestPath(root), null);
  if (!latest) {
    console.log("nightly: no report yet — run `node scripts/nightly.js run`.");
    return;
  }
  if (opts.json) return console.log(JSON.stringify(latest, null, 2));
  console.log(`nightly ${latest.verdict.toUpperCase()} — ${latest.stamp} (${(latest.durationMs / 60000).toFixed(1)} min) @ ${latest.target}`);
  console.log(`  phases: ${latest.phases.map((p) => `${p.name}=${p.status}`).join(", ")}`);
  if (latest.failures.length) {
    console.log("  failures:");
    for (const f of latest.failures) console.log(`    - ${f.flow} (${f.phase}): ${(f.reason || "").split(/\r?\n/)[0]}`);
  }
  if (latest.reconcile.length) {
    console.log("  board:");
    for (const a of latest.reconcile) console.log(`    - ${a.kind} ${a.id || a.flow}${a.ok === false ? " FAILED" : ""}`);
  }
}

function cmdStatus(opts) {
  const root = path.resolve(opts.root || process.cwd());
  const latest = readJson(latestPath(root), null);
  const state = readJson(statePath(root), { flows: {} });
  const pending = [];
  const rows = boardRows(root);
  if (rows) {
    for (const r of rows.archive || []) {
      const flow = nightlyFlow(r.task);
      if (flow && !isValidated(r.closed) && !state.flows[flow.toLowerCase()]?.validatedAt) {
        pending.push({ id: r.id, flow });
      }
    }
  }
  console.log(latest ? `last nightly: ${latest.verdict.toUpperCase()} @ ${latest.stamp}` : "last nightly: none");
  console.log(`awaiting nightly validation: ${pending.length}${pending.length ? " — " + pending.map((p) => p.id).join(", ") : ""}`);
  if (opts.json) console.log(JSON.stringify({ latest, state, pending }, null, 2));
}

function parseArgs(argv) {
  const out = { cmd: "run", root: process.cwd(), dryRun: false, phase: null, json: false, noWorktree: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "run" || a === "report" || a === "status") out.cmd = a;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--json") out.json = true;
    else if (a === "--no-worktree") out.noWorktree = true;
    else if (a === "--phase") out.phase = argv[++i];
    else if (a.startsWith("--phase=")) out.phase = a.slice("--phase=".length);
    else if (a === "--root") out.root = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      "Usage: node scripts/nightly.js [run|report|status] [--root <dir>] [--dry-run]\n" +
        "       [--phase <name>] [--no-worktree] [--json]"
    );
    return;
  }
  if (opts.cmd === "report") return cmdReport(opts);
  if (opts.cmd === "status") return cmdStatus(opts);
  return cmdRun(opts);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("nightly: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = {
  SCHEMA,
  DEFAULT_CONFIG,
  nightlyFlow,
  isValidated,
  normalizeSignature,
  shortHash,
  resolvePhases,
  decideReconcile,
  loadConfig,
  buildFailureList,
  parseArgs,
};
