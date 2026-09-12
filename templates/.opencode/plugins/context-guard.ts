import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import guard from "../../scripts/qa/context-guard-core.js"

// Mechanical half of the context budget: read the project-owned thresholds from
// `.agents/memory/orchestration.md` and nudge the PRIMARY orchestrator session as
// it crosses them — injected text is constant per band so the cache-friendly
// prefix stays byte-stable. Also counts identical tool+args calls (loop
// detector) and records crossings in `.agents/guard-events.jsonl` (local-only,
// gitignored) so telemetry exists before a full provider-stats pass does.
// Child sessions (subagent dispatches) are tracked only to be excluded.

const ORCHESTRATION_REL = path.join(".agents", "memory", "orchestration.md")
const GUARD_LOG_REL = path.join(".agents", "guard-events.jsonl")

export const ContextGuard: Plugin = async ({ directory, client }) => {
  const sessions = new Map<string, any>()
  const childSessions = new Set<string>()
  let thresholds: any = null

  const stateFor = (sessionID: string) => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = guard.createSessionState()
      sessions.set(sessionID, state)
    }
    return state
  }

  const isPrimary = (sessionID: unknown): sessionID is string =>
    typeof sessionID === "string" && sessionID.length > 0 && !childSessions.has(sessionID)

  const loadThresholds = () => {
    if (thresholds) return thresholds
    let text = ""
    try {
      text = fs.readFileSync(path.join(directory, ORCHESTRATION_REL), "utf8")
    } catch {
      /* missing/unreadable file -> documented defaults from the core */
    }
    thresholds = guard.parseThresholds(text)
    return thresholds
  }

  const logEvent = (event: Record<string, unknown>) => {
    try {
      const file = path.join(directory, GUARD_LOG_REL)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, guard.formatGuardEvent(event), "utf8")
    } catch {
      /* the guard-event log is best-effort telemetry */
    }
  }

  const report = async (message: string, level: "info" | "warn" = "warn") => {
    try {
      await client.app.log({ body: { service: "context-guard", level, message } })
    } catch {
      /* logging is best-effort (no server/TUI in some modes) */
    }
  }

  return {
    event: async ({ event }: any) => {
      try {
        const type = event?.type
        const props = event?.properties || {}

        if (type === "session.created" || type === "session.updated") {
          if (props.info?.id && props.info.parentID) childSessions.add(props.info.id)
          return
        }

        if (type === "session.deleted") {
          const id = props.info?.id
          if (id) {
            childSessions.delete(id)
            sessions.delete(id)
          }
          return
        }

        if (type === "file.watcher.updated") {
          if (String(props.file || "").endsWith("orchestration.md")) thresholds = null
          return
        }

        if (type === "message.updated") {
          const info = props.info
          if (info?.role !== "assistant" || !isPrimary(info.sessionID)) return
          const note = guard.noteAssistant(stateFor(info.sessionID), info, loadThresholds())
          if (note.newTurn && note.bandChanged && note.band) {
            logEvent({ kind: "band", sessionID: info.sessionID, band: note.band, turn: note.turns })
            await report(`turn ${note.turns}: ${note.band} band`)
          }
          if (note.requestChanged && note.requestLevel) {
            logEvent({
              kind: "request",
              sessionID: info.sessionID,
              level: note.requestLevel,
              tokens: note.requestTokens,
            })
          }
        }
      } catch {
        /* the guard must never break a session */
      }
    },

    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (!isPrimary(input?.sessionID)) return
        const note = guard.noteToolCall(
          stateFor(input.sessionID),
          input?.tool,
          output?.args,
          loadThresholds().stuck
        )
        if (note.firstFlag) {
          logEvent({
            kind: "loop",
            sessionID: input.sessionID,
            tool: String(input?.tool || ""),
            count: note.count,
            keyHash: note.keyHash,
          })
          await report(`repeated identical ${input?.tool} call x${note.count}`)
        }
      } catch {
        /* never break the tool call */
      }
    },

    "experimental.chat.system.transform": async (input: any, output: any) => {
      try {
        if (!isPrimary(input?.sessionID) || !Array.isArray(output?.system)) return
        const state = stateFor(input.sessionID)
        const texts: string[] = []
        const band = guard.turnBand(state.turns, loadThresholds().turns)
        if (band) texts.push(guard.bandText(band))
        if (state.loopPending) texts.push(guard.LOOP_TEXT)
        for (const text of texts) {
          const already = output.system.some((s: string) => typeof s === "string" && s.includes(text))
          if (!already) output.system.push(text)
        }
      } catch {
        /* never break a request */
      }
    },

    "permission.ask": async (input: any) => {
      try {
        const type = String(input?.type || "")
        const title = String(input?.title || "")
        if (type !== "doom_loop" && !/doom.?loop/i.test(title)) return
        // The runtime's own consecutive-identical-call guard fired: surface it
        // and arm the recovery rule for the next request.
        logEvent({ kind: "doom_loop", sessionID: input?.sessionID, title })
        if (isPrimary(input?.sessionID)) {
          stateFor(input.sessionID).loopPending = true
          await report(`built-in doom-loop guard fired${title ? `: ${title}` : ""}`)
        }
      } catch {
        /* visibility only; never alter the permission decision */
      }
    },
  }
}
