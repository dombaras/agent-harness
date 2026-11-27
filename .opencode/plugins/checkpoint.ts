import type { Plugin } from "@opencode/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// Thin wrappers around the deterministic `scripts/checkpoint.js` CLI. The tool
// only shells out — the state block is written/replaced by one implementation,
// so an agent checkpoint and a human resume share the same format. Checkpoint
// is bounded state, never a transcript dump. Node resolution + the mid-session
// worktree reroot live in scripts/qa/tool-lib.js (one home for all tools).
//
// V2: registered from a plugin via `ctx.tool.transform`. The executor context has
// no `directory`/`worktree`, so the launch directory is captured in `setup` and
// paired with the call's sessionID for tool-lib's sessionRoot reroot.

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

export default {
  id: "checkpoint-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const h = (context: any) => ({
      directory,
      sessionID: context?.sessionID,
      agent: context?.agent,
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "checkpoint_write",
        description:
          "Write (or replace) the deterministic bounded-state checkpoint in `.agents/handoffs/<feature>.md` — objective/phase, completed + active work, files changed, contracts, facts, decisions, risks, next action. Use when approaching the turn/context budgets so a fresh session can resume from the checkpoint instead of the transcript. Rewriting identical state is a no-op; changed state increments checkpoint_count. Never invent a field — omit it.",
        input: {
          type: "object",
          properties: {
            feature: {
              type: "string",
              description: "BACKLOG row ID or slug naming the handoff file, e.g. F-001",
            },
            objective: {
              type: "string",
              description: "the work unit's single objective (optional)",
            },
            phase: {
              type: "string",
              description: "current phase, e.g. implementing / verifying (optional)",
            },
            completed: {
              type: "string",
              description: "completed items, newline- or ';'-separated (optional)",
            },
            active: {
              type: "string",
              description: "in-flight dispatches/work, newline- or ';'-separated (optional)",
            },
            filesChanged: {
              type: "string",
              description: "changed files/paths, newline- or ';'-separated (optional)",
            },
            contracts: {
              type: "string",
              description: "shared contracts in play, newline- or ';'-separated (optional)",
            },
            facts: {
              type: "string",
              description:
                "known facts established this session, newline- or ';'-separated (optional)",
            },
            decisions: {
              type: "string",
              description: "decisions taken, newline- or ';'-separated (optional)",
            },
            risks: {
              type: "string",
              description: "known risks/open questions, newline- or ';'-separated (optional)",
            },
            nextAction: {
              type: "string",
              description: "the single next action for the resuming session (optional)",
            },
            session: {
              type: "string",
              description: "primary orchestrator session id from session_info (optional)",
            },
          },
          required: ["feature"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const feature = requireFeature(input.feature, "write")
          const argv = ["write", "--feature", feature]
          if (input.objective) argv.push("--objective", input.objective)
          if (input.phase) argv.push("--phase", input.phase)
          if (input.nextAction) argv.push("--next-action", input.nextAction)
          if (input.session) argv.push("--session", input.session)
          for (const it of items(input.completed)) argv.push("--completed", it)
          for (const it of items(input.active)) argv.push("--active", it)
          for (const it of items(input.filesChanged)) argv.push("--files-changed", it)
          for (const it of items(input.contracts)) argv.push("--contracts", it)
          for (const it of items(input.facts)) argv.push("--facts", it)
          for (const it of items(input.decisions)) argv.push("--decisions", it)
          for (const it of items(input.risks)) argv.push("--risks", it)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "checkpoint_resume",
        description:
          "Print a bounded (<=3 KB) resume excerpt — objective/phase/next action plus a heading outline of the handoff, never the whole file or the transcript. A handoff without a `## Checkpoint` block yields a best-effort phase/next excerpt rather than failing. Omit `feature` to list the resumable checkpoints (the board's In-progress rows first). Fails loudly when no handoff exists for a named feature.",
        input: {
          type: "object",
          properties: {
            feature: {
              type: "string",
              description:
                "BACKLOG row ID or slug naming the handoff file, e.g. F-001 (omit to list)",
            },
            json: {
              type: "boolean",
              description:
                "print the parsed state as JSON instead of markdown (optional)",
            },
          },
          additionalProperties: false,
        },
        async execute(input, context) {
          const raw = String(input.feature ?? "").trim()
          const argv = raw ? ["resume", "--feature", requireFeature(raw, "resume")] : ["resume", "--list"]
          if (input.json) argv.push("--json")
          return { content: run(h(context), argv) }
        },
      })
    })
  },
} satisfies Plugin
