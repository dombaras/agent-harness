import type { Plugin } from "@opencode/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// Thin wrappers around the deterministic `scripts/backlog.js` CLI. The tools
// only shell out — they never edit BACKLOG.md themselves, so the agent-side and
// human-side write-paths share one implementation. node resolution and the
// mid-session-worktree reroot live in scripts/qa/tool-lib.js (one home, shared
// with the checkpoint/session tools).
//
// V2: these are registered from a plugin via `ctx.tool.transform`. The V2 tool
// executor has no `directory`/`worktree`, so the launch directory is captured in
// `setup` and paired with the call's sessionID — the same shape `sessionRoot`
// expects, keeping the mid-session-worktree reroot intact.

function run(context: any, args: string[]): string {
  return toolLib.runScript(context, "scripts/backlog.js", args, {
    marker: "BACKLOG.md",
    label: "backlog",
    env: { HARNESS_SESSION_ID: String(context?.sessionID || "") },
  })
}

export default {
  id: "backlog-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const h = (context: any) => ({ directory, sessionID: context?.sessionID, agent: context?.agent })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "backlog_list",
        description:
          "List the active BACKLOG.md rows (In progress + Open) — deterministic and bounded: true status counts + up to `limit` rows per section (default 40, 0 = all). Use instead of reading BACKLOG.md directly.",
        input: {
          type: "object",
          properties: {
            limit: { type: "string", description: "max rows shown per section (default 40; 0 = all) — raise only when the board's tail matters" },
          },
          required: [],
          additionalProperties: false,
        },
        async execute(input, context) {
          const argv = ["list"]
          if (input.limit) argv.push("--limit", input.limit)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "backlog_add",
        description:
          "Add one row to BACKLOG.md (Open section) — capture a found item / todo / bug. Validates priority, generates a unique ID, and (optionally) records its dependencies.",
        input: {
          type: "object",
          properties: {
            task: { type: "string", description: "short task description (what's known)" },
            priority: { type: "string", description: "P1..P4, optional (defaults P3)" },
            evidence: { type: "string", description: "pointer to evidence (file/log/ticket/words), optional" },
            epic: { type: "string", description: "epic key from the ## Epics registry, or ? for unassigned (optional, defaults ?)" },
            dependsOn: { type: "string", description: "comma-separated row IDs that must be archived first, optional (defaults ?)" },
          },
          required: ["task"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const argv = ["add", input.task]
          if (input.priority) argv.push("--p", input.priority)
          if (input.evidence) argv.push("--evidence", input.evidence)
          if (input.epic) argv.push("--epic", input.epic)
          if (input.dependsOn) argv.push("--depends-on", input.dependsOn)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "backlog_take",
        description:
          "Move a BACKLOG.md row Open/Queued -> In progress (pick it up), optionally linking the session handoff file.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "row ID, e.g. F-001" },
            handoff: { type: "string", description: "session handoff path, e.g. .agents/handoffs/F-001.md" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const argv = ["take", input.id]
          if (input.handoff) argv.push("--handoff", input.handoff)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "backlog_queue",
        description:
          "Move a BACKLOG.md row Open -> Queued (allocate it to a worker / ready-to-pull lane). Pull it back later with backlog_next.",
        input: {
          type: "object",
          properties: { id: { type: "string", description: "row ID, e.g. F-001" } },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(input, context) {
          return { content: run(h(context), ["queue", input.id]) }
        },
      })

      editor.add({
        name: "backlog_next",
        description:
          "Pick the next item off the Queue: report the top-priority unblocked Queued row, or (with take) atomically claim it — move it Queued -> In progress in a locked write and link the session handoff, so two sessions can never pick the same row. This is the primitive behind /next; always take to claim before working.",
        input: {
          type: "object",
          properties: {
            take: { type: "boolean", description: "when true, move the top Queued row to In progress (default: dry-run, just report it)" },
            handoff: { type: "string", description: "session handoff path when taking, e.g. .agents/handoffs/F-001.md" },
          },
          required: [],
          additionalProperties: false,
        },
        async execute(input, context) {
          const argv = ["next"]
          if (input.take) argv.push("--take")
          if (input.handoff) argv.push("--handoff", input.handoff)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "backlog_archive",
        description:
          "Move a BACKLOG.md row to Archive (shipped · done) — call when a task ships.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "row ID" },
            closed: { type: "string", description: "closed note, e.g. shipped + commit/date" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const argv = ["archive", input.id]
          if (input.closed) argv.push("--closed", input.closed)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "backlog_freeze",
        description:
          "Move a BACKLOG.md row to Frozen (parked, not deleted) — a why and/or reopen condition is required.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "row ID" },
            why: { type: "string", description: "why frozen" },
            reopen: { type: "string", description: "reopen condition" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const argv = ["freeze", input.id]
          if (input.why) argv.push("--why", input.why)
          if (input.reopen) argv.push("--reopen", input.reopen)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "backlog_epic",
        description:
          "Assign/reassign the epic of a BACKLOG.md row in place (any section). <to> must be a key in the ## Epics registry or ? (unassigned).",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "row ID, e.g. F-001" },
            to: { type: "string", description: "epic key (from ## Epics) or ? for unassigned" },
          },
          required: ["id", "to"],
          additionalProperties: false,
        },
        async execute(input, context) {
          return { content: run(h(context), ["epic", input.id, "--to", input.to]) }
        },
      })

      editor.add({
        name: "backlog_epic_add",
        description:
          "Add an epic to the ## Epics registry in BACKLOG.md — a logical container (key/label/goal) that work rows group under. No code change required.",
        input: {
          type: "object",
          properties: {
            key: { type: "string", description: "stable slug key, e.g. metrics" },
            label: { type: "string", description: "human label, e.g. Metrics & observability" },
            goal: { type: "string", description: "one-line goal/scope of the epic, optional" },
          },
          required: ["key", "label"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const argv = ["epic-add", input.key, "--label", input.label]
          if (input.goal) argv.push("--goal", input.goal)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "backlog_worktree",
        description:
          "Create an isolated git worktree + feature branch for a backlog item so concurrent sessions don't collide on one working tree. Run it from the MAIN tree before starting ANY feature — main stays board + shippable code only, every feature works in its own worktree.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "row ID, e.g. F-060" },
            branch: { type: "string", description: "branch name (defaults to the lowercased id)" },
            dir: { type: "string", description: "worktree directory (defaults to <repo>/../.worktrees/<repo>/<id>)" },
            handoff: { type: "string", description: "session handoff path recorded in the row (optional)" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const argv = ["worktree", input.id]
          if (input.branch) argv.push("--branch", input.branch)
          if (input.dir) argv.push("--dir", input.dir)
          if (input.handoff) argv.push("--handoff", input.handoff)
          return { content: run(h(context), argv) }
        },
      })

      editor.add({
        name: "backlog_depends",
        description:
          "Set/clear a BACKLOG.md row's \"Depends on\" cell (Open/Queued only) — a comma-separated list of row IDs that must be archived before this row is picked up. next/take/worktree skip or refuse a row whose dependencies aren't archived. A dependency cycle is rejected.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "row ID, e.g. F-052" },
            on: { type: "string", description: "comma-separated row IDs it depends on, or ? to clear" },
          },
          required: ["id", "on"],
          additionalProperties: false,
        },
        async execute(input, context) {
          return { content: run(h(context), ["depends", input.id, "--on", input.on]) }
        },
      })

      editor.add({
        name: "backlog_owns",
        description:
          "Record the files/globs a backlog row owns in .agents/memory/owned-files.md — feeds the cross-session overlap check in test:concurrency (two In-progress rows must not own the same file).",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "row ID, e.g. F-052" },
            files: { type: "string", description: 'comma-separated globs/paths, e.g. "scripts/test-*.ts, scripts/qa/routes.js", or ? to clear' },
          },
          required: ["id", "files"],
          additionalProperties: false,
        },
        async execute(input, context) {
          return { content: run(h(context), ["owns", input.id, "--files", input.files]) }
        },
      })
    })
  },
} satisfies Plugin
