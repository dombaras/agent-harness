import type { Plugin } from "@opencode-ai/plugin"

// Pushes a toast + structured log whenever an agent mutates the board via the
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
    case "backlog_list":
      return "listed the board"
    default:
      return name
  }
}

export const BacklogNotify: Plugin = async ({ client }) => {
  return {
    "tool.execute.after": async (input: any, output: any) => {
      const name = input?.tool || ""
      if (!name.startsWith("backlog_")) return

      const args =
        (output?.args as any) ?? (output?.input?.args as any) ?? input?.args ?? {}
      const message = `Backlog: ${summarize(name, args)}`

      try {
        await client.tui.showToast({ body: { message, variant: "info" } })
      } catch {
        /* toast is best-effort (no TUI in headless/server mode) */
      }
      try {
        await client.app.log({
          body: { service: "backlog", level: "info", message },
        })
      } catch {
        /* logging is best-effort */
      }
    },
  }
}
