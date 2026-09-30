import { tool } from "@opencode-ai/plugin"
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

export const orient = tool({
  description:
    "One-call session orientation: git tree/branch/HEAD/dirty, the active feature, its checkpoint (phase + next action), board In-progress + next-queued rows, owned files, live serve jobs + machine-capacity verdict, the last mobile-E2E run, and the harness version. Use it at session start / resume instead of a pile of `git rev-parse`/`status`, `serve.js list`, `test:capacity`, and memory reads. Read-only; missing sources are reported `unavailable`.",
  args: {
    feature: tool.schema.string().describe("backlog row ID to orient on (optional; inferred from the board/branch when omitted)"),
    json: tool.schema.boolean().describe("return the raw JSON object instead of the human summary (optional)"),
  },
  async execute(args, context) {
    const argv = ["--root", toolLib.sessionRoot(context, "")]
    if (args.feature) argv.push("--feature", args.feature)
    if (args.json) argv.push("--json")
    return toolLib.runScript(context, "scripts/orient.js", argv, {
      label: "orient",
      timeout: 30000,
    })
  },
})
