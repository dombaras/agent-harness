import { tool } from "@opencode-ai/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `wait` — block (bounded) for a detached job / CI run / log line / URL to reach
// a terminal state, instead of the agent's `sleep N; grep log` or `gh run watch`
// polling loop. The 2026-09 LibraryOS recon measured 98 `sleep` + 81 `gh` polls
// in 30 days; a blind sleep either wastes minutes or forces another poll. This
// wraps `scripts/wait-for.js`, which reuses the same `ci-wait-lib.js` the
// lander (`ship.js`) uses.
//
// BOUNDED by design: a `--timeout` (default 20 min, hard-capped here at 30 min)
// is required, so a wedged target can never hang the session. Returns the
// waiter's stdout and its exit status via the script output.
//
// It runs the child ASYNC (toolLib.runScriptAsync) rather than blocking the
// runtime: an `execFileSync` wait froze opencode's whole event loop, so the
// `job-notify` plugin's progress interval could not tick and a healthy detached
// run looked frozen until the wait returned (F-296). Spawning keeps the plugin
// (toasts + first-failure/completion wakes) live while the agent blocks here.

export const wait = tool({
  description:
    "Block (bounded) until a detached job, CI run, log line, URL, or TCP port reaches a terminal state — then return. Use it INSTEAD of `sleep N; grep log` polling or `gh run watch`. Modes: job (record.json), events (events.jsonl), ci (a commit's CI run), health (url), port (n), file+grep (a log line). Always timeout-bounded (default 20 min); never hangs.",
  args: {
    mode: tool.schema
      .enum(["job", "events", "ci", "health", "port", "file"])
      .describe("what to wait on"),
    target: tool.schema
      .string()
      .describe("the mode's target: job record path, events path, commit sha (ci), url, port, or log path (file)"),
    grep: tool.schema.string().describe("regex to match when mode=file (optional otherwise)"),
    timeout: tool.schema.number().describe("max seconds to wait (default 1200; hard cap 1800)"),
    poll: tool.schema.number().describe("poll interval seconds (default 5)"),
  },
  async execute(args, context) {
    const root = toolLib.sessionRoot(context, "")
    const argv = ["--root", root]
    const mode = String(args.mode || "")
    if (mode === "job") argv.push("--job", args.target)
    else if (mode === "events") argv.push("--events", args.target)
    else if (mode === "ci") {
      argv.push("--ci")
      if (args.target) argv.push("--commit", args.target)
    } else if (mode === "health") argv.push("--health", args.target)
    else if (mode === "port") argv.push("--port", String(args.target))
    else if (mode === "file") {
      argv.push("--file", args.target)
      if (args.grep) argv.push("--grep", args.grep)
    }
    const timeout = Math.min(Math.max(Number(args.timeout) || 1200, 1), 1800)
    argv.push("--timeout", String(timeout))
    if (args.poll) argv.push("--poll", String(args.poll))
    const res = await toolLib.runScriptAsync(context, "scripts/wait-for.js", argv, {
      label: "wait",
      timeout: (timeout + 60) * 1000,
    })
    if (res.error) return `${res.error}\n${res.stderr || ""}`.trim()
    const body = (res.stdout || "").trim()
    const tail = (res.stderr || "").trim()
    return [body, tail].filter(Boolean).join("\n") || `wait: exit ${res.code}`
  },
})
