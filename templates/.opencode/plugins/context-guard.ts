import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import guard from "../../scripts/qa/context-guard-core.js"
import leases from "../../scripts/qa/lease-lib.js"

// Mechanical half of the context budget: read the project-owned thresholds from
// `.agents/memory/orchestration.md` and nudge the PRIMARY orchestrator session as
// it crosses them — injected text is constant per band so the cache-friendly
// prefix stays byte-stable. Also counts identical tool+args calls (loop
// detector) and records crossings in `.agents/guard-events.jsonl` (local-only,
// excluded clone-locally) so telemetry exists before a full provider-stats pass does.
// It also hard-stops on provider funds/quota errors (see model-routing.md
// "Provider funds stop") so a failed dispatch can never silently degrade inline.
// Child sessions (subagent dispatches) are tracked to attribute their funds
// errors to the orchestrator *with the failing provider/model* — the top-up
// target comes from observed dispatch metadata (task `metadata.model` or the
// child assistant message `providerID/modelID`), never a guess.

const ORCHESTRATION_REL = path.join(".agents", "memory", "orchestration.md")
const GUARD_LOG_REL = path.join(".agents", "guard-events.jsonl")


export const ContextGuard: Plugin = async ({ directory, client }) => {
  const sessions = new Map<string, any>()
  const childSessions = new Set<string>()
  const childParent = new Map<string, string>()
  const sessionModel = new Map<string, string>()
  let thresholds: any = null

  const stateFor = (sessionID: string) => {
    let state = sessions.get(sessionID)
    if (!state) {
      state = guard.createSessionState()
      sessions.set(sessionID, state)
    }
    return state
  }

  /* Walk a subagent session up to the primary orchestrator it belongs to, so a
   * child's funds error arms the stop on the session the user actually sees. */
  const primaryRoot = (sessionID: string) => {
    let cur = sessionID
    for (let i = 0; i < 100 && childParent.has(cur); i++) cur = childParent.get(cur) as string
    return cur
  }

  /* Arm the funds stop on the primary session, naming the failed provider/model
   * (when observed) in the injected rule, the guard-event log, and the TUI log. */
  const armFunds = async (sessionID: string, label: string | null, source: string) => {
    const owner = primaryRoot(sessionID)
    const state = stateFor(owner)
    if (state.fundsPending) return
    state.fundsPending = true
    state.fundsNotice = guard.fundsText(label, source)
    const [provider, model] = label
      ? label.includes("/")
        ? [label.slice(0, label.indexOf("/")), label.slice(label.indexOf("/") + 1)]
        : [null, label]
      : [null, null]
    logEvent({
      kind: "funds",
      sessionID: owner,
      failedSessionID: sessionID === owner ? null : sessionID,
      provider,
      model,
      source,
    })
    await report(`${label || "unknown provider/model"} — provider funds/quota error (${source}) — pausing for top-up`)
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
    } catch (err: any) {
      // Best-effort telemetry, but never silent: a missing guard log left a real
      // detection unattributable once (LibraryOS) — surface the write failure.
      void report(`guard-event log write failed: ${err?.message || err}`)
    }
  }

  const report = async (message: string, level: "info" | "warn" = "warn") => {
    try {
      await client.app.log({ body: { service: "context-guard", level, message } })
    } catch {
      /* logging is best-effort (no server/TUI in some modes) */
    }
  }

  /* Per-tree primary-session lease. `test:concurrency` reads `.serve/sessions/`
   * to fail when two primary sessions share one checkout — a collision that
   * exists even on a clean tree. The lease carries a process birth token
   * (bootId + /proc starttime) and a heartbeat, both defined in lease-lib.js, so
   * a recycled pid or a closed TUI can't masquerade as a live session.
   * Best-effort (never throws into the hook). */
  const writeLease = (sessionID: string) => {
    try {
      leases.writeLease(directory, sessionID)
    } catch {
      /* lease is best-effort */
    }
  }
  const clearLease = (sessionID: string) => {
    try {
      leases.clearLease(directory, sessionID)
    } catch {
      /* lease is best-effort */
    }
  }
  const touchLease = (sessionID: string) => {
    try {
      leases.touchLease(directory, sessionID)
    } catch {
      /* lease is best-effort */
    }
  }

  // Sweep leases left by crashed/closed sessions so they can never block the
  // concurrency gate. Runs once per plugin load (best-effort).
  try {
    const pruned = leases.pruneLeases(directory)
    if (pruned.length) {
      void report(`pruned ${pruned.length} stale session lease(s) in this tree`)
    }
  } catch {
    /* best-effort */
  }

  return {
    event: async ({ event }: any) => {
      try {
        const type = event?.type
        const props = event?.properties || {}

        if (type === "session.created" || type === "session.updated") {
          if (props.info?.id && props.info.parentID) {
            childSessions.add(props.info.id)
            childParent.set(props.info.id, props.info.parentID)
          } else if (type === "session.created" && props.info?.id) {
            writeLease(props.info.id)
          }
          return
        }

        if (type === "session.deleted") {
          const id = props.info?.id
          if (id) {
            clearLease(id)
            childSessions.delete(id)
            childParent.delete(id)
            sessionModel.delete(id)
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
          const sid = info?.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          if (info?.role === "assistant") {
            const label = guard.modelLabel(info)
            if (label) sessionModel.set(sid, label)
            // A failed dispatch reports its own provider/model on the assistant
            // message — capture it even for child (subagent) sessions.
            if (info?.error && guard.fundsError(JSON.stringify(info.error))) {
              await armFunds(sid, label, "assistant error")
            }
          }
          if (!isPrimary(sid)) return
          touchLease(sid)
          if (info?.role === "user") {
            // The user is speaking (usually the top-up-complete message):
            // release the funds stop so work can resume.
            const state = stateFor(sid)
            state.fundsPending = false
            state.fundsNotice = null
            return
          }
          if (info?.role !== "assistant") return
          const note = guard.noteAssistant(stateFor(sid), info, loadThresholds())
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
          return
        }

        if (type === "session.error") {
          const sid = props.sessionID || props.info?.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          const text = JSON.stringify(props.error ?? props.message ?? props)
          if (!guard.fundsError(text)) return
          const label = guard.modelLabel(props.error) || sessionModel.get(sid) || null
          await armFunds(sid, label, "session.error")
          return
        }
      } catch {
        /* the guard must never break a session */
      }
    },

    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (!isPrimary(input?.sessionID)) return
        touchLease(input.sessionID)
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

    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (!isPrimary(input?.sessionID)) return
        touchLease(input.sessionID)
        // Only structured failure evidence may arm the stop (core gate): a
        // successful read/grep/dispatch returning the harness's own docs — which
        // quote the trigger phrases — must never pause a healthy session.
        const text = guard.fundsArmText(input?.tool, output)
        if (!text || !guard.fundsError(text)) return
        const meta = output?.metadata || {}
        const label =
          guard.modelLabel(meta.model) || sessionModel.get(String(meta.sessionId || "")) || null
        await armFunds(input.sessionID, label, `tool:${input?.tool}`)
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
        if (state.fundsPending) texts.push(state.fundsNotice || guard.FUNDS_TEXT)
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
