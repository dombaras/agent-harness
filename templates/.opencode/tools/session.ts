import { tool } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import path from "node:path"

// `session_info` — the join key between this session's handoff and observed
// provider telemetry. The orchestrator records the returned `session:` line in
// the handoff's `## Session metadata`; `node scripts/agent-report.js --cost`
// then joins the provider group (primary session + every subagent session) to
// it, giving real cost per feature / per shipped feature.
//
// Safe from a subagent too: the provider store is walked to the top ancestor
// session, and both the primary id (the join key) and the calling session id
// are reported. Never fabricates cost — an unreachable store reports
// "unavailable" and still returns the id.

function rootOf(context: any): string {
  return (context?.worktree || context?.directory || process.cwd()) as string
}

function observed(context: any, sessionID: string): any | null {
  const script = path.join(rootOf(context), "scripts", "qa", "provider-stats.js")
  try {
    const out = execFileSync("node", [script, "--session", sessionID, "--json", "--root", rootOf(context)], {
      cwd: rootOf(context),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60000,
    })
    return JSON.parse(out)
  } catch {
    return null
  }
}

function int(n: any): string {
  return String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

export const info = tool({
  description:
    "Report this orchestrator session's id — the `session:` value to record in the handoff's Session metadata so `agent-report --cost` can join real cost/token/turns — plus any observed provider telemetry for this session (primary + subagent sessions). Never invents numbers: if the opencode store is unreachable it says so and still returns the id.",
  args: {},
  async execute(_args, context) {
    const sessionID = String(context.sessionID || "unknown")
    const stats = observed(context, sessionID)
    const rootID = stats?.meta?.scope?.rootId
    const lines = [
      `session: ${rootID || sessionID}`,
      rootID && rootID !== sessionID ? `this_session: ${sessionID} (subagent of the primary above)` : null,
      `directory: ${context.directory}`,
      `worktree: ${context.worktree}`,
      `agent: ${context.agent}`,
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
    return lines.join("\n")
  },
})
