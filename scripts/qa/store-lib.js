#!/usr/bin/env node
"use strict";
/*
 * store-lib — one home for reading the local opencode session store.
 *
 * WHY THIS EXISTS (2026-10-16 field review, harness 0.1.163):
 * the telemetry scripts read the store through `opencode db --format json "<SQL>"`.
 * OpenCode **V2 removed the `db` subcommand** (it now prints the root help and
 * exits 0), and it **moved the session tables**: V2 sessions live in
 * `session_v2` + `session_message`, while `session` / `message` / `part` are the
 * frozen legacy mirror. So `provider-stats.js` (→ `report:cost`, `report:recon`,
 * `session_info`) failed on V2 with `Unexpected token 'D'` — the harness lost its
 * own measurement loop. This module is the fix: resolve the store, detect which
 * table generation is authoritative, and run SQL through whichever engine is
 * available, failing loudly (never silently empty) when none is.
 *
 * Engines, in preference order:
 *   1. `node:sqlite` (bundled; sync, no temp files) — Node >= 22.5.
 *   2. `opencode db --format json` — only when the running runtime still has it
 *      (V1 line), detected once per process.
 *   3. the `sqlite3` CLI with `-json`.
 * Any engine returning rows wins; all failing is an actionable throw.
 *
 * Table generation (`flavour`) is detected once: `session_v2` + `session_message`
 * present → "v2" (authoritative, includes migrated legacy rows), else "v1".
 *
 * Usage:
 *   const store = require("./store-lib.js").openStore();
 *   store.query("SELECT count(*) AS n FROM " + store.sessions);
 *   store.sessionDirectory("ses_...");   // -> absolute checkout that owns it
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const DEFAULT_DATA_REL = path.join(".local", "share", "opencode");

/* Parse the `key<whitespace>value` lines `opencode debug paths` prints. Pure:
 * the caller supplies the raw text so this is unit-testable without a CLI. */
function parseDebugPaths(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*([a-z_]+)\s+(.+?)\s*$/i);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

/* Ask the CLI where its store lives. V2's `debug paths` is the supported
 * replacement for the removed `db` subcommand; it prints `data <dir>` and
 * `db <file>`. Best-effort: a missing/old CLI yields `{}`. */
function cliPaths(opts = {}) {
  const run = opts.spawnSync || spawnSync;
  const bin = opts.opencodeBin || opts.env?.OPENCODE_BIN || "opencode";
  try {
    const r = run(bin, ["debug", "paths"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: opts.timeout || 8000,
    });
    if (r.status !== 0) return {};
    return parseDebugPaths(r.stdout);
  } catch (_) {
    return {};
  }
}

/* The store directory. `OPENCODE_DATA_DIR` (explicit) → `opencode debug paths`
 * (`data`) → the platform default. */
function resolveDataRoot(opts = {}) {
  const env = opts.env || process.env;
  const exists = opts.exists || fs.existsSync;
  if (env.OPENCODE_DATA_DIR && exists(env.OPENCODE_DATA_DIR)) return env.OPENCODE_DATA_DIR;
  const paths = opts.paths || cliPaths({ ...opts, env });
  if (paths.data && exists(paths.data)) return paths.data;
  const home = (opts.homedir || os.homedir)();
  return path.join(home, DEFAULT_DATA_REL);
}

/* The SQLite file. `opencode debug paths` (`db`) wins because V2 may relocate
 * it; else `<data>/opencode.db`. */
function resolveDbPath(opts = {}) {
  if (opts.dbPath) return opts.dbPath;
  const env = opts.env || process.env;
  const exists = opts.exists || fs.existsSync;
  if (env.OPENCODE_DB && exists(env.OPENCODE_DB)) return env.OPENCODE_DB;
  const paths = opts.paths || cliPaths({ ...opts, env });
  if (paths.db && exists(paths.db)) return paths.db;
  return path.join(resolveDataRoot({ ...opts, paths }), "opencode.db");
}

// ---------------------------------------------------------------- engines

/* `node:sqlite` when present (Node >= 22.5). Kept behind a loader so a missing
 * module is a normal fall-through, not a crash. */
function nodeSqlite(opts = {}) {
  const requireFn = opts.requireFn || require;
  try {
    const mod = requireFn("node:sqlite");
    if (mod && typeof mod.DatabaseSync === "function") return mod.DatabaseSync;
  } catch (_) {
    /* not available on this runtime */
  }
  return null;
}

/* One process-wide handle per db path. opencode sessions keep writing the file,
 * so a read-only handle is preferred (it never takes a write lock) with a plain
 * handle as fallback for a WAL that wants recovery. */
const handles = new Map();
function sqliteHandle(DatabaseSync, dbPath) {
  if (handles.has(dbPath)) return handles.get(dbPath);
  let db = null;
  for (const readOnly of [true, false]) {
    try {
      db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
      db.exec("PRAGMA busy_timeout = 3000");
      break;
    } catch (_) {
      db = null;
    }
  }
  handles.set(dbPath, db);
  return db;
}

function queryNodeSqlite(dbPath, sql, opts = {}) {
  const DatabaseSync = opts.DatabaseSync || nodeSqlite(opts);
  if (!DatabaseSync) return undefined;
  const db = sqliteHandle(DatabaseSync, dbPath);
  if (!db) return undefined;
  const stmt = db.prepare(sql);
  return stmt.all();
}

/* `opencode db --format json` — the V1 line. Detected once: V2 prints the root
 * help (status 0, non-JSON) so the probe must assert the shape, not the exit. */
let dbSubcommand = null;
function hasDbSubcommand(opts = {}) {
  if (dbSubcommand !== null) return dbSubcommand;
  const run = opts.spawnSync || spawnSync;
  const bin = opts.opencodeBin || opts.env?.OPENCODE_BIN || "opencode";
  try {
    const r = run(bin, ["db", "--format", "json", "SELECT 1 AS ok"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: opts.timeout || 8000,
    });
    const text = String(r.stdout || "").trim();
    dbSubcommand = r.status === 0 && text.startsWith("[");
  } catch (_) {
    dbSubcommand = false;
  }
  return dbSubcommand;
}

function queryOpencodeDb(dbPath, sql, opts = {}) {
  if (opts.opencodeDb === false) return undefined;
  if (!hasDbSubcommand(opts)) return undefined;
  const run = opts.spawnSync || spawnSync;
  const bin = opts.opencodeBin || opts.env?.OPENCODE_BIN || "opencode";
  let tmp = null;
  let fd = null;
  try {
    // A large dump to a PIPE is truncated by the Bun binary (observed
    // 146,176/194,958 bytes) — write to a real fd instead.
    tmp = path.join(os.tmpdir(), `opencode-db-${process.pid}-${Date.now()}.json`);
    fd = fs.openSync(tmp, "w");
    const r = run(bin, ["db", "--format", "json", sql], { stdio: ["ignore", fd, "pipe"] });
    fs.closeSync(fd);
    fd = null;
    if (r.status !== 0) return undefined;
    const text = fs.readFileSync(tmp, "utf8").trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch (_) {
    return undefined;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch (_) { /* best-effort */ }
    }
    if (tmp) {
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* best-effort */ }
    }
  }
}

/* The `sqlite3` CLI with `-json` (SQLite >= 3.33). Last resort so a box without
 * a modern Node still measures. */
function sqlite3Bin(opts = {}) {
  if (opts.sqlite3) return opts.sqlite3;
  const run = opts.spawnSync || spawnSync;
  for (const cand of ["sqlite3", `${process.env.HOME || ""}/android-sdk/platform-tools/sqlite3`]) {
    if (!cand) continue;
    try {
      const r = run(cand, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
      if (r.status === 0 && /\d+\.\d+/.test(String(r.stdout || ""))) return cand;
    } catch (_) {
      /* try the next candidate */
    }
  }
  return null;
}

function querySqlite3Cli(dbPath, sql, opts = {}) {
  const bin = sqlite3Bin(opts);
  if (!bin) return undefined;
  const run = opts.spawnSync || spawnSync;
  try {
    const r = run(bin, ["-json", "-cmd", ".timeout 3000", dbPath, sql], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: opts.sqliteTimeout || 30000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (r.status !== 0) return undefined;
    const text = String(r.stdout || "").trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch (_) {
    return undefined;
  }
}

function noEngineError(dbPath) {
  return new Error(
    `opencode store unreachable: no SQLite engine available for ${dbPath}. ` +
      "Install a modern Node (>= 22.5, bundles node:sqlite), run under the opencode runtime " +
      "(V1 `opencode db`), or put `sqlite3` on PATH. Set OPENCODE_DB / OPENCODE_DATA_DIR to override the path."
  );
}

/* Run one SQL statement and return rows. `undefined` from every engine becomes
 * a loud throw: an empty aggregate must never be mistaken for "no usage". */
function makeQuery(dbPath, opts = {}) {
  const engines = opts.engines || [queryNodeSqlite, queryOpencodeDb, querySqlite3Cli];
  return function query(sql) {
    for (const engine of engines) {
      const rows = engine(dbPath, sql, opts);
      if (rows !== undefined) return rows;
    }
    throw noEngineError(dbPath);
  };
}

// ---------------------------------------------------------------- store

/* Detect the authoritative table generation. V2 keeps the legacy tables in the
 * file (migrated history), so `session_v2` presence — not emptiness — decides. */
function detectFlavour(query) {
  try {
    const rows = query(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2','session_message')"
    );
    const names = new Set((rows || []).map((r) => r.name));
    if (names.has("session_v2") && names.has("session_message")) {
      return { flavour: "v2", sessions: "session_v2", messages: "session_message", parts: null };
    }
  } catch (_) {
    /* fall through to v1 */
  }
  return { flavour: "v1", sessions: "session", messages: "message", parts: "part" };
}

/* The table set to query. `flavour` may be forced (tests, --store=v1). */
function tableSet(query, flavour) {
  if (flavour === "v2") return { flavour: "v2", sessions: "session_v2", messages: "session_message", parts: null };
  if (flavour === "v1") return { flavour: "v1", sessions: "session", messages: "message", parts: "part" };
  return detectFlavour(query);
}

let cached = null;
function openStore(opts = {}) {
  if (opts.dbPath && opts.query) {
    return { ...opts, ...tableSet(opts.query, opts.flavour) };
  }
  const dbPath = resolveDbPath(opts);
  const query = opts.query || makeQuery(dbPath, opts);
  const cacheKey = opts.noCache ? null : dbPath;
  if (cacheKey && cached && cached.dbPath === cacheKey && cached.query === query) return cached;
  const store = { dbPath, dataRoot: path.dirname(dbPath), query, ...tableSet(query, opts.flavour) };
  if (cacheKey) cached = store;
  return store;
}

/* Which checkout owns a session — the V2 replacement for the plugin-side
 * `ctx.location.directory` capture (a plugin instance is bound to the directory
 * it was loaded for, which is NOT necessarily the session's). Returns `` when the
 * session is absent, never a guess. */
function sessionDirectory(sessionID, opts = {}) {
  if (!sessionID) return "";
  const store = opts.store || openStore(opts);
  try {
    const rows = store.query(
      `SELECT directory FROM ${store.sessions} WHERE id = '${String(sessionID).replace(/'/g, "''")}' LIMIT 1`
    );
    return (rows && rows[0] && rows[0].directory) || "";
  } catch (_) {
    return "";
  }
}

module.exports = {
  DEFAULT_DATA_REL,
  parseDebugPaths,
  cliPaths,
  resolveDataRoot,
  resolveDbPath,
  makeQuery,
  detectFlavour,
  tableSet,
  openStore,
  sessionDirectory,
  hasDbSubcommand,
  // exported for tests / advanced callers
  queryNodeSqlite,
  queryOpencodeDb,
  querySqlite3Cli,
  noEngineError,
};
