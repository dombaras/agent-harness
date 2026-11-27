#!/usr/bin/env node
"use strict";
/*
 * orchestrator — deterministic control plane for parallel feature work (F-068).
 *
 *   node scripts/orchestrator.js plan [--json]
 *   node scripts/orchestrator.js status [--json]
 *   node scripts/orchestrator.js why <id|feature> [--json]
 *   node scripts/orchestrator.js enqueue --feature <id> --owns "glob, ..." [--contracts "..."]
 *   node scripts/orchestrator.js land [--feature <id>] [--dry-run]
 *   node scripts/orchestrator.js pause --reason funds|red-main|capacity [--detail "..."]
 *   node scripts/orchestrator.js resume
 *
 * Exit codes: 0 success/ok, 2 refused/blocked (actionable), 1 technical failure.
 * The feature flag (`enabled` in `.agents/orchestrator.json`, or
 * AGENT_HARNESS_ORCHESTRATOR=1) defaults OFF, so the queue is inert and
 * `finalize` keeps behaving exactly as before until the pilot.
 *
 * Workers enqueue; exactly one lander calls `finalize --defer-archive`, which
 * archives the board row only after CI is green.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const lib = require("./qa/orchestrator-lib");
const store = require("./qa/orchestrator-store");
const capacityLib = require("./qa/capacity-lib");

const LAND_TTL_MS = 2 * 60 * 60 * 1000;
const ENV_FLAG = "AGENT_HARNESS_ORCHESTRATOR";

function findRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 20000 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), status: r.status };
}

function readConfig(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, ".agents", "orchestrator.json"), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

function isEnabled(root, config) {
  if (process.env[ENV_FLAG] === "1") return true;
  return !!(config && config.enabled === true);
}

function featureId(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if (/^f[-_ ]?\d+$/i.test(value)) return value.toUpperCase().replace(/[_\s]/g, "-").replace(/^F-?/, "F-");
  return value.toUpperCase();
}

function handoffFor(root, id) {
  const dir = path.join(root, ".agents", "handoffs");
  try {
    const hit = fs.readdirSync(dir).find((name) => name.toUpperCase() === `${id}.MD`);
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

function qaPlanFor(root, id) {
  const p = path.join(root, ".agents", "qa-plans", `${id}.md`);
  return fs.existsSync(p) ? p : null;
}

function boardRows(root) {
  try {
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "backlog.js"), "list", "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const parsed = JSON.parse(r.stdout);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.rows)) return parsed.rows;
    return [];
  } catch {
    return [];
  }
}

function capacityContext(root, pending) {
  try {
    const sample = capacityLib.sample(root);
    const ev = capacityLib.evaluate(sample, pending ? { pendingHeavy: 1 } : {});
    return { ok: ev.ok, reasons: ev.reasons, warnings: ev.warnings, sample };
  } catch (err) {
    return { ok: true, reasons: [], warnings: [`capacity sample unavailable: ${err.message}`], sample: null };
  }
}

function lockContext(root) {
  const rec = store.readLandLock(root);
  if (!rec) return { held: false, holder: null };
  const status = store.landLockStatus(rec);
  return { held: status.live, holder: rec.holder || "unknown", feature: rec.feature || null, status };
}

function schedulerContext(root) {
  const state = store.readState(root);
  const jobs = Object.values(state.jobs);
  return {
    jobs,
    pause: state.paused,
    limits: readConfig(root).limits || {},
    capacity: capacityContext(root),
    heavyLock: lockContext(root),
    now: Date.now(),
  };
}

function print(obj, asJson) {
  if (asJson) console.log(JSON.stringify(obj, null, 2));
  else console.log(JSON.stringify(obj, null, 2));
}

function usage() {
  console.log(
    "orchestrator — resource-aware parallel feature control plane (F-068)\n\n" +
      "  plan [--json]                 dry-run: phase pipeline for board rows\n" +
      "  status [--json]               queue, lander lease, pause, capacity\n" +
      "  why <id|feature> [--json]     one reason code + sentence\n" +
      "  enqueue --feature <id> --owns \"glob, ...\" [--contracts \"...\"]\n" +
      "                                 validate + journal a ready job\n" +
      "  land [--feature <id>] [--dry-run]  single lander: finalize, CI, archive\n" +
      "  pause --reason funds|red-main|capacity [--detail \"...\"]\n" +
      "  resume\n\n" +
      "Feature flag: enabled in .agents/orchestrator.json (default off) or\n" +
      "AGENT_HARNESS_ORCHESTRATOR=1. Workers never push; only the lander lands."
  );
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--feature") args.feature = argv[++i];
    else if (a === "--owns") args.owns = argv[++i];
    else if (a === "--contracts") args.contracts = argv[++i];
    else if (a === "--depends-on") args.dependsOn = argv[++i];
    else if (a === "--phase") args.phase = argv[++i];
    else if (a === "--priority") args.priority = argv[++i];
    else if (a === "--reason") args.reason = argv[++i];
    else if (a === "--detail") args.detail = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function cmdPlan(root, args) {
  const enabled = isEnabled(root, readConfig(root));
  const rows = boardRows(root);
  const planned = lib.dryRunPlan(rows, { limit: 12 });
  if (args.json) return print({ enabled, rows: planned }, true);
  console.log(`orchestrator plan (flag ${enabled ? "ON" : "OFF"}) — ${planned.length} feature(s)\n`);
  for (const row of planned) {
    console.log(`${row.feature} (${row.priority})`);
    console.log(
      "  " +
        row.phases
          .map((p) => `${p.phase}[${p.resource}${p.parallel ? "+" : ""}]`)
          .join(" -> ")
    );
  }
  if (!planned.length) console.log("  (no non-archived board rows visible)");
  return 0;
}

function cmdStatus(root, args) {
  const cfg = readConfig(root);
  const ctx = schedulerContext(root);
  const summary = lib.statusSummary(ctx.jobs, ctx);
  const events = store.readEvents(root, 5);
  const payload = {
    enabled: isEnabled(root, cfg),
    paused: ctx.pause,
    lander: ctx.heavyLock.held ? ctx.heavyLock : null,
    counts: summary.counts,
    queue: summary.queue,
    ready: summary.ready,
    starved: summary.starved,
    capacity: {
      ok: ctx.capacity.ok,
      reasons: ctx.capacity.reasons,
      summary: ctx.capacity.sample ? capacityLib.formatSummary(ctx.capacity.sample) : null,
    },
    lastEvents: events,
  };
  print(payload, args.json);
  return 0;
}

function findJob(ctx, key) {
  if (!key) return null;
  const id = featureId(key);
  return (
    ctx.jobs.find((j) => j.id === String(key) || j.id === id) ||
    ctx.jobs.find((j) => j.feature === id) ||
    null
  );
}

function cmdWhy(root, args) {
  const key = args._[0];
  const ctx = schedulerContext(root);
  const job = findJob(ctx, key);
  if (!job) {
    const payload = { id: featureId(key), code: "not_found", sentence: `no job for ${key}` };
    print(payload, args.json);
    return 2;
  }
  const verdict = lib.blockingReason(job, ctx);
  print({ id: job.id, state: job.state, ...verdict }, args.json);
  return 0;
}

function validateEnqueue(root, id, args) {
  const failures = [];
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=normal"]);
  if (!dirty.ok) failures.push("not a git checkout");
  else if (dirty.out) failures.push(`working tree is not clean (${dirty.out.split(/\r?\n/).length} path(s))`);
  if (!git(root, ["rev-parse", "--verify", "HEAD"]).ok) failures.push("no commit on HEAD");
  if (!handoffFor(root, id)) failures.push(`missing handoff .agents/handoffs/${id}.md`);
  if (!qaPlanFor(root, id)) failures.push(`missing QA plan .agents/qa-plans/${id}.md`);
  const owned = lib
    .normalizePath(args.owns || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!owned.length) failures.push('missing owned files; pass --owns "glob, ..."');
  return { failures, owned };
}

function cmdEnqueue(root, args) {
  const cfg = readConfig(root);
  const enabled = isEnabled(root, cfg);
  const id = featureId(args.feature);
  if (!id) {
    console.error("orchestrator enqueue: --feature <id> is required.");
    return 2;
  }
  const validation = validateEnqueue(root, id, args);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  const baseSha = git(root, ["rev-parse", "--verify", "origin/main"]).out || git(root, ["rev-parse", "HEAD"]).out;
  const plan = {
    feature: id,
    phase: args.phase || "ready",
    enabled,
    branch,
    worktree: root,
    owned: validation.owned,
    contracts: lib
      .normalizePath(args.contracts || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
    dependsOn: lib
      .normalizePath(args.dependsOn || "")
      .split(",")
      .map((x) => x.trim().toUpperCase())
      .filter(Boolean),
    priority: args.priority || "P3",
    failures: validation.failures,
  };
  if (args.dryRun) {
    print({ dryRun: true, ...plan }, args.json);
    return validation.failures.length ? 2 : 0;
  }
  if (!enabled) {
    console.error("orchestrator enqueue: flag is OFF (set enabled in .agents/orchestrator.json or AGENT_HARNESS_ORCHESTRATOR=1).");
    return 2;
  }
  if (validation.failures.length) {
    for (const f of validation.failures) console.error(`  - ${f}`);
    return 2;
  }
  const { job, created } = store.createJob(
    root,
    {
      feature: id,
      phase: plan.phase,
      state: "ready",
      priority: plan.priority,
      branch,
      worktree: root,
      baseSha,
      owned: plan.owned,
      contracts: plan.contracts,
      dependsOn: plan.dependsOn,
    },
    { now: Date.now() }
  );
  print({ created, job }, args.json);
  return 0;
}

function chooseLandJob(ctx, feature) {
  const ready = lib.queueOrder(ctx.jobs.filter((j) => j.state === "ready"));
  if (feature) {
    const id = featureId(feature);
    return ready.find((j) => j.feature === id || j.id === id) || null;
  }
  return ready[0] || null;
}

function cmdLand(root, args) {
  const cfg = readConfig(root);
  const enabled = isEnabled(root, cfg);
  const ctx = schedulerContext(root);
  const job = chooseLandJob(ctx, args.feature);
  if (!job && !args.feature) {
    console.error("orchestrator land: no ready job in the journal (enqueue a feature first).");
    return 2;
  }
  if (!job) {
    console.error(`orchestrator land: no ready job for ${featureId(args.feature)}.`);
    return 2;
  }
  const reconcile = store.reconcileJob(root, job);
  if (args.dryRun) {
    print(
      {
        dryRun: true,
        enabled,
        job: { id: job.id, feature: job.feature, state: job.state, branch: job.branch, worktree: job.worktree },
        lander: lockContext(root),
        reconcile,
        command: `finalize --feature ${job.feature} --defer-archive`,
      },
      args.json
    );
    return 0;
  }
  if (!enabled) {
    console.error("orchestrator land: flag is OFF — finalize directly, or enable the orchestrator for the pilot.");
    return 2;
  }
  if (reconcile.state === "unknown_push") {
    console.error(`orchestrator land: ${reconcile.reason}`);
    return 2;
  }
  const holder = `lander-${process.pid}`;
  const lock = store.acquireLandLock(root, { holder, feature: job.feature }, { ttlMs: LAND_TTL_MS });
  if (!lock.acquired) {
    console.error(`orchestrator land: ${lock.reason}`);
    return 2;
  }
  try {
    if (reconcile.state === "landed") {
      const moved = store.transitionJob(root, job.id, "landed", { code: "reconciled", reason: "already on main" });
      if (moved.ok) store.transitionJob(root, job.id, "done", { code: "reconciled", reason: "archive after CI" });
      console.log(`orchestrator land: ${job.feature} is already on main — reconciled, no replay.`);
      return 0;
    }
    const landing = store.transitionJob(root, job.id, "landing", { code: "land", reason: `lander ${holder}` });
    if (!landing.ok) {
      console.error(`orchestrator land: ${landing.reason}`);
      return 2;
    }
    const wt = job.worktree && fs.existsSync(job.worktree) ? job.worktree : root;
    const finalize = path.join(wt, "scripts", "finalize.js");
    if (!fs.existsSync(finalize)) {
      store.transitionJob(root, job.id, "failed", { code: "missing_finalize", reason: finalize });
      console.error(`orchestrator land: ${finalize} not found.`);
      return 1;
    }
    const r = spawnSync(process.execPath, [finalize, "--feature", job.feature, "--defer-archive"], {
      cwd: wt,
      stdio: "inherit",
    });
    if (r.status === 0) {
      store.transitionJob(root, job.id, "landed", { code: "ci_green", reason: "finalize landed + CI green" });
      store.transitionJob(root, job.id, "done", { code: "archived", reason: "board row archived after CI" });
      console.log(`orchestrator land: ${job.feature} landed, CI green, archived.`);
      return 0;
    }
    store.transitionJob(root, job.id, "failed", { code: "land_failed", reason: `finalize exit ${r.status}` });
    console.error(`orchestrator land: finalize exited ${r.status}; job marked failed, row untouched.`);
    return r.status === 2 ? 2 : 1;
  } finally {
    store.releaseLandLock(root, holder);
  }
}

function cmdPause(root, args) {
  const map = { funds: "provider_funds", "red-main": "red_main", capacity: "capacity" };
  const reason = map[args.reason];
  if (!reason) {
    console.error("orchestrator pause: --reason funds|red-main|capacity");
    return 2;
  }
  const paused = store.setPause(root, reason, args.detail || null);
  print({ paused }, args.json);
  return 0;
}

function cmdResume(root, args) {
  const paused = store.setPause(root, null, null);
  print({ paused }, args.json);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._.length) {
    usage();
    return args.help ? 0 : 2;
  }
  const found = findRoot(process.cwd());
  if (!found) {
    console.error("orchestrator: no git repository found.");
    return 1;
  }
  const root = store.controlRoot(found);
  const cmd = args._.shift();
  switch (cmd) {
    case "plan":
      return cmdPlan(root, args);
    case "status":
      return cmdStatus(root, args);
    case "why":
      return cmdWhy(root, args);
    case "enqueue":
      return cmdEnqueue(root, args);
    case "land":
      return cmdLand(root, args);
    case "pause":
      return cmdPause(root, args);
    case "resume":
      return cmdResume(root, args);
    default:
      console.error(`orchestrator: unknown command "${cmd}".`);
      usage();
      return 2;
  }
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error("orchestrator: " + (err && err.message ? err.message : err));
    process.exitCode = 1;
  }
}

module.exports = { featureId, findRoot, readConfig, isEnabled, validateEnqueue, chooseLandJob };
