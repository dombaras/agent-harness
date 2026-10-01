import { tool } from "@opencode-ai/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `where` — a bounded symbol/owner lookup. The 2026-10 LibraryOS recon measured
// `grep` as the most common shell command (1,081 / 14 days) and 95 failed reads
// on guessed paths. This returns a bounded `file:line: text` hit list for a term
// (index-first via `git grep`; tracked files only, never node_modules/build),
// annotates each hit with the feature row(s) that own the file, and offers an
// inverse `--owner <glob>` mode. Prefer it over shell `grep` for locating a
// symbol; use `Grep` for a bounded pattern read.

export const where = tool({
  description:
    "Locate a symbol/term as a bounded `file:line: text` list (index-first, tracked files only), annotated with the backlog row(s) that own each hit file. Modes: default content search; files (match paths); owner (which rows own a glob). Use it instead of shell `grep` for symbol lookup.",
  args: {
    term: tool.schema.string().describe("the symbol/term to locate (omit when using owner)"),
    files: tool.schema.boolean().describe("match file paths instead of file contents"),
    owner: tool.schema.string().describe("inverse mode: list the backlog row(s) that own this glob/path"),
    limit: tool.schema.number().describe("max hits (default 40)"),
  },
  async execute(args, context) {
    const argv = ["--root", toolLib.sessionRoot(context, "")]
    if (args.owner) argv.push("--owner", args.owner)
    if (args.term) argv.push(args.term)
    if (args.files) argv.push("--files")
    if (args.limit) argv.push("--limit", String(args.limit))
    return toolLib.runScript(context, "scripts/qa/where.js", argv, { label: "where", timeout: 30000 })
  },
})
