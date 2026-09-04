import { tool } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import path from "node:path"

// Thin wrappers around the deterministic `scripts/backlog.js` CLI. The tools
// only shell out — they never edit BACKLOG.md themselves, so the agent-side and
// human-side write-paths share one implementation.

function rootOf(context: any): string {
  return (context?.worktree || context?.directory || process.cwd()) as string
}

function run(context: any, args: string[]): string {
  const script = path.join(rootOf(context), "scripts", "backlog.js")
  try {
    return execFileSync("node", [script, ...args], {
      cwd: rootOf(context),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (e: any) {
    return `backlog: ${e.message}\n${e.stderr || ""}`
  }
}

export const list = tool({
  description:
    "List the active BACKLOG.md rows (In progress + Open) — deterministic, no filtering. Use instead of reading BACKLOG.md directly.",
  args: {},
  async execute(_args, context) {
    return run(context, ["list", "--full"])
  },
})

export const add = tool({
  description:
    "Add one row to BACKLOG.md (Open section) — capture a found item / todo / bug. Validates priority and generates a unique ID.",
  args: {
    task: tool.schema.string().describe("short task description (what's known)"),
    priority: tool.schema.string().describe("P1..P4, optional (defaults P3)"),
    evidence: tool.schema.string().describe("pointer to evidence (file/log/ticket/words), optional"),
  },
  async execute(args, context) {
    const argv = ["add", args.task]
    if (args.priority) argv.push("--p", args.priority)
    if (args.evidence) argv.push("--evidence", args.evidence)
    return run(context, argv)
  },
})

export const take = tool({
  description:
    "Move a BACKLOG.md row Open -> In progress (pick it up), optionally linking the session handoff file.",
  args: {
    id: tool.schema.string().describe("row ID, e.g. F-001"),
    handoff: tool.schema.string().describe("session handoff path, e.g. .agents/handoffs/F-001.md"),
  },
  async execute(args, context) {
    const argv = ["take", args.id]
    if (args.handoff) argv.push("--handoff", args.handoff)
    return run(context, argv)
  },
})

export const archive = tool({
  description:
    "Move a BACKLOG.md row to Archive (shipped · done) — call when a task ships.",
  args: {
    id: tool.schema.string().describe("row ID"),
    closed: tool.schema.string().describe("closed note, e.g. shipped + commit/date"),
  },
  async execute(args, context) {
    const argv = ["archive", args.id]
    if (args.closed) argv.push("--closed", args.closed)
    return run(context, argv)
  },
})

export const freeze = tool({
  description:
    "Move a BACKLOG.md row to Frozen (parked, not deleted) — a why and/or reopen condition is required.",
  args: {
    id: tool.schema.string().describe("row ID"),
    why: tool.schema.string().describe("why frozen"),
    reopen: tool.schema.string().describe("reopen condition"),
  },
  async execute(args, context) {
    const argv = ["freeze", args.id]
    if (args.why) argv.push("--why", args.why)
    if (args.reopen) argv.push("--reopen", args.reopen)
    return run(context, argv)
  },
})

export const worktree = tool({
  description:
    "Create an isolated git worktree + feature branch for a backlog item so concurrent sessions don't collide on one working tree. Run it from the MAIN tree before starting a second concurrent feature.",
  args: {
    id: tool.schema.string().describe("row ID, e.g. F-060"),
    branch: tool.schema.string().describe("branch name (defaults to the lowercased id)"),
  },
  async execute(args, context) {
    const argv = ["worktree", args.id]
    if (args.branch) argv.push("--branch", args.branch)
    return run(context, argv)
  },
})
