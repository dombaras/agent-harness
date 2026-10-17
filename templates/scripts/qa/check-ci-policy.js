#!/usr/bin/env node
"use strict";
/*
 * check-ci-policy — a gate against the workflow shapes that silently leave the
 * GitHub Actions free tier.
 *
 * Root cause of the 2026-10 outage (see `ci-usage-lib.js`): the burn was not one
 * bad job, it was a handful of workflow *shapes* — a sub-hourly cron that bills 1,440
 * jobs/month, an unpinned macOS runner on every push, and three mobile workflows
 * each triggering on the same push. Cost policy belongs in a gate so the shape
 * cannot be reintroduced by a passing PR.
 *
 * Rules (FAIL blocks landing; WARN is advisory):
 *   scheduled-too-frequent — a `cron:` firing more than hourly (WARN above
 *                            8/day) bills jobs every time it runs
 *   expensive-every-push   — a macOS/Windows runner on `push` with NO `paths:`
 *                            filter: every push pays the expensive rate
 *   larger-runner          — a `-large`/`-xlarge` runner is ALWAYS billed and is
 *                            never covered by included minutes
 *   duplicate-expensive-push — two or more macOS workflows triggered on the same
 *                            unfiltered push (the duplicate-mobile-workflow burn)
 *
 * A project with no `.github/workflows` passes (nothing to police). The audit is
 * pure given `{ name, src }` file records, so it is unit-testable offline.
 */

const fs = require("fs");
const path = require("path");

const { workflowRunnerLabels, scheduleMinutes } = require("./ci-triage.js");
const { jobsPerMonth, rateForLabel } = require("./ci-usage-lib.js");

/* Jobs-per-month above which a schedule FAILS (more than hourly) or WARNS
 * (more than ~8/day). */
const SCHEDULE_FAIL_JOBS = 720;
const SCHEDULE_WARN_JOBS = 240;

/* True when a workflow's `on:` includes an unfiltered `push`. Unfiltered means
 * no `paths:`/`paths-ignore:` directly under `push:`. Best-effort text scan. */
function pushTrigger(src) {
  const text = String(src || "");
  const inline = /^\s*on:\s*\[([^\]]*)\]/m.exec(text);
  if (inline) {
    return { push: /(^|[\s,])push([\s,]|$)/.test(inline[1]), paths: false };
  }
  const m = /^on:\s*$/m.exec(text) || /^on:\s*\n/m.exec(text);
  const body = m ? text.slice(m.index) : text;
  const push = /^\s{2}push:\s*(#.*)?$/m.test(body) || /^\s{2}push:\s*\[/m.test(body);
  if (!push) return { push: false, paths: false };
  // The `push:` block runs until the next key at the same (2-space) indent, or
  // EOF. A blank line does NOT end it — `$(?![\s\S])` is the true end of string
  // (a bare `$` would also match at the end of the first line and truncate it).
  const pm = /^(\s{2})push:\s*\n([\s\S]*?)(?=^\s{0,2}\S|$(?![\s\S]))/m.exec(body);
  const block = pm ? pm[2] : "";
  const paths = /^\s{4,}(paths|paths-ignore):/m.test(block);
  return { push: true, paths };
}

/* Audit a list of `{ name, src }` workflow records. Returns findings
 * `[{ level, rule, name, detail }]`. */
function auditWorkflows(files) {
  const findings = [];
  const expensivePush = [];
  for (const file of files || []) {
    const name = file.name;
    const src = file.src;
    const labels = workflowRunnerLabels(src);
    const rates = labels.map((l) => ({ label: l, ...rateForLabel(l) }));

    for (const n of scheduleMinutes(src)) {
      const jobs = jobsPerMonth(n);
      const cadence = n >= 60 ? `hourly` : `every ${n} min`;
      if (jobs > SCHEDULE_FAIL_JOBS) {
        findings.push({ level: "fail", rule: "scheduled-too-frequent", name, detail: `cron ${cadence} ≈ ${jobs} jobs/mo — use a daily/6-hourly cadence (or an event trigger) instead of a sub-hourly probe` });
      } else if (jobs > SCHEDULE_WARN_JOBS) {
        findings.push({ level: "warn", rule: "scheduled-too-frequent", name, detail: `cron ${cadence} ≈ ${jobs} jobs/mo — verify each run is worth the billed minute` });
      }
    }

    for (const r of rates.filter((r) => r.isLarger)) {
      findings.push({ level: "warn", rule: "larger-runner", name, detail: `\`${r.label}\` is a larger runner — always billed ($${r.rate}/min), never covered by included minutes` });
    }

    const expensive = rates.find((r) => r.key === "macos" || r.key === "windows");
    const push = pushTrigger(src);
    if (expensive && push.push && !push.paths) {
      expensivePush.push(name);
      findings.push({ level: "fail", rule: "expensive-every-push", name, detail: `\`${expensive.label}\` runs on every push (no \`paths:\` filter) at $${expensive.rate}/min — add a path filter (e.g. \`mobile/**\`) or move it off the push trigger` });
    }
  }

  if (expensivePush.length > 1) {
    for (const name of expensivePush) {
      findings.push({ level: "fail", rule: "duplicate-expensive-push", name, detail: `${expensivePush.length} expensive workflows run on the same unfiltered push (${expensivePush.join(", ")}) — merge them or path-filter each` });
    }
  }
  return findings;
}

function readWorkflows(root) {
  const dir = path.join(root, ".github", "workflows");
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const file of fs.readdirSync(dir).sort()) {
    if (!/\.ya?ml$/i.test(file)) continue;
    try {
      out.push({ name: file, src: fs.readFileSync(path.join(dir, file), "utf8") });
    } catch (_) {
      /* unreadable: skip */
    }
  }
  return out;
}

function parseArgs(argv) {
  const out = { root: null, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") out.root = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice("--root=".length);
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node scripts/qa/check-ci-policy.js [--root <dir>] [--json]");
    return;
  }
  const root = path.resolve(args.root || process.cwd());
  const files = readWorkflows(root);
  const findings = auditWorkflows(files);
  const fails = findings.filter((f) => f.level === "fail");
  const warns = findings.filter((f) => f.level === "warn");

  if (args.json) {
    console.log(JSON.stringify({ schema: "ci-policy/1", checked: files.map((f) => f.name), findings }, null, 2));
    process.exit(fails.length ? 1 : 0);
  }
  if (files.length === 0) {
    console.log("ci-policy: OK — no .github/workflows to check");
    return;
  }
  for (const f of findings) {
    console.log(`  [${f.level === "fail" ? "FAIL" : "warn"}] ${f.name}: ${f.rule} — ${f.detail}`);
  }
  const verdict = fails.length ? "FAIL" : "OK";
  console.log(`ci-policy: ${verdict} — ${files.length} workflow(s) checked, ${fails.length} failure(s), ${warns.length} warning(s)`);
  process.exit(fails.length ? 1 : 0);
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error("ci-policy: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

module.exports = { auditWorkflows, readWorkflows, pushTrigger, parseArgs, SCHEDULE_FAIL_JOBS, SCHEDULE_WARN_JOBS };
