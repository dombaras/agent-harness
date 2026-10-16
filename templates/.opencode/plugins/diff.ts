import type { Plugin } from "@opencode/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `diff` — a bounded change view. The 2026-10-16 field review found the thinker
// personas (qa-architect/planner/system-architect) have no shell and no diff
// capability: qa-architect logged 799 `Read` / 132 `Grep` / 0 bash and 10
// `Maximum steps` truncations, because "inspect the diff" is done by mass-reading
// whole files. This returns the changed paths + hunks in ONE bounded call
// (`--limit` lines, default 400), and lists untracked files. Prefer it over
// shell `git diff` and over reading a file to see what changed.
//
// V2: registered from a plugin via `ctx.tool.transform`; the launch directory is
// captured in `setup` and paired with the call's sessionID for the sessionRoot
// reroot (same pairing as `where`/`gates`).

export default {
  id: "diff-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const h = (context: any) => ({
      directory,
      sessionID: context?.sessionID,
      agent: context?.agent,
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "diff",
        description:
          "Show the current change as a bounded diff (changed paths + hunks, capped at --limit lines; untracked files listed). Defaults to the working tree vs HEAD. Use it to inspect a change instead of reading whole files or shelling out to `git diff`. Modes: default (hunks), stat (numstat summary), files (name-status list). Options: staged, base <ref>, paths <a,b>, unified <n>.",
        input: {
          type: "object",
          properties: {
            base: {
              type: "string",
              description: "diff against this ref instead of HEAD (e.g. origin/main, a feature branch, a SHA)",
            },
            staged: {
              type: "boolean",
              description: "diff the staged (index) changes only (`git diff --cached`)",
            },
            paths: {
              type: "string",
              description: "comma/space-separated path scope (else the whole change)",
            },
            stat: {
              type: "boolean",
              description: "summary only (`git diff --stat`) — cheapest for a large change",
            },
            files: {
              type: "boolean",
              description: "changed paths + status only (name-status)",
            },
            unified: {
              type: "number",
              description: "context lines per hunk (default 3, max 50)",
            },
            limit: {
              type: "number",
              description: "max output lines (default 400)",
            },
          },
          required: [],
          additionalProperties: false,
        },
        async execute(input, context) {
          const helper = h(context)
          const argv = ["--root", toolLib.sessionRoot(helper, "")]
          if (input.base) argv.push("--base", String(input.base))
          if (input.staged) argv.push("--staged")
          if (input.paths) argv.push("--paths", String(input.paths))
          if (input.stat) argv.push("--stat")
          if (input.files) argv.push("--files")
          if (input.unified) argv.push("--unified", String(input.unified))
          if (input.limit) argv.push("--limit", String(input.limit))
          return {
            content: toolLib.runScript(helper, "scripts/qa/diff.js", argv, {
              label: "diff",
              timeout: 30000,
            }),
          }
        },
      })
    })
  },
} satisfies Plugin
