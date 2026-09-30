import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import jobEvents from "../../scripts/qa/mobile-e2e/job-events.js"

// Turns a detached mobile-E2E run into a PUSH, not a poll. The agent launches
// `run-detached.sh` (which writes a job record + a JSONL progress stream) and
// then gets on with its work; this plugin tails that stream and:
//   * shows a TUI toast + structured log per scenario (live progress, no LLM
//     turn and no re-billed context), and
//   * wakes the owning session via `session.promptAsync` on the FIRST failure
//     (so it can react early) and again when the matrix finishes.
// `--wait` launches are skipped: there the agent blocks and streams the same
// lines itself. Everything is best-effort — the notifier must never break a
// session, a launch, or an unrelated tool call.

const TICK_MS = 3000
const MAX_WATCH_MS = 3 * 60 * 60 * 1000
const LAUNCH_RE = /run-detached\.sh|run-maestro\.js/

type Watch = {
  sessionID: string
  events: string
  record: string | null
  lastLine: number
  failureNotified: boolean
  doneNotified: boolean
  startedAt: number
  timer: ReturnType<typeof setInterval>
}

function pathFrom(text: string, label: string): string | null {
  const m = String(text || "").match(new RegExp(label + ":\\s*(\\S+)"))
  return m ? m[1] : null
}

function alive(pid: unknown): boolean {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return true // unknown -> assume running
  try {
    process.kill(n, 0)
    return true
  } catch (err: any) {
    return err && err.code === "EPERM"
  }
}

export const JobNotify: Plugin = async ({ client }) => {
  const pending = new Map<string, number>()
  const watches = new Map<string, Watch>()

  const report = async (message: string, level: "info" | "warn" | "error" = "info") => {
    try {
      await client.app.log({ body: { service: "job-notify", level, message } })
    } catch {
      /* logging is best-effort */
    }
  }

  const toast = async (message: string, variant: "info" | "success" | "warning" | "error" = "info") => {
    try {
      await client.tui.showToast({ body: { message, variant } })
    } catch {
      /* toast is best-effort (no TUI in headless/server mode) */
    }
  }

  // Wake an idle session with a real message so it resumes on its own.
  const wake = async (sessionID: string, text: string) => {
    try {
      await client.session.promptAsync({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text }] },
      })
    } catch (err: any) {
      await report(`could not notify session ${sessionID}: ${err?.message || err}`, "warn")
    }
  }

  const stopWatch = (key: string, reason: string) => {
    const w = watches.get(key)
    if (!w) return
    clearInterval(w.timer)
    watches.delete(key)
    void report(`stopped watching ${w.events} (${reason})`)
  }

  const startWatch = (sessionID: string, events: string, record: string | null) => {
    const key = events
    if (watches.has(key)) return
    const w: Watch = {
      sessionID,
      events,
      record,
      lastLine: 0,
      failureNotified: false,
      doneNotified: false,
      startedAt: Date.now(),
      timer: null as any,
    }
    w.timer = setInterval(() => void tick(key), TICK_MS)
    if (typeof (w.timer as any)?.unref === "function") (w.timer as any).unref()
    watches.set(key, w)
    void report(`watching ${events} for session ${sessionID}`)
    void tick(key)
  }

  const readRecord = (w: Watch): any => {
    if (!w.record) return null
    try {
      return JSON.parse(fs.readFileSync(w.record, "utf8"))
    } catch {
      return null
    }
  }

  const tick = async (key: string) => {
    const w = watches.get(key)
    if (!w) return
    try {
      if (Date.now() - w.startedAt > MAX_WATCH_MS) {
        stopWatch(key, "watch timeout")
        return
      }
      const events = jobEvents.readEvents(w.events)
      const fresh = events.slice(w.lastLine)
      if (fresh.length > 0) {
        w.lastLine = events.length
        for (const event of fresh) {
          const line = jobEvents.progressLine(event)
          if (!line) continue
          const failed = event.type === "flow_result" && event.status !== "pass"
          await toast(line, failed ? "warning" : event.type === "matrix_done" ? "info" : "info")
          await report(line, failed ? "warn" : "info")
        }
        const firstFailure = fresh.find(
          (e: any) => e.type === "flow_result" && e.status !== "pass"
        )
        if (firstFailure && !w.failureNotified) {
          w.failureNotified = true
          await wake(
            w.sessionID,
            jobEvents.notificationText(jobEvents.summarize(events), { eventsPath: w.events })
          )
        }
        const done = fresh.find((e: any) => e.type === "matrix_done")
        if (done) {
          w.doneNotified = true
          await wake(
            w.sessionID,
            jobEvents.notificationText(jobEvents.summarize(events), { eventsPath: w.events })
          )
          stopWatch(key, "matrix done")
          return
        }
      }
      // A crashed runner may never emit matrix_done: fall back to the pid.
      const rec = readRecord(w)
      if (rec && !w.doneNotified && !alive(rec.pid)) {
        w.doneNotified = true
        await wake(
          w.sessionID,
          jobEvents.notificationText(jobEvents.summarize(events), {
            reportPath: jobEvents.summarize(events).reportPath,
            eventsPath: w.events,
          })
        )
        stopWatch(key, "runner exited")
      }
    } catch (err: any) {
      await report(`watch tick failed: ${err?.message || err}`, "warn")
    }
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      try {
        if (String(input?.tool || "").toLowerCase() !== "bash") return
        const command = String(output?.args?.command || "")
        const sid = input?.sessionID
        if (typeof sid !== "string" || sid.length === 0) return
        if (LAUNCH_RE.test(command) && !/--wait\b/.test(command)) {
          pending.set(sid, Date.now())
        }
      } catch {
        /* never break a tool call */
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      try {
        if (String(input?.tool || "").toLowerCase() !== "bash") return
        const sid = input?.sessionID
        if (typeof sid !== "string" || sid.length === 0) return
        const startedAt = pending.get(sid)
        if (!startedAt || Date.now() - startedAt > 60000) return
        pending.delete(sid)
        const blob = `${output?.output || ""}\n${JSON.stringify(output?.metadata || {})}`
        const events = pathFrom(blob, "events")
        if (!events) return
        const record = pathFrom(blob, "record")
        startWatch(sid, events, record)
      } catch {
        /* never break a tool call */
      }
    },
  }
}
