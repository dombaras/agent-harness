#!/usr/bin/env node
"use strict";
/*
 * board-client — HTTP client for the shared board service (ADR 0001).
 *
 * The service is the external, project-scoped board (its own Next.js + Prisma
 * app). This module is the single home for talking to it, so the CLI
 * (scripts/backlog.js), the opencode tools, and any future consumer share one
 * transport. `scripts/backlog.js` picks a backend via `BACKLOG_BACKEND`:
 *   - service : all board reads/writes go to the HTTP service
 *   - file    : the legacy BACKLOG.md path (unchanged)
 *
 * Config is resolved from the project's `.harness.json` `board` block first
 * (per project, survives harness updates), then the environment:
 *   .harness.json -> { "board": { "url", "token", "project" } }
 *   BACKLOG_API_URL / BACKLOG_API_TOKEN / BACKLOG_PROJECT (env override)
 *
 * The functions mirror `backlog.js` command results so `formatResult` prints the
 * same text for either backend.
 */
const fs = require("fs");
const path = require("path");

/* Read the per-project board config block from `.harness.json`, if present.
 * The `token` there is honored but discouraged (it is a committed secret); the
 * machine-level token store below is the recommended home. */
function projectBoardConfig(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, ".harness.json"), "utf8"));
    const b = cfg && cfg.board;
    if (b && typeof b === "object") {
      return {
        url: typeof b.url === "string" ? b.url : "",
        token: typeof b.token === "string" ? b.token : "",
        project: typeof b.project === "string" ? b.project : "",
      };
    }
  } catch {
    /* no .harness.json / no board block */
  }
  return { url: "", token: "", project: "" };
}

/* Machine-level token store: `~/.config/agent-harness/tokens.json` maps a
 * project key to its service token (never committed). */
function tokenStore(project) {
  const base = process.env.XDG_CONFIG_HOME || path.join(require("os").homedir(), ".config");
  try {
    const store = JSON.parse(fs.readFileSync(path.join(base, "agent-harness", "tokens.json"), "utf8"));
    if (project && typeof store[project] === "string") return store[project];
  } catch {
    /* no store */
  }
  return "";
}

function config(root) {
  const file = root ? projectBoardConfig(root) : { url: "", token: "", project: "" };
  const project = process.env.BACKLOG_PROJECT || file.project || "";
  const url = (process.env.BACKLOG_API_URL || file.url || "").replace(/\/+$/, "");
  const token = process.env.BACKLOG_API_TOKEN || file.token || tokenStore(project) || "";
  return { url, token, project };
}

/** True when the CLI should use the service backend. */
function enabled(root) {
  if (process.env.BACKLOG_BACKEND === "file") return false;
  if (process.env.BACKLOG_BACKEND === "service") return true;
  // Auto: use the service only when it is configured (URL + token present).
  const c = config(root);
  return Boolean(c.url && c.token);
}

function projectKey(root) {
  const c = config(root);
  if (c.project) return c.project;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, ".harness.json"), "utf8"));
    if (cfg && typeof cfg.projectName === "string" && cfg.projectName.trim()) return cfg.projectName.trim();
  } catch {
    /* no .harness.json — fall back to the directory name */
  }
  return path.basename(root);
}

/**
 * Synchronous HTTP via a tiny child that uses fetch and prints the response.
 * The CLI is synchronous end-to-end (execFileSync-based), so a blocking bridge
 * keeps the call sites unchanged and avoids rewriting every command async.
 */
function httpSync(root, method, endpoint, body) {
  const c = config(root);
  if (!c.url) throw new Error("board service not configured: set BACKLOG_API_URL");
  if (!c.token) throw new Error("board service token missing: set BACKLOG_API_TOKEN");

  const payload = JSON.stringify({
    url: `${c.url}${endpoint}`,
    method,
    token: c.token,
    project: projectKey(root),
    body: body === undefined ? null : body,
  });

  const script = `
    const p = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const headers = { Authorization: "Bearer " + p.token, "X-Project": p.project };
    const init = { method: p.method, headers };
    if (p.body !== null) { headers["Content-Type"] = "application/json"; init.body = JSON.stringify(p.body); }
    fetch(p.url, init).then(async (r) => {
      const text = await r.text();
      process.stdout.write(JSON.stringify({ status: r.status, body: text }));
    }).catch((e) => { process.stdout.write(JSON.stringify({ status: 0, error: String(e && e.message || e) })); });
  `;

  const res = require("child_process").execFileSync(process.execPath, ["-e", script], {
    input: payload,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(res);
  } catch {
    throw new Error(`board service: unparseable response: ${res.slice(0, 200)}`);
  }
  if (parsed.status === 0) throw new Error(`board service unreachable at ${c.url}: ${parsed.error}`);
  const json = parsed.body ? JSON.parse(parsed.body) : {};
  if (parsed.status >= 400) throw new Error(json.error || `board service error ${parsed.status}`);
  return json;
}

/** The frozen BacklogBoard shape. */
function getBoard(root) {
  return httpSync(root, "GET", "/api/board");
}

function cmdResult(root, action, id, body) {
  const endpoint = id ? `/api/items/${encodeURIComponent(id)}/${action}` : `/api/items`;
  return httpSync(root, "POST", endpoint, body || {});
}

function add(root, args) {
  return httpSync(root, "POST", "/api/items", {
    task: args._[0],
    priority: args.p,
    evidence: args.evidence,
    epic: args.epic,
    dependsOn: args["depends-on"] || args.depends,
    id: args.id,
  }).result;
}

/** Look up a row in the live board so results carry task/closed for output parity. */
function rowById(board, id) {
  for (const key of ["open", "queued", "inprogress", "frozen", "archive"]) {
    const row = (board[key] || []).find((r) => r.id === id);
    if (row) return { key, row };
  }
  return { key: null, row: null };
}

function take(root, id, handoff) {
  const json = httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/take`, { handoff });
  const { row } = rowById(json.board, id);
  return { ...json.result, handoff: row ? row.handoff : handoff };
}
function queue(root, id) {
  const json = httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/queue`, {});
  const { row } = rowById(json.board, id);
  return { ...json.result, task: row ? row.task : undefined };
}
function unqueue(root, id) {
  const json = httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/unqueue`, {});
  const { row } = rowById(json.board, id);
  return { ...json.result, task: row ? row.task : undefined };
}
function archive(root, id, closed) {
  const json = httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/archive`, { closed });
  const { row } = rowById(json.board, id);
  return { ...json.result, task: row ? row.task : undefined, closed: row ? row.closed : closed };
}
function freeze(root, id, why, reopen) {
  const json = httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/freeze`, { why, reopen });
  const { row } = rowById(json.board, id);
  return { ...json.result, cond: row ? row.condition : [why, reopen ? `reopen when ${reopen}` : ""].filter(Boolean).join(" — ") };
}
function reopen(root, id, reason, priority) {
  const json = httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/reopen`, { reason, priority });
  const { row } = rowById(json.board, id);
  return { ...json.result, reason: reason || "reopened", priority: row ? row.priority : priority };
}
function priority(root, id, p) {
  return httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/priority`, { priority: p }).result;
}
function setEpic(root, id, to) {
  return httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/epic`, { to }).result;
}
function depends(root, id, on) {
  return httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/depends`, { on }).result;
}
function owns(root, id, files) {
  return httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/owns`, { files }).result;
}
function worktreeRecord(root, id, dir, branch, handoff) {
  return httpSync(root, "POST", `/api/items/${encodeURIComponent(id)}/worktree`, { dir, branch, handoff }).result;
}
function epicAdd(root, key, label, goal) {
  return httpSync(root, "POST", "/api/epics", { key, label, goal }).result;
}
function next(root) {
  return httpSync(root, "GET", "/api/next");
}
function nextTake(root, handoff) {
  return httpSync(root, "POST", "/api/next/take", { handoff }).result;
}

/**
 * The `list --json` shape is the board contract; both backends share it via
 * `getBoard`. The human `list` renderer needs the same arrays, so callers use
 * this directly.
 */
module.exports = {
  enabled,
  projectKey,
  getBoard,
  add,
  take,
  queue,
  unqueue,
  archive,
  freeze,
  reopen,
  priority,
  setEpic,
  depends,
  owns,
  worktreeRecord,
  epicAdd,
  next,
  nextTake,
  httpSync,
};
