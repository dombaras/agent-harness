import { tool } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

// Thin wrappers around the deterministic `scripts/checkpoint.js` CLI. The tool
// only shells out — the state block is written/replaced by one implementation,
// so an agent checkpoint and a human resume share the same format. Checkpoint
// is bounded state, never a transcript dump.

// opencode runs as a compiled standalone binary, so within its runtime
// `process.execPath` is the opencode executable (opencode.exe), NOT Node —
// spawning it with a script path just re-launches opencode. Resolve a real
// Node: an explicit override, then the runtime's PATH resolver (skipping WSL
// /mnt entries so a native node wins over the interop Windows node.exe), then
// a bare "node" as the last resort.
function nodeBin(): string {
  const override = process.env.OPENCODE_NODE
  if (override) return override
  const bun = (globalThis as any).Bun
  if (bun && typeof bun.which === "function") {
    const pathEnv = String(process.env.PATH || "")
    const native =
      process.platform === "linux"
        ? pathEnv.split(":").filter((p) => p && !p.startsWith("/mnt/")).join(":")
        : pathEnv
    const found = bun.which("node", native ? { PATH: native } : {}) || bun.which("node")
    if (found) return found
  }
  return "node"
}

// Follow a mid-session worktree (recorded by `backlog worktree` under
// `.serve/sessions/`) so the handoff is written where the feature actually
// lives, not the tree the session launched in. See tools/backlog.ts.
function rootOf(context: any): string {
  const base = (context?.worktree || context?.directory || process.cwd()) as string
  const sessionID = context?.sessionID ? String(context.sessionID) : ""
  if (!sessionID) return base
  try {
    const rec = fs.readFileSync(path.join(base, ".serve", "sessions", `${sessionID}.worktree`), "utf8").trim()
    if (rec && fs.existsSync(path.join(rec, ".agents"))) return rec
  } catch {
    /* no mid-session worktree recorded for this session */
  }
  return base
}

function run(context: any, args: string[]): string {
  const root = rootOf(context)
  const script = path.join(root, "scripts", "checkpoint.js")
  try {
    return execFileSync(nodeBin(), [script, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e: any) {
    return `checkpoint: ${e.message}\n${e.stderr || ""}`
  }
}

function items(value: unknown): string[] {
  return String(value || "")
    .split(/\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export const write = tool({
  description:
    "Write (or replace) the deterministic bounded-state checkpoint in `.agents/handoffs/<feature>.md` — objective/phase, completed + active work, files changed, contracts, facts, decisions, risks, next action. Use when approaching the turn/context budgets so a fresh session can resume from the checkpoint instead of the transcript. Rewriting identical state is a no-op; changed state increments checkpoint_count. Never invent a field — omit it.",
  args: {
    feature: tool.schema.string().describe("BACKLOG row ID or slug naming the handoff file, e.g. F-001"),
    objective: tool.schema.string().describe("the work unit's single objective (optional)"),
    phase: tool.schema.string().describe("current phase, e.g. implementing / verifying (optional)"),
    completed: tool.schema.string().describe("completed items, newline- or ';'-separated (optional)"),
    active: tool.schema.string().describe("in-flight dispatches/work, newline- or ';'-separated (optional)"),
    filesChanged: tool.schema.string().describe("changed files/paths, newline- or ';'-separated (optional)"),
    contracts: tool.schema.string().describe("shared contracts in play, newline- or ';'-separated (optional)"),
    facts: tool.schema.string().describe("known facts established this session, newline- or ';'-separated (optional)"),
    decisions: tool.schema.string().describe("decisions taken, newline- or ';'-separated (optional)"),
    risks: tool.schema.string().describe("known risks/open questions, newline- or ';'-separated (optional)"),
    nextAction: tool.schema.string().describe("the single next action for the resuming session (optional)"),
    session: tool.schema.string().describe("primary orchestrator session id from session_info (optional)"),
  },
  async execute(args, context) {
    const argv = ["write", "--feature", args.feature]
    if (args.objective) argv.push("--objective", args.objective)
    if (args.phase) argv.push("--phase", args.phase)
    if (args.nextAction) argv.push("--next-action", args.nextAction)
    if (args.session) argv.push("--session", args.session)
    for (const it of items(args.completed)) argv.push("--completed", it)
    for (const it of items(args.active)) argv.push("--active", it)
    for (const it of items(args.filesChanged)) argv.push("--files-changed", it)
    for (const it of items(args.contracts)) argv.push("--contracts", it)
    for (const it of items(args.facts)) argv.push("--facts", it)
    for (const it of items(args.decisions)) argv.push("--decisions", it)
    for (const it of items(args.risks)) argv.push("--risks", it)
    return run(context, argv)
  },
})

export const resume = tool({
  description:
    "Print a session's checkpoint block — the bounded state a fresh context resumes from (never the transcript). Fails loudly when the feature has no checkpoint yet.",
  args: {
    feature: tool.schema.string().describe("BACKLOG row ID or slug naming the handoff file, e.g. F-001"),
    json: tool.schema.boolean().describe("print the parsed state as JSON instead of markdown (optional)"),
  },
  async execute(args, context) {
    const argv = ["resume", "--feature", args.feature]
    if (args.json) argv.push("--json")
    return run(context, argv)
  },
})
