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
    "List the active BACKLOG.md rows (In progress + Open) — deterministic and bounded: true status counts + up to `limit` rows per section (default 40, 0 = all). Use instead of reading BACKLOG.md directly.",
  args: {
    limit: tool.schema.string().describe("max rows shown per section (default 40; 0 = all) — raise only when the board's tail matters"),
  },
  async execute(args, context) {
    const argv = ["list"]
    if (args.limit) argv.push("--limit", args.limit)
    return run(context, argv)
  },
})

export const add = tool({
  description:
    "Add one row to BACKLOG.md (Open section) — capture a found item / todo / bug. Validates priority, generates a unique ID, and (optionally) records its dependencies.",
  args: {
    task: tool.schema.string().describe("short task description (what's known)"),
    priority: tool.schema.string().describe("P1..P4, optional (defaults P3)"),
    evidence: tool.schema.string().describe("pointer to evidence (file/log/ticket/words), optional"),
    epic: tool.schema.string().describe("epic key from the ## Epics registry, or ? for unassigned (optional, defaults ?)"),
    dependsOn: tool.schema.string().describe("comma-separated row IDs that must be archived first, optional (defaults ?)"),
  },
  async execute(args, context) {
    const argv = ["add", args.task]
    if (args.priority) argv.push("--p", args.priority)
    if (args.evidence) argv.push("--evidence", args.evidence)
    if (args.epic) argv.push("--epic", args.epic)
    if (args.dependsOn) argv.push("--depends-on", args.dependsOn)
    return run(context, argv)
  },
})

export const take = tool({
  description:
    "Move a BACKLOG.md row Open/Queued -> In progress (pick it up), optionally linking the session handoff file.",
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

export const queue = tool({
  description:
    "Move a BACKLOG.md row Open -> Queued (allocate it to a worker / ready-to-pull lane). Pull it back later with backlog_next.",
  args: {
    id: tool.schema.string().describe("row ID, e.g. F-001"),
  },
  async execute(args, context) {
    return run(context, ["queue", args.id])
  },
})

export const next = tool({
  description:
    "Pick the next item off the Queue: report the top-priority unblocked Queued row, or (with take) atomically claim it — move it Queued -> In progress in a locked write and link the session handoff, so two sessions can never pick the same row. This is the primitive behind /next; always take to claim before working.",
  args: {
    take: tool.schema.boolean().describe("when true, move the top Queued row to In progress (default: dry-run, just report it)"),
    handoff: tool.schema.string().describe("session handoff path when taking, e.g. .agents/handoffs/F-001.md"),
  },
  async execute(args, context) {
    const argv = ["next"]
    if (args.take) argv.push("--take")
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

export const epic = tool({
  description:
    "Assign/reassign the epic of a BACKLOG.md row in place (any section). <to> must be a key in the ## Epics registry or ? (unassigned).",
  args: {
    id: tool.schema.string().describe("row ID, e.g. F-001"),
    to: tool.schema.string().describe("epic key (from ## Epics) or ? for unassigned"),
  },
  async execute(args, context) {
    const argv = ["epic", args.id, "--to", args.to]
    return run(context, argv)
  },
})

export const epicAdd = tool({
  description:
    "Add an epic to the ## Epics registry in BACKLOG.md — a logical container (key/label/goal) that work rows group under. No code change required.",
  args: {
    key: tool.schema.string().describe("stable slug key, e.g. metrics"),
    label: tool.schema.string().describe("human label, e.g. Metrics & observability"),
    goal: tool.schema.string().describe("one-line goal/scope of the epic, optional"),
  },
  async execute(args, context) {
    const argv = ["epic-add", args.key, "--label", args.label]
    if (args.goal) argv.push("--goal", args.goal)
    return run(context, argv)
  },
})

export const worktree = tool({
  description:
    "Create an isolated git worktree + feature branch for a backlog item so concurrent sessions don't collide on one working tree. Run it from the MAIN tree before starting ANY feature — main stays board + shippable code only, every feature works in its own worktree.",
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

export const depends = tool({
  description:
    "Set/clear a BACKLOG.md row's \"Depends on\" cell (Open/Queued only) — a comma-separated list of row IDs that must be archived before this row is picked up. next/take/worktree skip or refuse a row whose dependencies aren't archived.",
  args: {
    id: tool.schema.string().describe("row ID, e.g. F-052"),
    on: tool.schema.string().describe("comma-separated row IDs it depends on, or ? to clear"),
  },
  async execute(args, context) {
    return run(context, ["depends", args.id, "--on", args.on])
  },
})

export const owns = tool({
  description:
    "Record the files/globs a backlog row owns in .agents/memory/owned-files.md — feeds the cross-session overlap check in test:concurrency (two In-progress rows must not own the same file).",
  args: {
    id: tool.schema.string().describe("row ID, e.g. F-052"),
    files: tool.schema.string().describe('comma-separated globs/paths, e.g. "scripts/test-*.ts, scripts/qa/routes.js", or ? to clear'),
  },
  async execute(args, context) {
    return run(context, ["owns", args.id, "--files", args.files])
  },
})
