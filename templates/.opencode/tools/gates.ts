import { tool } from "@opencode-ai/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `gates` — run the harness gate battery as one call. The 2026-10 LibraryOS
// recon measured ~700 individual gate invocations in 14 days (tsc 125,
// test:quick 120, test:qa-plan 50 …): each a separate tool round-trip with its
// own banner. This runs a phase in order, stops at the first failure, and
// returns a compact PASS/FAIL summary. It wraps scripts/qa/run-gates.js, the
// SAME list the pre-push hook runs (`--phase=pre-push`), so the two can never
// drift. A gate the project has not wired is skipped, never failed.
//
// Async (runScriptAsync): a full battery can run minutes, and a synchronous
// execFileSync would freeze opencode's event loop the way the old `wait` did.

export const gates = tool({
  description:
    "Run the harness gate battery in one call: phases pre-push (process + quick), process (dispatch/governance/concurrency/capacity/backlog/wiring/integrate/qa-plan/product/docs/quality), quick (lint:hooks/test:schema/test:quick), or all. Stops at the first failure by default and prints a compact per-gate PASS/FAIL summary. Use it instead of running the gates one shell command at a time. Unwired gates are skipped, never failed.",
  args: {
    phase: tool.schema
      .enum(["pre-push", "process", "quick", "all"])
      .describe("which gate phase to run (default pre-push)"),
    base: tool.schema.string().describe("base ref for the diff-scoped gates (default origin/main)"),
    continueOnError: tool.schema.boolean().describe("run every gate even after one fails (default false)"),
  },
  async execute(args, context) {
    const argv = ["--root", toolLib.sessionRoot(context, "")]
    if (args.phase) argv.push("--phase", args.phase)
    if (args.base) argv.push("--base", args.base)
    if (args.continueOnError) argv.push("--continue")
    const res = await toolLib.runScriptAsync(context, "scripts/qa/run-gates.js", argv, {
      label: "gates",
      timeout: 45 * 60 * 1000,
    })
    if (res.error) return `${res.error}\n${res.stderr || ""}`.trim()
    const body = (res.stdout || "").trim()
    const tail = (res.stderr || "").trim()
    return [body, tail].filter(Boolean).join("\n") || `gates: exit ${res.code}`
  },
})
