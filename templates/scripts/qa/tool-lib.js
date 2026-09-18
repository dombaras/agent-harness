#!/usr/bin/env node
"use strict";
/*
 * tool-lib — shared plumbing for the `.opencode/tools/*.ts` wrappers.
 *
 * The three deterministic-tool wrappers (backlog/checkpoint/session) each need
 * the same two things, and used to carry private copies that drifted:
 *   - nodeBin(): opencode runs as a compiled standalone binary, so within its
 *     runtime `process.execPath` is the opencode executable, NOT Node. Spawning
 *     it with a script path just re-launches opencode (the 0.1.65 regression).
 *     Resolve a real Node: an explicit OPENCODE_NODE override, then the runtime's
 *     PATH resolver (skipping WSL /mnt entries so a native node beats the
 *     interop Windows node.exe), then a bare "node".
 *   - sessionRoot(): opencode pins `context.worktree` to the tree the session
 *     launched in, so a worktree created MID-session (`backlog worktree` without
 *     `--open`) would leave every later call acting on main. The CLI records the
 *     worktree against the session id under `.serve/sessions/`; prefer it while
 *     the marker path it must contain still exists, else fall back to the launch
 *     tree. The marker is per-tool (BACKLOG.md / .agents / the worktree itself)
 *     but the resolution lives in ONE place so the three tools cannot disagree.
 *
 * One home per fact: this module is the single source for both.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

function nodeBin() {
  const override = process.env.OPENCODE_NODE;
  if (override) return override;
  const bun = globalThis.Bun;
  if (bun && typeof bun.which === "function") {
    const pathEnv = String(process.env.PATH || "");
    const native =
      process.platform === "linux"
        ? pathEnv
            .split(":")
            .filter((p) => p && !p.startsWith("/mnt/"))
            .join(":")
        : pathEnv;
    const found = bun.which("node", native ? { PATH: native } : {}) || bun.which("node");
    if (found) return found;
  }
  return "node";
}

/* The tree a tool call should act in. `marker` is a path (relative to the
 * candidate root) that must exist for the recorded worktree to be accepted. */
function sessionRoot(context, marker) {
  const base = (context && (context.worktree || context.directory)) || process.cwd();
  const sessionID = context && context.sessionID ? String(context.sessionID) : "";
  if (!sessionID) return base;
  try {
    const rec = fs
      .readFileSync(path.join(base, ".serve", "sessions", `${sessionID}.worktree`), "utf8")
      .trim();
    if (rec && fs.existsSync(path.join(rec, marker || ""))) return rec;
  } catch {
    /* no mid-session worktree recorded for this session */
  }
  return base;
}

/* Spawn a deployed script in the session's root. Returns stdout, or a compact
 * error string (never throws into a tool result). `opts`: { marker, env, timeout
 * (ms), label }. */
function runScript(context, scriptRel, args, opts) {
  const root = sessionRoot(context, opts && opts.marker);
  const script = path.join(root, scriptRel);
  const label = (opts && opts.label) || scriptRel;
  const spawnOpts = {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...((opts && opts.env) || {}) },
  };
  if (opts && opts.timeout) spawnOpts.timeout = opts.timeout;
  try {
    return execFileSync(nodeBin(), [script, ...args], spawnOpts);
  } catch (e) {
    return `${label}: ${e.message}\n${e.stderr || ""}`;
  }
}

module.exports = { nodeBin, sessionRoot, runScript };
