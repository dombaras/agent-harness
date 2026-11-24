#!/usr/bin/env node
"use strict";
/*
 * harness-update — the cached "is a newer harness published?" probe (F-023).
 *
 *   node scripts/harness-update.js status  [--root <dir>] [--json]
 *   node scripts/harness-update.js refresh [--root <dir>] [--force]
 *
 * `refresh` runs on every new / cleared / compacted session boundary (spawned
 * DETACHED by the context-guard plugin) and probes the newest harness it can
 * see — the registry's `dist-tags.latest` and, when the checkout IS the harness
 * source, its own `package.json` version. The verdict is cached in
 * `.serve/harness-update.json`.
 *
 * The registry is re-read on every refresh: a 24h cache made a just-published
 * release invisible to every session until the TTL expired, so a badge could
 * say "0.4.11 available" while 0.4.13 was already out. The call is detached and
 * timeout-bounded, so freshness costs the session nothing. A caller that
 * genuinely wants throttling can pass `--max-age <ms>` (default 0 = no cache).
 *
 * `status` is local-only: `orient` and the TUI badge read the cache (the badge
 * re-reads it on each render), so rendering never pays for a network call.
 *
 * Best-effort by construction: offline, no npm, malformed cache, or a
 * registry miss all degrade to "unknown" and never fail a session. Set
 * AGENT_HARNESS_NO_UPDATE_CHECK=1 to disable the probe entirely (CI, air-gapped).
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const SCHEMA = "harness-update/1";
const PKG_NAME = "opencode-agent-harness";
const COMMAND = `npx ${PKG_NAME}@latest update`;
const CACHE_REL = path.join(".serve", "harness-update.json");

function disabled() {
  const v = String(process.env.AGENT_HARNESS_NO_UPDATE_CHECK || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/* Numeric semver compare (major.minor.patch; prerelease tags ignored). */
function compareVersions(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function harnessVersion(root) {
  const v = readJson(path.join(root, ".harness.json"))?.version;
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/* Only a checkout of the harness itself carries the package name; a project's
 * own package.json version is unrelated to the harness. */
function localHarnessVersion(root) {
  const pkg = readJson(path.join(root, "package.json"));
  if (!pkg || pkg.name !== PKG_NAME) return null;
  return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
}

/* Registry lookup, mirroring bin/agent-harness.js `publishedLatestVersion` so a
 * test can point `npm_execpath` at a stub. Null on any failure. */
function npmLatest() {
  const npmCli = process.env.npm_execpath
    ? path.join(path.dirname(process.env.npm_execpath), "npm-cli.js")
    : null;
  const args = ["view", PKG_NAME, "version", "--json", "--fetch-timeout=5000", "--fetch-retries=0"];
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { encoding: "utf8", timeout: 10000 })
    : spawnSync("npm", args, { encoding: "utf8", timeout: 10000 });
  if (r.status !== 0) return null;
  const out = String(r.stdout || "").trim();
  if (!out) return null;
  try {
    const parsed = JSON.parse(out);
    return typeof parsed === "string" && parsed.trim() ? parsed.trim() : null;
  } catch {
    const bare = out.replace(/^"|"$/g, "").trim();
    return bare || null;
  }
}

function cacheFile(root) {
  return path.join(root, CACHE_REL);
}

function status(root) {
  if (disabled()) return { state: "disabled" };
  const deployed = harnessVersion(root);
  if (!deployed) return { state: "unknown", reason: "no .harness.json" };
  const doc = readJson(cacheFile(root));
  const latest = doc && typeof doc.latest === "string" && doc.latest.trim() ? doc.latest.trim() : null;
  if (!latest) return { state: "unknown", deployed, reason: "no cached verdict" };
  const behind = compareVersions(deployed, latest) < 0;
  return {
    state: behind ? "behind" : "current",
    deployed,
    latest,
    checkedAt: typeof doc.checkedAt === "string" ? doc.checkedAt : null,
    command: typeof doc.command === "string" && doc.command ? doc.command : COMMAND,
  };
}

function refresh(root, force, maxAgeMs = 0) {
  if (disabled()) return { state: "disabled" };
  const deployed = harnessVersion(root);
  if (!deployed) return { state: "unknown", reason: "no .harness.json" };

  const file = cacheFile(root);
  const prior = readJson(file);
  // Default `maxAgeMs` is 0: always re-probe (the caller is detached). An
  // explicit --max-age opts into a cache window; --force bypasses any window.
  if (!force && maxAgeMs > 0 && prior && typeof prior.checkedAt === "string") {
    const at = Date.parse(prior.checkedAt);
    if (Number.isFinite(at) && Date.now() - at < maxAgeMs) return status(root);
  }

  const npm = npmLatest();
  const local = localHarnessVersion(root);
  const latest = [npm, local].filter(Boolean).sort(compareVersions).pop() || null;
  // No source answered: keep the last good cache rather than downgrade it.
  if (!latest) return status(root);

  const doc = {
    schema: SCHEMA,
    checkedAt: new Date().toISOString(),
    deployed,
    latest,
    npm,
    local,
    command: COMMAND,
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch {
    /* observability only — the next session retries */
  }
  return status(root);
}

function main(argv) {
  const cmd = argv[0];
  const rootFlag = argv.indexOf("--root");
  const root = rootFlag >= 0 && argv[rootFlag + 1] ? path.resolve(argv[rootFlag + 1]) : process.cwd();
  const json = argv.includes("--json");

  if (cmd === "status") {
    const s = status(root);
    if (json) console.log(JSON.stringify(s));
    else if (s.state === "behind") {
      console.log(`harness v${s.deployed} -> v${s.latest} available — ${s.command} (then restart opencode)`);
    }
    return 0;
  }
  if (cmd === "refresh") {
    const ageFlag = argv.indexOf("--max-age");
    const maxAge = ageFlag >= 0 ? Number(argv[ageFlag + 1]) : 0;
    refresh(root, argv.includes("--force"), Number.isFinite(maxAge) && maxAge > 0 ? maxAge : 0);
    return 0;
  }
  console.error("usage: harness-update.js <status|refresh> [--root <dir>] [--json] [--force] [--max-age <ms>]");
  return 2;
}

module.exports = { status, refresh, compareVersions, harnessVersion, SCHEMA, COMMAND };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
