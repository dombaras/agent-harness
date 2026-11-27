import type { Plugin } from "@opencode/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `outline` — progressive disclosure for large markdown state docs (F-059).
// Returns a bounded heading outline (line range + depth) so an agent can open
// ONE section of `.agents/reviews/**/FINDINGS-REGISTER.md`, a handoff, or the
// rulebook with `read` offset/limit instead of paying for the whole file. The
// context-guard plugin blocks an unranged read of a large `.agents/**` doc and
// names this tool in the refusal.
//
// V2: registered from a plugin via `ctx.tool.transform`; the launch directory
// is captured in `setup` and paired with the call's sessionID for tool-lib's
// sessionRoot reroot (same contract as `where`/`checkpoint`).

export default {
  id: "outline-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const h = (context: any) => ({
      directory,
      sessionID: context?.sessionID,
      agent: context?.agent,
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "outline",
        description:
          "List a markdown file's headings with their line ranges (L<start>-<end>) and byte size. Use it before reading a large markdown state doc — `.agents/reviews/**`, handoffs, rulebook, qa plans — then read only the section you need with `read` offset/limit. Bounded and cheap (no file body).",
        input: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "markdown file path, relative to the project root",
            },
            maxLevel: {
              type: "number",
              description: "deepest heading level to show (default 6)",
            },
            max: {
              type: "number",
              description: "max headings to print (default 40)",
            },
          },
          required: ["filePath"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const helper = h(context)
          const argv = [
            "--root",
            toolLib.sessionRoot(helper, ""),
            "--max-level",
            String(input.maxLevel || 6),
            "--max",
            String(input.max || 40),
            String(input.filePath || ""),
          ]
          return {
            content: toolLib.runScript(helper, "scripts/qa/outline.js", argv, {
              label: "outline",
              timeout: 15000,
            }),
          }
        },
      })
    })
  },
} satisfies Plugin
