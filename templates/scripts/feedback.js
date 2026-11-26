#!/usr/bin/env node
"use strict";
/*
 * feedback — the operator/agent CLI for the feedback loop (F-050).
 *
 * Phase 0 is the deterministic contract: capture/normalize/dedupe/classify/route
 * an offline signal, list/show/classify it, enforce the attempt budgets and the
 * state machine, and report the inbox. Live `gh`/UAT adapters and autonomous
 * landing arrive in later phases; every command here is safe to run offline.
 *
 * Ledger: local machine state under the MAIN checkout (shared by every worktree
 * through the git common dir): `.agents/qa-runs/feedback/`, one JSON item per
 * signature plus `audit.jsonl`. The board row remains the durable summary.
 *
 * Exit contract: 0 handled/benign, 1 needs work/escalation, 2 invalid
 * invocation or policy refusal. `--json` is stable for automation.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const lib = require("./qa/feedback-lib.js");
const adapters = require("./qa/feedback-adapters.js");
const triage = require("./qa/ci-triage.js");

const BOOLEAN = new Set(["json", "start", "end", "help", "once", "open"]);
const USAGE = `Usage: node scripts/feedback.js <command> [flags]

  add --source ci|nightly|uat|gate|human --title "..." [--error "..."]
      [--test ...] [--repro ...] [--paths a,b] [--severity P1..P4]
      [--evidence-file <path>] [--sha ...] [--run ...] [--url ...]
  ingest --report <file.json> [--source <source>] [--no-board]
  ingest --source ci|uat [--run <id> | --sha <sha>] [--limit N]
         [--runs-json <file>] [--jobs-json <file>] [--no-board]
  list [--state <state>] [--json]
  show <id> [--json]
  classify <id> [--json]
  next [--json]
  attempt <id> --start --strategy "..." [--feature F-1] | --end --outcome pass|fail-same|fail-different|blocked
  verify <id> --signal ci|nightly|uat-health|gate --result pass|fail [--evidence ...]
  resolve <id> --evidence "..."
  escalate <id> --reason "..."
  report [--since 14d] [--json]
  policy [--json]
  watch [--once] [--interval 5m] [--max-polls N] [--source ci|uat] [--json]
`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (eq !== -1) out.flags[key] = a.slice(eq + 1);
    else if (BOOLEAN.has(key)) out.flags[key] = true;
    else out.flags[key] = argv[++i];
  }
  return out;
}

function projectRoot(flags) {
  return path.resolve(flags.root || process.cwd());
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? String(r.stdout || "").trim() : null;
}

/* The main checkout that owns the shared git dir: the board and the ledger both
 * live there, never in a disposable feature worktree. */
function mainCheckout(root) {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) {
    const clean = common.replace(/[\\/]+$/, "");
    return path.basename(clean) === ".git" ? path.dirname(clean) : clean;
  }
  return git(root, ["rev-parse", "--show-toplevel"]) || root;
}

/* One ledger for every worktree: resolve the shared git common dir, then the
 * main checkout that owns it. `--ledger` and AGENT_HARNESS_FEEDBACK_DIR are
 * test/operator overrides and never change classification or policy. */
function ledgerDir(root, flags) {
  if (flags.ledger) return path.resolve(flags.ledger);
  if (process.env.AGENT_HARNESS_FEEDBACK_DIR) return path.resolve(process.env.AGENT_HARNESS_FEEDBACK_DIR);
  return path.join(mainCheckout(root), ".agents", "qa-runs", "feedback");
}

function tailText(text, lines = 3) {
  return String(text || "").trim().split("\n").slice(-lines).join(" ");
}

function readJsonFile(file, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(String(file)), "utf8"));
  } catch (e) {
    throw new Error(`${label}: ${e.message}`);
  }
}

/* Board rows for dedupe. The CLI is the canonical board writer (ADR 0001), so it
 * runs from this harness copy against the MAIN checkout; an explicit --root
 * pins the legacy file backend for tests and never reaches the shared service. */
function boardRows(root) {
  const script = path.join(__dirname, "backlog.js");
  if (!fs.existsSync(script)) return { ok: false, rows: [], error: "scripts/backlog.js not found" };
  const r = spawnSync(process.execPath, [script, "list", "--all", "--json", "--root", root], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20000,
  });
  if (r.status !== 0) return { ok: false, rows: [], error: tailText(r.stderr) || `exit ${r.status}` };
  try {
    const doc = JSON.parse(r.stdout || "[]");
    // `list --all --json` returns the board as sections; the planner wants one
    // flat row list (id/section/task) exactly like nightly's reconcile snapshot.
    if (Array.isArray(doc)) return { ok: true, rows: doc, error: null };
    const rows = [];
    for (const section of ["inprogress", "queued", "open", "frozen", "archive"]) {
      for (const row of doc[section] || []) {
        rows.push({ id: row.id, section, task: row.task || "", closed: row.closed || row.handoff || "" });
      }
    }
    return { ok: true, rows, error: null };
  } catch (e) {
    return { ok: false, rows: [], error: `unreadable board: ${e.message}` };
  }
}

/* Project one captured batch onto the board: one row per active signature. A
 * board failure is reported, never allowed to mask the captured signal. */
function applyBoard(results, ctx, flags) {
  if (flags["no-board"]) return [];
  const root = ctx.boardRoot;
  const script = path.join(__dirname, "backlog.js");
  const snapshot = boardRows(root);
  if (!snapshot.ok) {
    console.warn(`feedback: board unavailable (${snapshot.error}) — the ledger still holds the item(s)`);
    return [];
  }
  const rows = snapshot.rows;
  const applied = [];
  for (const result of results) {
    if (!result || !result.enabled || !result.item) continue;
    const item = result.item;
    const decision = adapters.boardActionFor(item, rows);
    if (decision.action === "link" || decision.action === "none") {
      applied.push({ ...decision, item: item.id });
      continue;
    }
    const args =
      decision.action === "add"
        ? ["add", decision.task, "--p", decision.priority, "--evidence", decision.evidence]
        : ["reopen", decision.id, "--reason", decision.reason, "--p", decision.priority || "P1"];
    const r = spawnSync(process.execPath, [script, ...args, "--root", root], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    const ok = r.status === 0;
    const out = ok ? tailText(r.stdout, 2) : tailText(r.stderr, 3) || `exit ${r.status}`;
    applied.push({ ...decision, ok, out, item: item.id });
    if (ok && decision.action === "add") {
      const id = (/(F-\d+)/.exec(out) || [])[1];
      if (id) rows.push({ id, section: "open", task: decision.task });
    }
  }
  return applied;
}

/* Live run reader for the CI/UAT adapters. The offline seams (--runs-json /
 * --jobs-json) use the exact `ci-triage` row shape, so the mapping is tested
 * without a network or a GitHub account. */
function loadCiRows(flags, root) {
  if (flags["runs-json"]) {
    const doc = readJsonFile(flags["runs-json"], "ingest --runs-json");
    const runs = Array.isArray(doc) ? doc : doc.runs || [];
    const jobs = flags["jobs-json"] ? readJsonFile(flags["jobs-json"], "ingest --jobs-json") : {};
    let rows = triage.triageRuns(runs, jobs);
    if (flags.sha) rows = rows.filter((r) => String(r.sha || "").startsWith(String(flags.sha)));
    return rows;
  }
  if (flags.run) {
    const got = triage.fetchJobs(root, flags.run);
    if (!got.ok) throw new Error(`ingest: could not read run ${flags.run} (${got.error})`);
    const run = { databaseId: flags.run, name: flags.workflow || null, conclusion: "failure" };
    return [triage.triageRun(run, got.jobs)];
  }
  const got = triage.fetchRuns(root, Number(flags.limit) || 10, flags.workflow);
  if (!got.ok) throw new Error(`ingest: could not read CI runs (${got.error})`);
  let rows = triage.triageRuns(got.runs, {});
  if (flags.sha) rows = rows.filter((r) => String(r.sha || "").startsWith(String(flags.sha)));
  return rows;
}


function loadPolicy(root) {
  const file = path.join(root, ".agents", "feedback.json");
  if (!fs.existsSync(file)) return lib.defaultPolicy();
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`.agents/feedback.json is not valid JSON: ${e.message}`);
  }
  const checked = lib.validatePolicy(doc);
  if (!checked.ok) throw new Error(`invalid feedback policy: ${checked.errors.join("; ")}`);
  return checked.policy;
}

function readItems(dir) {
  if (!fs.existsSync(dir)) return [];
  const items = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".json")) continue;
    try {
      const item = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      if (item && item.schema === lib.SCHEMA) items.push(item);
    } catch (e) {
      throw new Error(`unreadable feedback ledger item ${file}: ${e.message}`);
    }
  }
  return items;
}

function writeItem(dir, item) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${item.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(item, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function audit(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, "audit.jsonl"), JSON.stringify(entry) + "\n");
}

function nowIso() {
  return new Date().toISOString();
}

function historyFor(item, policy) {
  const at = item.last_seen;
  return [
    { at, by: "feedback", to: "normalized", reason: "ingest + sanitize" },
    { at, by: "feedback", to: "deduped", reason: "no duplicate signature" },
    { at, by: "feedback", to: "classified", reason: `${item.class}/${item.risk}: ${item.classification_reason}` },
    { at, by: "feedback", to: "routed", reason: `route=${item.route} mode=${policy.mode}` },
    { at, by: "feedback", to: item.state, reason: item.next_action },
  ];
}

function capture(signal, ctx) {
  const { dir, policy } = ctx;
  if (!lib.loopEnabled(policy, process.env)) {
    return { enabled: false, item: null, duplicate: false };
  }
  const normalized = lib.normalizeSignal(signal, { now: ctx.now });
  const items = readItems(dir);
  const duplicate = lib.findDuplicate(items, normalized);
  if (duplicate) {
    const merged = lib.mergeObservation(duplicate, normalized);
    writeItem(dir, merged);
    audit(dir, {
      at: normalized.last_seen,
      actor: "feedback",
      action: "observation",
      item_id: merged.id,
      signature: merged.signature,
      policy: { mode: policy.mode },
      evidence_hash: normalized.evidence[0] ? normalized.evidence[0].sha256 : null,
    });
    return { enabled: true, item: merged, duplicate: true };
  }
  let item = lib.applyClassification(normalized, policy);
  let id = normalized.id;
  if (items.some((i) => i.id === id && i.signature !== normalized.signature)) {
    id = `fb-${normalized.source}-${normalized.signature}`;
  }
  item = { ...item, id, history: historyFor(item, policy) };
  writeItem(dir, item);
  audit(dir, {
    at: item.last_seen,
    actor: "feedback",
    action: "capture",
    item_id: item.id,
    signature: item.signature,
    policy: { mode: policy.mode, route: item.route, class: item.class, risk: item.risk },
    evidence_hash: item.evidence[0] ? item.evidence[0].sha256 : null,
  });
  return { enabled: true, item, duplicate: false };
}

function printItem(item) {
  console.log(
    `${item.id}  ${item.severity}  ${item.class}/${item.risk}  ${item.state}  [${item.source}] ${item.title} (${item.occurrences}x)`
  );
  if (item.route) console.log(`  route: ${item.route}`);
  if (item.next_action) console.log(`  next: ${item.next_action}`);
  if (item.evidence && item.evidence[0] && item.evidence[0].pointer) console.log(`  evidence: ${item.evidence[0].pointer}`);
}

function idMatch(items, id) {
  const exact = items.find((i) => i.id === id);
  if (exact) return exact;
  const hits = items.filter((i) => i.id.startsWith(id));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new Error(`ambiguous feedback id prefix "${id}": ${hits.map((i) => i.id).join(", ")}`);
  throw new Error(`no feedback item matches "${id}"`);
}

function need(flags, key, command) {
  if (!flags[key]) throw new Error(`${command}: --${key} is required`);
  return String(flags[key]);
}

function targetId(flags, command) {
  const id = flags.id || flags._[1];
  if (!id) throw new Error(`${command}: missing <id>`);
  return String(id);
}

function cmdAdd(flags, ctx) {
  const signal = {
    source: need(flags, "source", "add"),
    title: flags.title,
    environment: flags.environment,
    kind: flags.kind,
    error: flags.error,
    test: flags.test,
    journey: flags.journey,
    workflow: flags.workflow,
    job: flags.job,
    repro: flags.repro,
    sha: flags.sha,
    run: flags.run,
    url: flags.url,
    paths: flags.paths ? String(flags.paths).split(",").map((p) => p.trim()).filter(Boolean) : [],
    severity: flags.severity,
    verdict: flags.verdict,
    side: flags.side,
    rerun: flags.rerun,
    category: flags.category,
    http_status: flags["http-status"],
    evidence_pointer: flags.evidence,
  };
  if (flags["evidence-file"]) {
    const file = path.resolve(String(flags["evidence-file"]));
    signal.log = fs.readFileSync(file, "utf8").slice(0, 20000);
    signal.evidence_pointer = signal.evidence_pointer || file;
  }
  const outcome = capture(signal, ctx);
  if (flags.json) {
    console.log(JSON.stringify({ schema: "feedback-cli/1", command: "add", enabled: outcome.enabled, duplicate: outcome.duplicate, item: outcome.item }, null, 2));
  } else if (!outcome.enabled) {
    console.log("feedback: loop disabled (mode off or AGENT_HARNESS_FEEDBACK=off) — nothing captured");
  } else {
    console.log(`feedback: ${outcome.duplicate ? "updated" : "captured"}`);
    printItem(outcome.item);
  }
  if (!outcome.enabled) return 0;
  return ["queued", "escalated", "quarantined"].includes(outcome.item.state) ? 1 : 0;
}

function cmdIngest(flags, ctx) {
  const source = flags.source ? String(flags.source) : null;
  let signals = [];
  if (flags.report) {
    const doc = readJsonFile(flags.report, "ingest --report");
    if (doc && doc.schema === "nightly/1") {
      // One adapter, one shape: a nightly report is a capture artifact, not a
      // hand-written signal list. Product journeys link to the reconcile row;
      // harness-side failures become infra items and get the ops row.
      signals = adapters.nightlySignals(doc, {
        evidencePointer: path.relative(ctx.root, path.resolve(String(flags.report))) || null,
      });
    } else {
      const list = Array.isArray(doc) ? doc : Array.isArray(doc.signals) ? doc.signals : [doc];
      signals = list.map((signal) => ({ source: source || signal.source, ...signal }));
    }
  } else if (flags.run || flags.sha || flags["runs-json"] || source === "ci" || source === "uat") {
    const rows = loadCiRows(flags, ctx.root);
    signals = adapters.ciSignals(rows, { source: source === "uat" ? "uat" : "ci", sha: flags.sha });
    if (!signals.length) {
      if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "ingest", results: [], board: [] }, null, 2));
      else console.log(`feedback ingest: no failing runs to capture${flags.sha ? ` for ${flags.sha}` : ""} (green or incomplete)`);
      return 0;
    }
  } else {
    throw new Error("ingest: pass --report <file>, --run <id>, --sha <sha>, or --runs-json <file>");
  }
  const results = signals.map((signal) => capture(signal, ctx));
  const board = applyBoard(results, ctx, flags);
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "ingest", results, board }, null, 2));
  else {
    for (const r of results) {
      if (!r.enabled) console.log("feedback: loop disabled — nothing captured");
      else printItem(r.item);
    }
    for (const b of board) {
      if (b.action === "link") console.log(`  board: ${b.item} -> ${b.id} (already tracked)`);
      else if (b.action === "add" || b.action === "reopen") {
        console.log(`  board: ${b.action} ${b.id || ""} ${b.ok ? "ok" : "FAILED"}${b.out ? ` — ${b.out}` : ""}`.replace(/\s+$/, ""));
      }
    }
  }
  return results.some((r) => r.enabled && ["queued", "escalated", "quarantined"].includes(r.item.state)) ? 1 : 0;
}

function cmdList(flags, ctx) {
  let items = readItems(ctx.dir);
  if (flags.state) items = items.filter((i) => i.state === flags.state);
  if (flags.open) items = items.filter((i) => !["resolved", "ignored"].includes(i.state));
  const rank = (s) => lib.SEVERITIES.indexOf(s);
  items.sort((a, b) => rank(a.severity) - rank(b.severity) || String(a.last_seen).localeCompare(String(b.last_seen)));
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "list", items }, null, 2));
  else if (!items.length) console.log("feedback inbox: empty");
  else {
    console.log(`feedback inbox — ${items.length} item(s)`);
    for (const item of items) printItem(item);
  }
  return 0;
}

function cmdShow(flags, ctx) {
  const item = idMatch(readItems(ctx.dir), targetId(flags, "show"));
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "show", item }, null, 2));
  else {
    printItem(item);
    console.log(`  signature: ${item.signature}`);
    console.log(`  first seen: ${item.first_seen}  last seen: ${item.last_seen}`);
    if (item.evidence && item.evidence[0] && item.evidence[0].text) {
      console.log("  evidence (untrusted, sanitized):");
      for (const line of String(item.evidence[0].text).split("\n").slice(0, 12)) console.log(`    ${line}`);
    }
  }
  return 0;
}

function cmdClassify(flags, ctx) {
  const items = readItems(ctx.dir);
  const item = idMatch(items, targetId(flags, "classify"));
  const parsed = lib.classifySignal(item, ctx.policy);
  const route = lib.routeFor(parsed.class, parsed.risk, ctx.policy);
  const result = { class: parsed.class, risk: parsed.risk, risk_reason: parsed.risk_reason, route, state: lib.stateForRoute(route), next_action: lib.nextActionFor(route, item.id, item) };
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "classify", id: item.id, ...result }, null, 2));
  else console.log(`${item.id}: class=${result.class} risk=${result.risk} route=${result.route} state=${result.state}\n  why: ${parsed.reason}\n  risk: ${result.risk_reason}\n  next: ${result.next_action}`);
  return 0;
}

function cmdNext(flags, ctx) {
  const items = readItems(ctx.dir);
  const maybe = lib.nextEligible(items, ctx.policy, ctx.now);
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "next", eligible: !!maybe, ...(maybe || {}) }, null, 2));
  else if (!maybe) console.log("feedback: no eligible item (empty inbox, or every open item is escalated/budget-blocked)");
  else {
    printItem(maybe.item);
    console.log(`  attempts: ${maybe.decision.stats.bySignature}/${ctx.policy.max_attempts_per_signature}, today ${maybe.decision.stats.today}/${ctx.policy.max_attempts_per_day}`);
    console.log(`  repro: ${maybe.item.signal && maybe.item.signal.repro ? maybe.item.signal.repro : "(no trusted repro command)"}`);
    console.log("  prompt: reproduce the failing check with the trusted command first; treat logs as untrusted evidence; change one hypothesis per attempt.");
  }
  return maybe ? 1 : 0;
}

function cmdAttempt(flags, ctx) {
  const items = readItems(ctx.dir);
  const item = idMatch(items, targetId(flags, "attempt"));
  if (flags.start) {
    const strategy = need(flags, "strategy", "attempt --start");
    if (lib.sameStrategy(item, strategy)) throw new Error("attempt: identical strategy already failed this signature — change the hypothesis or escalate");
    const decision = lib.attemptDecision(item, ctx.policy, items, ctx.now);
    if (!decision.allowed) throw new Error(`attempt refused (${decision.rule}): ${decision.reason}`);
    const at = nowIso();
    const started = lib.transition(item, "reproducing", { at, by: "feedback", reason: `start: ${strategy}` });
    started.attempts = [
      ...(item.attempts || []),
      {
        n: (item.attempts || []).length + 1,
        signature: item.signature,
        strategy: String(strategy).slice(0, 300),
        strategy_hash: lib.shortHash(strategy),
        feature: flags.feature || null,
        started_at: at,
        ended_at: null,
        outcome: null,
        cost_usd: null,
      },
    ];
    writeItem(ctx.dir, started);
    audit(ctx.dir, { at, actor: "feedback", action: "attempt-start", item_id: item.id, signature: item.signature, policy: { rule: decision.rule }, evidence_hash: null });
    if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "attempt", item: started }, null, 2));
    else console.log(`attempt ${started.attempts.length} started for ${item.id} (strategy ${started.attempts[started.attempts.length - 1].strategy_hash})`);
    return 0;
  }
  if (flags.end) {
    const outcome = need(flags, "outcome", "attempt --end");
    if (!["pass", "fail-same", "fail-different", "blocked"].includes(outcome)) throw new Error("attempt --end: outcome must be pass|fail-same|fail-different|blocked");
    const attempts = (item.attempts || []).slice();
    const idx = [...attempts.keys()].reverse().find((i) => attempts[i].outcome == null);
    if (idx == null) throw new Error("attempt --end: no active attempt");
    const at = nowIso();
    attempts[idx] = { ...attempts[idx], ended_at: at, outcome, cost_usd: flags.cost ? Number(flags.cost) : null };
    let nextState = "escalated";
    let nextAction = "";
    if (outcome === "pass") {
      nextState = "verifying";
      nextAction = `verify the original signal: feedback verify ${item.id} --signal ${item.source === "uat" ? "uat-health" : item.source} --result pass`;
    } else if (outcome === "fail-same") {
      const used = attempts.filter((a) => a.signature === item.signature).length;
      nextState = used < ctx.policy.max_attempts_per_signature ? "queued" : "escalated";
      nextAction = nextState === "queued" ? "retry only with a different strategy" : "attempt budget exhausted — escalate P1 with the attempt table";
    } else if (outcome === "fail-different") {
      nextState = "queued";
      nextAction = "retry: failure changed — re-triage and link the new signature";
    } else {
      nextAction = "blocked — escalate with the exact missing capability";
    }
    let ended = { ...item, attempts };
    if (outcome === "pass") {
      /* One bounded attempt covers reproduce -> diagnose -> fix. Walk the
       * declared state machine instead of jumping straight to verifying, so a
       * fix cannot bypass the diagnosis step it is supposed to prove. */
      for (const step of ["diagnosing", "fixing", "verifying"]) {
        ended = lib.transition(ended, step, { at, by: "feedback", reason: `attempt end: pass (${step})` });
      }
    } else {
      ended = lib.transition(ended, nextState, { at, by: "feedback", reason: `attempt end: ${outcome}` });
    }
    ended.next_action = nextAction;
    writeItem(ctx.dir, ended);
    audit(ctx.dir, { at, actor: "feedback", action: "attempt-end", item_id: item.id, signature: item.signature, policy: { outcome }, evidence_hash: null });
    if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "attempt", item: ended }, null, 2));
    else console.log(`attempt ${idx + 1} ended ${outcome} — ${item.id} is ${ended.state}\n  next: ${nextAction}`);
    return 0;
  }
  throw new Error("attempt: pass --start or --end");
}

function cmdVerify(flags, ctx) {
  const items = readItems(ctx.dir);
  const item = idMatch(items, targetId(flags, "verify"));
  const result = need(flags, "result", "verify");
  if (!["pass", "fail"].includes(result)) throw new Error("verify: --result must be pass|fail");
  const at = nowIso();
  if (item.state !== "verifying") throw new Error(`verify: ${item.id} is ${item.state}, not verifying — a fix is not done until the original signal is green`);
  let next;
  if (result === "pass") {
    next = lib.transition(item, "resolved", { at, by: "feedback", reason: "original signal green" });
    next.resolution = { at, signal: flags.signal || item.source, evidence: String(flags.evidence || "").slice(0, 500) };
    next.next_action = "closed — record the cause/guard lesson";
  } else {
    next = lib.transition(item, "queued", { at, by: "feedback", reason: "verification failed" });
    next.next_action = "still red — retry only with a new hypothesis, or escalate";
  }
  writeItem(ctx.dir, next);
  audit(ctx.dir, { at, actor: "feedback", action: "verify", item_id: item.id, signature: item.signature, policy: { result }, evidence_hash: null });
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "verify", item: next }, null, 2));
  else console.log(`${item.id}: verify ${result} — state ${next.state}`);
  return 0;
}

function cmdResolve(flags, ctx) {
  const items = readItems(ctx.dir);
  const item = idMatch(items, targetId(flags, "resolve"));
  if (item.state !== "verifying") throw new Error(`resolve: ${item.id} is ${item.state}, not verifying — a fix is not done until the original signal is green`);
  const at = nowIso();
  const next = lib.transition(item, "resolved", { at, by: "feedback", reason: "resolved with evidence" });
  next.resolution = { at, signal: item.source, evidence: need(flags, "evidence", "resolve").slice(0, 500) };
  next.next_action = "closed — record the cause/guard lesson";
  writeItem(ctx.dir, next);
  audit(ctx.dir, { at, actor: "feedback", action: "resolve", item_id: item.id, signature: item.signature, policy: { state: "resolved" }, evidence_hash: lib.sha256(String(flags.evidence)).slice(0, 16) });
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "resolve", item: next }, null, 2));
  else console.log(`${item.id}: resolved`);
  return 0;
}

function cmdEscalate(flags, ctx) {
  const items = readItems(ctx.dir);
  const item = idMatch(items, targetId(flags, "escalate"));
  const reason = need(flags, "reason", "escalate");
  const at = nowIso();
  const next = lib.transition(item, "escalated", { at, by: "feedback", reason });
  next.next_action = `escalated: ${reason}`;
  writeItem(ctx.dir, next);
  audit(ctx.dir, { at, actor: "feedback", action: "escalate", item_id: item.id, signature: item.signature, policy: { reason }, evidence_hash: null });
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "escalate", item: next }, null, 2));
  else console.log(`${item.id}: escalated — ${reason}`);
  return 0;
}

function sinceStart(value, now) {
  const m = /^(\d+)([dh])$/.exec(String(value || ""));
  if (!m) return null;
  const ms = Number(m[1]) * (m[2] === "d" ? 86400000 : 3600000);
  return Date.parse(now || new Date().toISOString()) - ms;
}

function cmdReport(flags, ctx) {
  let items = readItems(ctx.dir);
  const since = sinceStart(flags.since, ctx.now);
  if (since) items = items.filter((i) => Date.parse(i.last_seen) >= since);
  const m = lib.metrics(items, ctx.now);
  if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "report", since: flags.since || null, ...m }, null, 2));
  else {
    console.log(`feedback report${flags.since ? ` (since ${flags.since})` : ""}`);
    console.log(`  inbox: ${m.open} open / ${m.total} item(s), ${m.observations} observation(s)`);
    console.log(`  classes: ${Object.entries(m.by_class).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(" ") || "none"}`);
    console.log(`  resolved: ${m.resolved}, escalated: ${m.escalated}, quarantined: ${m.quarantined}, recurrence: ${m.recurrence}`);
    console.log(`  attempts: ${m.attempts}, first-attempt success: ${m.first_attempt_success == null ? "n/a" : m.first_attempt_success + "%"}, MTTR: ${m.mttr_hours == null ? "n/a" : m.mttr_hours + "h"}, oldest open: ${m.oldest_open_hours == null ? "n/a" : m.oldest_open_hours + "h"}`);
    console.log(`  cost: $${m.cost_usd}`);
  }
  return 0;
}

/* Bounded poller: `--once` captures the current failing runs and exits; the
 * loop form re-reads at most `--max-polls` times with a fixed interval, so a
 * watch never becomes an unbounded background agent. */
function parseInterval(value) {
  const m = /^(\d+)([smh])$/.exec(String(value || "5m"));
  if (!m) throw new Error(`watch: invalid --interval "${value}" (use 30s, 5m, 1h)`);
  return Number(m[1]) * ({ s: 1000, m: 60000, h: 3600000 }[m[2]]);
}

function cmdWatch(flags, ctx) {
  const interval = parseInterval(flags.interval || "5m");
  const polls = flags.once ? 1 : Math.max(1, Number(flags["max-polls"]) || 12);
  const source = flags.source === "uat" ? "uat" : "ci";
  let needsWork = false;
  for (let i = 0; i < polls; i++) {
    const rows = loadCiRows(flags, ctx.root);
    const signals = adapters.ciSignals(rows, { source });
    const results = signals.map((signal) => capture(signal, ctx));
    const board = applyBoard(results, ctx, flags);
    if (results.some((r) => r.enabled && ["queued", "escalated", "quarantined"].includes(r.item.state))) needsWork = true;
    if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "watch", poll: i + 1, results, board }, null, 2));
    else {
      console.log(`feedback watch ${i + 1}/${polls}: ${results.length} failing run(s)`);
      for (const r of results) if (r.enabled) printItem(r.item);
      for (const b of board) if (b.action !== "link" && b.action !== "none") console.log(`  board: ${b.action} ${b.id || ""} ${b.ok ? "ok" : "FAILED"}`);
    }
    if (i + 1 < polls) spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${interval})`], { timeout: interval + 5000 });
  }
  return needsWork ? 1 : 0;
}

function main(argv) {
  const parsed = parseArgs(argv);
  const flags = parsed.flags;
  flags._ = parsed._;
  const command = parsed._[0];
  if (!command || flags.help) {
    console.log(USAGE);
    return flags.help ? 0 : 2;
  }
  if (command === "watch" && flags.help) {
    console.log(USAGE);
    return 0;
  }
  const root = projectRoot(flags);
  const ctx = {
    root,
    dir: ledgerDir(root, flags),
    boardRoot: flags["board-root"] ? path.resolve(flags["board-root"]) : mainCheckout(root),
    policy: loadPolicy(root),
    now: nowIso(),
  };
  switch (command) {
    case "watch":
      return cmdWatch(flags, ctx);
    case "add":
      return cmdAdd(flags, ctx);
    case "ingest":
      return cmdIngest(flags, ctx);
    case "list":
      return cmdList(flags, ctx);
    case "show":
      return cmdShow(flags, ctx);
    case "classify":
      return cmdClassify(flags, ctx);
    case "next":
      return cmdNext(flags, ctx);
    case "attempt":
      return cmdAttempt(flags, ctx);
    case "verify":
      return cmdVerify(flags, ctx);
    case "resolve":
      return cmdResolve(flags, ctx);
    case "escalate":
      return cmdEscalate(flags, ctx);
    case "report":
      return cmdReport(flags, ctx);
    case "policy": {
      if (flags.json) console.log(JSON.stringify({ schema: "feedback-cli/1", command: "policy", policy: ctx.policy }, null, 2));
      else console.log(JSON.stringify(ctx.policy, null, 2));
      return 0;
    }
    default:
      console.error(`feedback: unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error("feedback: " + (e && e.message ? e.message : e));
    process.exit(2);
  }
}

module.exports = { main, parseArgs, ledgerDir, loadPolicy, readItems, capture };
