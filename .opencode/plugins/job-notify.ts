import type { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import jobEvents from "../../scripts/qa/mobile-e2e/job-events.js"

// Turns a detached mobile-E2E run into a PUSH, not a poll. The agent launches
// `run-detached.sh` (which writes a job record + a JSONL progress stream) and
// then gets on with its work; this plugin tails that stream and:
//   * logs progress per scenario (live progress, no LLM turn and no re-billed
//     context), and
//   * wakes the owning session via `session.prompt` on the FIRST failure (so it
//     can react early) and again when the matrix finishes.
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
  stalledNotified: boolean
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

const JobNotify: Plugin = {
  id: "job-notify",
  async setup(ctx) {
    const pending = new Map<string, number>()
    const watches = new Map<string, Watch>()

    // V1 called `client.app.log`; V2 server plugins log to the console.
    const report = (message: string, level: "info" | "warn" | "error" = "info") => {
      const line = `job-notify: ${message}`
      if (level === "error") console.error(line)
      else if (level === "warn") console.warn(line)
      else console.log(line)
    }

    // Wake an idle session with a real message so it resumes on its own.
    const wake = async (sessionID: string, text: string) => {
      try {
        await ctx.session.prompt({ sessionID, text })
      } catch (err: any) {
        report(`could not notify session ${sessionID}: ${err?.message || err}`, "warn")
      }
    }

    const stopWatch = (key: string, reason: string) => {
      const w = watches.get(key)
      if (!w) return
      clearInterval(w.timer)
      watches.delete(key)
      report(`stopped watching ${w.events} (${reason})`)
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
        stalledNotified: false,
        doneNotified: false,
        startedAt: Date.now(),
        timer: null as any,
      }
      w.timer = setInterval(() => void tick(key), TICK_MS)
      if (typeof (w.timer as any)?.unref === "function") (w.timer as any).unref()
      watches.set(key, w)
      report(`watching ${events} for session ${sessionID}`)
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
            const stalled = event.type === "invocation_stalled"
            // A heartbeat proves liveness to the log/wait stream; reporting it
            // without extra ceremony keeps the log quiet.
            if (event.type === "invocation_heartbeat") {
              report(line, "info")
              continue
            }
            report(line, failed || stalled ? "warn" : "info")
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
          const stalled = fresh.find((e: any) => e.type === "invocation_stalled")
          if (stalled && !w.stalledNotified) {
            w.stalledNotified = true
            await wake(
              w.sessionID,
              `Mobile E2E invocation ${stalled.index}/${stalled.total} has produced no output for ` +
                `${Math.round((stalled.msSinceOutput || 0) / 1000)}s — possible hang.\n` +
                `Stop it deterministically: scripts/qa/mobile-e2e/run-detached.sh --stop <job-id>\n` +
                `Events: ${w.events}`
            )
          }
          const aborted = fresh.find((e: any) => e.type === "matrix_aborted")
          if (aborted) {
            await wake(
              w.sessionID,
              jobEvents.notificationText(jobEvents.summarize(events), { eventsPath: w.events })
            )
            stopWatch(key, "matrix aborted")
            return
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
        report(`watch tick failed: ${err?.message || err}`, "warn")
      }
    }

    // V2: the `bash` tool is named `shell`; `event.input` carries the args.
    await ctx.tool.hook("execute.before", (event: any) => {
      try {
        if (String(event?.tool || "").toLowerCase() !== "shell") return
        const command = String(event?.input?.command || "")
        const sid = event?.sessionID
        if (typeof sid !== "string" || sid.length === 0) return
        if (LAUNCH_RE.test(command) && !/--wait\b/.test(command)) {
          pending.set(sid, Date.now())
        }
      } catch {
        /* never break a tool call */
      }
    })

    await ctx.tool.hook("execute.after", (event: any) => {
      try {
        if (String(event?.tool || "").toLowerCase() !== "shell") return
        const sid = event?.sessionID
        if (typeof sid !== "string" || sid.length === 0) return
        const startedAt = pending.get(sid)
        if (!startedAt || Date.now() - startedAt > 60000) return
        pending.delete(sid)
        const result: any = event?.result
        const text =
          typeof result?.content === "string"
            ? result.content
            : Array.isArray(result?.content)
              ? result.content.map((p: any) => (p && typeof p.text === "string" ? p.text : "")).join("\n")
              : ""
        const blob = `${text}\n${JSON.stringify(result?.metadata || {})}`
        const events = pathFrom(blob, "events")
        if (!events) return
        const record = pathFrom(blob, "record")
        startWatch(sid, events, record)
      } catch {
        /* never break a tool call */
      }
    })

    // Cleanup: stop every tail timer so an unloaded plugin leaves no interval behind.
    return () => {
      for (const w of watches.values()) clearInterval(w.timer)
      watches.clear()
    }
  },
}

export default JobNotify
