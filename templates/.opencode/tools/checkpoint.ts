import { tool } from "@opencode-ai/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// Thin wrappers around the deterministic `scripts/checkpoint.js` CLI. The tool
// only shells out — the state block is written/replaced by one implementation,
// so an agent checkpoint and a human resume share the same format. Checkpoint
// is bounded state, never a transcript dump. Node resolution + the mid-session
// worktree reroot live in scripts/qa/tool-lib.js (one home for all tools).

function run(context: any, args: string[]): string {
  return toolLib.runScript(context, "scripts/checkpoint.js", args, {
    marker: ".agents",
    label: "checkpoint",
  })
}

function items(value: unknown): string[] {
  return String(value || "")
    .split(/\r?\n|;/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// An unset `feature` reaches the wrapper as the literal string "undefined" (the
// only shape the runner forwards); the CLI now rejects it, but fail here first
// with an actionable message instead of a stray `.agents/handoffs/undefined.md`.
const RESERVED_FEATURE = new Set(["undefined", "null", "none", "nan", "nil"])
function requireFeature(raw: unknown, verb: string): string {
  const feature = String(raw ?? "").trim()
  if (!feature || RESERVED_FEATURE.has(feature.toLowerCase())) {
    throw new Error(
      `checkpoint ${verb} needs the feature id (e.g. "F-001") — got ${JSON.stringify(raw ?? "")}. ` +
        `Pass the BACKLOG row (or slug) you are checkpointing; never the literal string "undefined".`
    )
  }
  return feature
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
    const feature = requireFeature(args.feature, "write")
    const argv = ["write", "--feature", feature]
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
    const feature = requireFeature(args.feature, "resume")
    const argv = ["resume", "--feature", feature]
    if (args.json) argv.push("--json")
    return run(context, argv)
  },
})
