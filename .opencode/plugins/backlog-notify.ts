import type { Plugin } from "@opencode/plugin"

// Pushes a structured log whenever an agent mutates the board via the
// `backlog_*` tools, so "an agent finished an item" reaches you as a notification
// instead of a manual `/board` refresh.

function summarize(name: string, args: any): string {
  switch (name) {
    case "backlog_add":
      return `added "${args?.task ?? ""}"`
    case "backlog_take":
      return `picked up ${args?.id ?? ""}`
    case "backlog_queue":
      return `queued ${args?.id ?? ""}`
    case "backlog_next":
      return args?.take ? `took next item off the queue` : "checked the next queued item"
    case "backlog_archive":
      return `archived ${args?.id ?? ""}`
    case "backlog_freeze":
      return `froze ${args?.id ?? ""}`
    case "backlog_epic":
      return `moved ${args?.id ?? ""} to epic ${args?.to ?? ""}`
    case "backlog_epic_add":
      return `added epic "${args?.key ?? ""}"`
    case "backlog_worktree":
      return `isolated ${args?.id ?? ""} in a worktree`
    case "backlog_depends":
      return `set ${args?.id ?? ""} depends on ${args?.on ?? ""}`
    case "backlog_owns":
      return `recorded files owned by ${args?.id ?? ""}`
    case "backlog_list":
      return "listed the board"
    default:
      return name
  }
}

const BacklogNotify: Plugin = {
  id: "backlog-notify",
  async setup(ctx) {
    await ctx.tool.hook("execute.after", (event: any) => {
      const name = event?.tool || ""
      if (!name.startsWith("backlog_")) return

      const args = (event?.input as any) ?? {}
      const message = `Backlog: ${summarize(name, args)}`

      // V1 pushed a TUI toast + `client.app.log`; V2 server plugins have no
      // toast and no `client`, so this is a best-effort console log.
      console.log(message)
    })

    return () => {}
  },
}

export default BacklogNotify
