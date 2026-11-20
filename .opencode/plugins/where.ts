import type { Plugin } from "@opencode/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `where` — a bounded symbol/owner lookup. The 2026-10 LibraryOS recon measured
// `grep` as the most common shell command (1,081 / 14 days) and 95 failed reads
// on guessed paths. This returns a bounded `file:line: text` hit list for a term
// (index-first via `git grep`; tracked files only, never node_modules/build),
// annotates each hit with the feature row(s) that own the file, and offers an
// inverse `--owner <glob>` mode. Prefer it over shell `grep` for locating a
// symbol; use `Grep` for a bounded pattern read.
//
// V2: registered from a plugin via `ctx.tool.transform`. The executor context has
// no `directory`/`worktree`, so the launch directory is captured in `setup` and
// paired with the call's sessionID for tool-lib's sessionRoot reroot.

export default {
  id: "where-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const h = (context: any) => ({
      directory,
      sessionID: context?.sessionID,
      agent: context?.agent,
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "where",
        description:
          "Locate a symbol/term as a bounded `file:line: text` list (index-first, tracked files only), annotated with the backlog row(s) that own each hit file. Modes: default content search; files (match paths); owner (which rows own a glob). Use it instead of shell `grep` for symbol lookup.",
        input: {
          type: "object",
          properties: {
            term: {
              type: "string",
              description: "the symbol/term to locate (omit when using owner)",
            },
            files: {
              type: "boolean",
              description: "match file paths instead of file contents",
            },
            owner: {
              type: "string",
              description: "inverse mode: list the backlog row(s) that own this glob/path",
            },
            limit: {
              type: "number",
              description: "max hits (default 40)",
            },
          },
          required: [],
          additionalProperties: false,
        },
        async execute(input, context) {
          const helper = h(context)
          const argv = ["--root", toolLib.sessionRoot(helper, "")]
          if (input.owner) argv.push("--owner", input.owner)
          if (input.term) argv.push(input.term)
          if (input.files) argv.push("--files")
          if (input.limit) argv.push("--limit", String(input.limit))
          return {
            content: toolLib.runScript(helper, "scripts/qa/where.js", argv, {
              label: "where",
              timeout: 30000,
            }),
          }
        },
      })
    })
  },
} satisfies Plugin
