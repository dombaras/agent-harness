#!/usr/bin/env node
"use strict";
/*
 * backend-build-cache — skip a repeated backend build when its inputs are
 * unchanged.
 *
 * `device-up.sh` can run a production backend (`next build` + `next start`)
 * instead of a dev server: it is lower and steadier on memory across the long
 * matrix run. A production build is a heavy one-shot, so paying it on every
 * bring-up would trade a memory win for a slow startup. This module
 * content-addresses the declared inputs and lets `device-up.sh` skip the build
 * when nothing changed.
 *
 * Inputs are the build command plus a project-declared `devBuildCache` list of
 * git pathspec globs (in `local.json`). Resolution goes through `git ls-files`
 * so globs use git's own semantics and ignored trees (`node_modules`, `.next`,
 * `.git`) never enter the hash. A new/untracked file under a glob counts too.
 *
 * Project config (`scripts/qa/mobile-e2e/local.json`, project-owned):
 *   devBuildCmd    the backend build command (e.g. `npm run build`)
 *   devBuildCache  globs whose content invalidates the cache
 *                  (e.g. ["app/**", "lib/**", "next.config.*", "package.json"])
 *   devBuildOutput optional artifact a hit must also find present
 *                  (e.g. ".next/BUILD_ID") — so a deleted build output is a
 *                  miss, never a skip that leaves `next start` with nothing
 *
 * CLI:
 *   backend-build-cache.js key    --cmd "<cmd>"   print the fingerprint (exit 3
 *                                                 when no globs are declared)
 *   backend-build-cache.js check  --cmd "<cmd>"   exit 0 on a cache hit, 1 on a
 *                                                 miss (stderr says why)
 *   backend-build-cache.js record --cmd "<cmd>"   remember the current inputs
 *   backend-build-cache.js status                 human-readable state
 *
 * The cache is a pure accelerator: a miss (or `MOBILE_E2E_DEV_BUILD_FORCE=1`)
 * always rebuilds. A failed build is never recorded.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const LOCAL_CONFIG = path.join(__dirname, "local.json");
const STATE_REL = path.join(".serve", "mobile-e2e-dev-build.json");

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function sha256File(p) { try { return sha256(fs.readFileSync(p)); } catch (_) { return ""; } }
function stateFile(root) { return path.join(root || ROOT, STATE_REL); }

function projectConfig() {
  try { return JSON.parse(fs.readFileSync(LOCAL_CONFIG, "utf8")); } catch (_) { return {}; }
}

/* The declared cache globs, normalized. Absent/empty means "no caching" — the
 * build runs every time rather than risk a stale hit. */
function configuredGlobs(cfg) {
  const c = cfg || projectConfig();
  const g = c.devBuildCache;
  if (!Array.isArray(g)) return [];
  return g.map((x) => String(x).trim()).filter(Boolean);
}

/* Optional build artifact a cache hit must find present. Empty means the
 * fingerprint alone decides. */
function configuredOutput(cfg) {
  const c = cfg || projectConfig();
  return typeof c.devBuildOutput === "string" ? c.devBuildOutput.trim() : "";
}

/* Resolve globs to a sorted list of repo-relative files. Returns null when git
 * or a repo is unavailable, so the caller falls back to no cache. */
function watchedFiles(globs, root) {
  const base = root || ROOT;
  if (!globs || !globs.length) return null;
  const r = spawnSync(
    "git",
    ["-C", base, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...globs],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }
  );
  if (r.status !== 0 || !r.stdout) return null;
  return r.stdout.toString("utf8").split("\0").filter(Boolean).sort();
}

/* Content fingerprint of the declared inputs. Null when caching is disabled or
 * the file set cannot be resolved. */
function fingerprint(opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const globs = o.globs != null ? o.globs : configuredGlobs();
  const files = watchedFiles(globs, root);
  if (!files) return null;
  const manifest = {
    v: 1,
    cmd: o.cmd || "",
    files: files.map((rel) => [rel, sha256File(path.join(root, rel))]),
  };
  return sha256(JSON.stringify(manifest));
}

function readState(root) {
  try { return JSON.parse(fs.readFileSync(stateFile(root), "utf8")); } catch (_) { return null; }
}

function writeState(state, root) {
  const p = stateFile(root);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function parseArgs(argv) {
  const out = { _: [], cmd: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--cmd") out.cmd = argv[++i] || "";
    else if (a.startsWith("--cmd=")) out.cmd = a.slice("--cmd=".length);
    else out._.push(a);
  }
  return out;
}

function cmdKey(args) {
  const f = fingerprint({ cmd: args.cmd });
  if (!f) {
    console.error("backend-build-cache: no devBuildCache globs declared — not caching");
    return 3;
  }
  console.log(f);
  return 0;
}

function cmdCheck(args) {
  const f = fingerprint({ cmd: args.cmd });
  if (!f) {
    console.error("backend-build-cache: no devBuildCache globs declared — not caching (always rebuild)");
    return 1;
  }
  const st = readState();
  const output = configuredOutput();
  const outputPresent = !output || fs.existsSync(path.join(ROOT, output));
  if (st && st.fingerprint === f && st.cmd === args.cmd && outputPresent) {
    console.log("backend-build-cache: HIT — inputs unchanged");
    return 0;
  }
  if (st && st.fingerprint === f && st.cmd === args.cmd && !outputPresent) {
    console.log(`backend-build-cache: MISS — recorded build output "${output}" is absent`);
    return 1;
  }
  console.log("backend-build-cache: MISS — inputs changed or first run");
  return 1;
}

function cmdRecord(args) {
  const f = fingerprint({ cmd: args.cmd });
  if (!f) {
    console.log("backend-build-cache: no globs declared — not recording");
    return 0;
  }
  writeState({ fingerprint: f, cmd: args.cmd, at: new Date().toISOString() });
  console.log("backend-build-cache: recorded");
  return 0;
}

function cmdStatus() {
  const cfg = projectConfig();
  const globs = configuredGlobs(cfg);
  const output = configuredOutput(cfg);
  const f = fingerprint({ cmd: cfg.devBuildCmd || "", globs });
  const st = readState();
  const outputPresent = !output || fs.existsSync(path.join(ROOT, output));
  console.log(JSON.stringify({
    globs,
    output: output || null,
    outputPresent,
    current: f,
    recorded: st ? { fingerprint: st.fingerprint, cmd: st.cmd, at: st.at } : null,
    hit: !!(f && st && st.fingerprint === f && outputPresent),
  }, null, 2));
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sub = args._[0];
  let code = 0;
  switch (sub) {
    case "key": code = cmdKey(args); break;
    case "check": code = cmdCheck(args); break;
    case "record": code = cmdRecord(args); break;
    case "status": code = cmdStatus(); break;
    default:
      console.error(
        "usage: backend-build-cache.js <key|check|record|status> [--cmd \"<build command>\"]\n" +
          "       (globs come from local.json devBuildCache)"
      );
      code = 2;
  }
  process.exit(code);
}

if (require.main === module) main();

module.exports = { fingerprint, watchedFiles, configuredGlobs, configuredOutput, sha256, stateFile };
