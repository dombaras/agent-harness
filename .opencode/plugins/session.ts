import type { Plugin } from "@opencode/plugin"
import toolLib from "../../scripts/qa/tool-lib.js"

// `session_info` — the join key between this session's handoff and observed
// provider telemetry. The orchestrator records the returned `session:` line in
// the handoff's `## Session metadata`; `node scripts/agent-report.js --cost`
// then joins the provider group (primary session + every subagent session) to
// it, giving real cost per feature / per shipped feature.
//
// Safe from a subagent too: the provider store is walked to the top ancestor
// session, and both the primary id (the join key) and the calling session id
// are reported. Never fabricates cost — an unreachable store reports
// "unavailable" and still returns the id. Node resolution + the mid-session
// worktree reroot live in scripts/qa/tool-lib.js.
//
// V2: registered from a plugin via `ctx.tool.transform`. The executor context has
// no `directory`/`worktree`, so the launch directory is captured in `setup` and
// paired with the call's sessionID; the effective tree is tool-lib's sessionRoot.

function observed(context: any, sessionID: string): any | null {
  const root = toolLib.sessionRoot(context, "")
  const out = toolLib.runScript(context, "scripts/qa/provider-stats.js", ["--session", sessionID, "--json", "--root", root], {
    timeout: 60000,
    label: "provider-stats",
  })
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

function int(n: any): string {
  return String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export default {
  id: "session-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "session_info",
        description:
          "Report this orchestrator session's id — the `session:` value to record in the handoff's Session metadata so `agent-report --cost` can join real cost/token/turns — plus any observed provider telemetry for this session (primary + subagent sessions). Never invents numbers: if the opencode store is unreachable it says so and still returns the id.",
        input: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        async execute(_input, context) {
          const sessionID = String(context.sessionID || "unknown")
          // V2's executor has no `directory`/`worktree`; rebuild the context the
          // shared tool-lib expects and report the effective root it resolves.
          const helper = {
            directory,
            sessionID: context.sessionID,
            agent: context.agent,
          }
          const stats = observed(helper, sessionID)
          const rootID = stats?.meta?.scope?.rootId
          const lines = [
            `session: ${rootID || sessionID}`,
            rootID && rootID !== sessionID ? `this_session: ${sessionID} (subagent of the primary above)` : null,
            `directory: ${helper.directory}`,
            `worktree: ${toolLib.sessionRoot(helper, "")}`,
            `agent: ${helper.agent}`,
          ].filter(Boolean) as string[]

          const totals = stats?.aggregates?.totals
          if (totals && totals.sessions > 0) {
            const tokens = totals.tokens || {}
            const share =
              totals.cacheReadShare == null ? "n/a" : `${(totals.cacheReadShare * 100).toFixed(1)}% of input`
            lines.push(
              `observed: cost $${Number(totals.cost || 0).toFixed(4)} · turns ${int(totals.turns)} · ` +
                `tokens in ${int(tokens.input)} / cache-read ${int(tokens.cacheRead)} (${share}) / out ${int(tokens.output)} / reasoning ${int(tokens.reasoning)} · ` +
                `${int(totals.sessions)} session(s)`
            )
          } else {
            lines.push("observed: unavailable (opencode store not reachable from this machine — the id above is still the join key)")
          }
          return { content: lines.join("\n") }
        },
      })
    })
  },
} satisfies Plugin
