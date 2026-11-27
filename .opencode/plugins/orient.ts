import type { Plugin } from "@opencode/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `orient` — one call that returns everything a session re-derives by hand at
// resume/claim time: the tree root + branch + HEAD + dirty count, the feature,
// the checkpoint, the board rows (In progress + next queued), owned files, the
// live `serve.js` jobs + capacity verdict, the last device-run summary, and the
// harness version. The 2026-09 LibraryOS recon measured a single F-291 resume
// spending 21 orientation calls (`git rev-parse`/`branch`/`status`, memory
// reads, `serve.js list`, `test:capacity`, checkpoint) before any real work; the
// exact `git rev-parse --show-toplevel` shape ran 114 times across 103 sessions.
//
// Read-only and best-effort: a source that is missing (no checkpoint, no lease,
// no `.serve/`) is reported `unavailable`, never invented. Node resolution + the
// mid-session worktree reroot live in scripts/qa/tool-lib.js.
//
// V2: registered from a plugin via `ctx.tool.transform`. The executor context has
// no `directory`/`worktree`, so the launch directory is captured in `setup` and
// paired with the call's sessionID for tool-lib's sessionRoot reroot.

export default {
  id: "orient-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const h = (context: any) => ({
      directory,
      sessionID: context?.sessionID,
      agent: context?.agent,
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "orient",
        description:
          "One-call session orientation: git tree/branch/HEAD/dirty, the active feature, its checkpoint (bounded excerpt: phase + next action + top-level sections), board In-progress + next-queued rows, owned files, live serve jobs + machine-capacity verdict, the last mobile-E2E run, and the harness version. Use it at session start / resume instead of a pile of `git rev-parse`/`status`, `serve.js list`, `test:capacity`, and memory reads. Read-only; missing sources are reported `unavailable`.",
        input: {
          type: "object",
          properties: {
            feature: {
              type: "string",
              description:
                "backlog row ID to orient on (optional; inferred from the board/branch when omitted)",
            },
            json: {
              type: "boolean",
              description:
                "return the raw JSON object instead of the human summary (optional)",
            },
          },
          required: [],
          additionalProperties: false,
        },
        async execute(input, context) {
          const helper = h(context)
          const argv = ["--root", toolLib.sessionRoot(helper, "")]
          if (input.feature) argv.push("--feature", input.feature)
          if (input.json) argv.push("--json")
          return {
            content: toolLib.runScript(helper, "scripts/orient.js", argv, {
              label: "orient",
              timeout: 30000,
            }),
          }
        },
      })
    })
  },
} satisfies Plugin
