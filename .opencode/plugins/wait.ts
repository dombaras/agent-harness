import type { Plugin } from "@opencode/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `wait` — block (bounded) for a detached job / CI run / log line / URL to reach
// a terminal state, instead of the agent's `sleep N; grep log` or `gh run watch`
// polling loop. The 2026-09 LibraryOS recon measured 98 `sleep` + 81 `gh` polls
// in 30 days; a blind sleep either wastes minutes or forces another poll. This
// wraps `scripts/wait-for.js`, which reuses the same `ci-wait-lib.js` the
// lander (`ship.js`) uses.
//
// BOUNDED by design: a `--timeout` (default 20 min, hard-capped here at 45 min)
// is required, so a wedged target can never hang the session. Returns the
// waiter's stdout and its exit status via the script output. The 45-min cap is
// above the longest known target — a full 26-journey mobile device matrix runs
// ~33 min on a software renderer, so a 30-min cap forced a second wait (F-296).
//
// It runs the child ASYNC (toolLib.runScriptAsync) rather than blocking the
// runtime: an `execFileSync` wait froze opencode's whole event loop, so the
// `job-notify` plugin's progress interval could not tick and a healthy detached
// run looked frozen until the wait returned (F-296). Spawning keeps the plugin
// (toasts + first-failure/completion wakes) live while the agent blocks here.
//
// V2: registered from a plugin via `ctx.tool.transform`. The executor context has
// no `directory`/`worktree`, so the launch directory is captured in `setup` and
// paired with the call's sessionID for tool-lib's sessionRoot reroot.

export default {
  id: "wait-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const h = (context: any) => ({
      directory,
      sessionID: context?.sessionID,
      agent: context?.agent,
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "wait",
        description:
          "Block (bounded) until a detached job, CI run, log line, URL, or TCP port reaches a terminal state — then return. Use it INSTEAD of `sleep N; grep log` polling or `gh run watch`. Modes: job (record.json), events (events.jsonl), ci (a commit's CI run), health (url), port (n), file+grep (a log line). Always timeout-bounded (default 20 min); never hangs.",
        input: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["job", "events", "ci", "health", "port", "file"],
              description: "what to wait on",
            },
            target: {
              type: "string",
              description:
                "the mode's target: job record path, events path, commit sha (ci), url, port, or log path (file)",
            },
            grep: {
              type: "string",
              description: "regex to match when mode=file (optional otherwise)",
            },
            timeout: {
              type: "number",
              description: "max seconds to wait (default 1200; hard cap 2700)",
            },
            poll: {
              type: "number",
              description: "poll interval seconds (default 5)",
            },
          },
          required: ["mode", "target"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const helper = h(context)
          const root = toolLib.sessionRoot(helper, "")
          const argv = ["--root", root]
          const mode = String(input.mode || "")
          if (mode === "job") argv.push("--job", input.target)
          else if (mode === "events") argv.push("--events", input.target)
          else if (mode === "ci") {
            argv.push("--ci")
            if (input.target) argv.push("--commit", input.target)
          } else if (mode === "health") argv.push("--health", input.target)
          else if (mode === "port") argv.push("--port", String(input.target))
          else if (mode === "file") {
            argv.push("--file", input.target)
            if (input.grep) argv.push("--grep", input.grep)
          }
          const timeout = Math.min(Math.max(Number(input.timeout) || 1200, 1), 2700)
          argv.push("--timeout", String(timeout))
          if (input.poll) argv.push("--poll", String(input.poll))
          const res = await toolLib.runScriptAsync(helper, "scripts/wait-for.js", argv, {
            label: "wait",
            timeout: (timeout + 60) * 1000,
          })
          if (res.error) return { content: `${res.error}\n${res.stderr || ""}`.trim() }
          const body = (res.stdout || "").trim()
          const tail = (res.stderr || "").trim()
          return { content: [body, tail].filter(Boolean).join("\n") || `wait: exit ${res.code}` }
        },
      })
    })
  },
} satisfies Plugin
