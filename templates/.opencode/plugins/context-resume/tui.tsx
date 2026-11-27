/* F-052 — auto clear-resume in the TUI.
 *
 * F-051's server guard writes `.agents/context-resume.json` when a primary
 * session in a feature worktree crosses the request-context ceiling. The runner
 * consumes that marker; an interactive TUI has no runner, so this TUI part is
 * the consumer. When the marker's session finishes its execution, it:
 *   1. re-reads the marker + checkpoint through `resume-plan.mjs`, which
 *      delegates to run-loop.js's decision core (freshness, progress, cap);
 *   2. creates a fresh session in the same worktree and queues the runner's
 *      own resume/finalize prompt, seeded from the checkpoint only;
 *   3. opens/focuses that session, so no manual `/resume` is typed.
 *
 * Safety rails: only a feature worktree (marker + branch agree) in the TUI's
 * current location, only after `session.execution.succeeded` (never mid-step,
 * never after a failure/interrupt), one action per marker, 3 resets per feature
 * (durable via `storage.store`, reset once the row lands). A flat checkpoint or
 * a cap stop surfaces a toast instead of relaunching. The server guard and the
 * runner are untouched.
 *
 * F-061 extends the same consumer to a MAIN checkout: the guard writes a
 * `main: true` marker only when one recent checkpoint is provable, and this
 * plugin accepts it only in a main checkout, with no other live lease in the
 * tree, and still creates the fresh session in the SAME directory (never a
 * session move or branch switch).
 */
import { Plugin } from "@opencode/plugin/tui"
import fs from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import process from "node:process"
import { importFresh } from "./hot-import.mjs"

/* Contract values pinned by tests/context-resume.test.js. Deliberately NOT
 * imported from `resume-plan.mjs`: the TUI entry keeps no static import of the
 * decision graph (F-064). A stale or broken helper in a statically imported
 * graph makes the whole plugin fail to LOAD for the process lifetime, and the
 * loader never retries — so the decision module is evaluated on demand through
 * `importFresh`, which also picks up a deployed fix on the next event. */
const STORAGE_KEY = "context-resume"
const RESUME_MARKER_REL = ".agents/context-resume.json"
const DEFAULT_MAX_CONTEXT_RESETS = 3

type ResumePlan = {
  parseMarker: (text: string) => any
  planResume: (input: any) => ResumeDecision
  resumeAfterIdle: (idleKind: string, decision: ResumeDecision, failureText: string) => boolean
  featureFromBranch: (branch: string | undefined) => string | null
  modelFromConfigText: (text: string) => string | null
  modelRef: (model: string) => { providerID: string; modelID: string } | null
}

/* F-067 fallback writer. Loaded fresh like the decision core, so a deploy is
 * picked up on the next stop and an import error becomes a toast, never a dead
 * plugin. ESM only (the module has no CJS dependency). */
type FallbackPlan = {
  writeFallbackCheckpoint: (input: any) => { written: boolean; reason: string; count: number }
  gitFilesChanged: (root: string) => string[]
  clearHeartbeat: (root: string, sessionID: string) => boolean
}

/* Bounded text of a failed execution: the provider/error message is the
 * discriminator between a context-window overflow (resumable) and a real
 * failure (manual), so never discard it (F-064 falsifier). */
const failureText = (event: any): string => {
  const data = event?.data || {}
  const raw = [data.error?.message, data.error?.name, data.error, data.message, data.reason]
  return raw
    .filter((part) => part != null && part !== "")
    .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
    .join(" ")
    .slice(0, 4000)
}

type WorktreeState = {
  feature: string | null
  handled: string | null
  resets: number
}

type ResumeDecision = {
  action: "ignore" | "resume" | "stop"
  reason: string
  feature?: string
  prompt?: string
  key?: string
  resets?: number
  nextResets?: number
  landed?: boolean
  model?: { providerID: string; modelID: string } | null
}

type LeaseRecord = {
  sessionID?: string
  pid?: number
  heartbeatAt?: number
  startedAt?: number
  name?: string
}

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

/* Resolved config order: the checkout's own files first, then the global config.
 * The auto-resume session must use the harness default model, never whatever
 * model the TUI currently has selected (the F-050 incident used the free
 * `opencode/seaglass-alpha-free` fallback). */
const modelConfigFiles = (directory: string): string[] => [
  path.join(directory, "opencode.json"),
  path.join(directory, "opencode.jsonc"),
  path.join(directory, ".opencode", "opencode.json"),
  path.join(directory, ".opencode", "opencode.jsonc"),
  path.join(homedir(), ".config", "opencode", "opencode.json"),
  path.join(homedir(), ".config", "opencode", "opencode.jsonc"),
]

const firstText = (files: string[]): string => {
  for (const file of files) {
    const text = readText(file)
    if (text) return text
  }
  return ""
}

/* Main vs linked without git: a main worktree's `.git` is a directory, a linked
 * worktree's is a file (`gitdir: ...`), so the nearest `.git` is enough. The TUI
 * plugin loader has no synchronous git dependency and must stay ESM-only, so no
 * CJS helper can be imported here. */
const checkoutKind = (directory: string): "main" | "linked" | null => {
  let dir = path.resolve(directory)
  while (dir !== path.dirname(dir) && !fs.existsSync(dir)) dir = path.dirname(dir)
  for (let i = 0; i < 64; i++) {
    try {
      return fs.statSync(path.join(dir, ".git")).isDirectory() ? "main" : "linked"
    } catch {
      /* no .git here — keep walking up */
    }
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
  return null
}

/* This checkout's `.serve/sessions/*.json` leases, read for the same
 * another-live-session gate the server guard applies (F-061). Parsing mirrors
 * lease-lib; an unreadable record keeps only its name so it can never be
 * mistaken for this session. */
const readLeases = (directory: string): LeaseRecord[] => {
  const dir = path.join(directory, ".serve", "sessions")
  let names: string[] = []
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: LeaseRecord[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
      if (rec && typeof rec === "object") out.push({ ...rec, name })
    } catch {
      out.push({ name })
    }
  }
  return out
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === "EPERM"
  }
}

export default Plugin.define({
  id: "context-resume",
  setup(context) {
    const [state, updateState] = context.storage.store(STORAGE_KEY, {
      initial: { worktrees: {} as Record<string, WorktreeState> },
    })
    // A session id is acted on once at a time; a second event queued behind an
    // in-flight create must not create two fresh sessions.
    const inflight = new Set<string>()

    const resolveDirectory = (): string | undefined => {
      const live = context.location?.directory
      if (typeof live === "string" && live) return live
      try {
        const fallback = context.data.location.default()?.directory
        return typeof fallback === "string" && fallback ? fallback : undefined
      } catch {
        return undefined
      }
    }

    const sessionDirectory = (sessionID: string): string | undefined => {
      try {
        const info = context.data.session.get(sessionID)
        const dir = info?.location?.directory
        return typeof dir === "string" && dir ? dir : undefined
      } catch {
        return undefined
      }
    }

    const sessionCreatedAt = (sessionID: string): number | undefined => {
      try {
        const created = Number(context.data.session.get(sessionID)?.time?.created)
        return Number.isFinite(created) ? created : undefined
      } catch {
        return undefined
      }
    }

    const branchAt = (directory: string): string | undefined => {
      try {
        const info = context.data.location.vcs.info({ directory })
        const branch = info?.branch?.current
        return typeof branch === "string" && branch ? branch : undefined
      } catch {
        return undefined
      }
    }

    const entryFor = (directory: string, feature: string | null): WorktreeState => {
      const prior = state.worktrees?.[directory]
      // A reused worktree/branch starts a new feature: its cap starts over too.
      if (prior && (!feature || prior.feature === feature)) return prior
      return { feature, handled: null, resets: 0 }
    }

    const persist = async (directory: string, next: WorktreeState) => {
      await updateState((draft) => {
        const worktrees = draft.worktrees || (draft.worktrees = {})
        worktrees[directory] = next
      })
    }

    const consumeMarker = (directory: string) => {
      try {
        fs.unlinkSync(path.join(directory, RESUME_MARKER_REL))
      } catch {
        /* absent marker is fine: the runner may have consumed it */
      }
    }

    const loadPlan = async (): Promise<ResumePlan> => {
      // Cache-busted: the running TUI evaluates the file as it is NOW, so a
      // deployed wiring fix lands on the next execution end without a restart.
      return (await importFresh("./resume-plan.mjs", import.meta.url)) as ResumePlan
    }

    const loadFallback = async (): Promise<FallbackPlan> => {
      return (await importFresh("../../../scripts/qa/checkpoint-fallback.mjs", import.meta.url)) as FallbackPlan
    }

    const startFresh = async (
      decision: ResumeDecision,
      directory: string,
      navigate: boolean
    ): Promise<string | undefined> => {
      const prompt = String(decision.prompt || "")
      if (!prompt) throw new Error("the runner produced no resume prompt")
      const model = decision.model || null
      const created = await context.client.session.create({ location: { directory } })
      const sessionID = created?.id
      if (!sessionID) throw new Error("session.create returned no session id")
      // Focus only when this TUI is looking at that checkout; a background
      // worktree/tab is resumed in place, never yanked to the foreground.
      if (navigate) {
        try {
          context.ui.router.navigate({ type: "session", sessionID })
        } catch {
          /* a route change is best-effort; the toast still names the session */
        }
        try {
          if (context.ui.tabs.enabled()) context.ui.tabs.focus(sessionID)
        } catch {
          /* tabs are optional */
        }
      }
      // Never inherit the TUI's current model: an explicit harness default keeps
      // auto-resume on the configured provider/model (F-050 incident).
      const body: { sessionID: string; text: string; model?: { providerID: string; modelID: string } } = {
        sessionID,
        text: prompt,
      }
      if (model) body.model = model
      await context.client.session.prompt(body)
      context.ui.toast.show({
        title: `${decision.feature || "Feature"} resumed`,
        message: navigate
          ? "Fresh context seeded from the checkpoint."
          : `Fresh context seeded in ${directory} — open that session to continue.`,
        variant: "success",
      })
      return sessionID
    }

    const handle = async (
      sessionID: string,
      idleKind: "succeeded" | "failed" | "interrupted",
      errorText = ""
    ) => {
      if (!sessionID || inflight.has(sessionID)) return
      inflight.add(sessionID)
      try {
        // Loaded before any IO: the decision module is the ONLY part allowed to
        // be stale, and a broken copy must surface here instead of killing the
        // plugin at load time (F-064).
        const plan = await loadPlan()
        const fallback = await loadFallback()
        const directory = sessionDirectory(sessionID)
        if (!directory) return
        // A child session (subagent, title agent, QA author, …) ending is a task
        // completion, never the bounded context boundary of the work unit. F-050
        // was re-finalized because a QA-plan subagent's idle event was consumed.
        const ended = (() => {
          try {
            return context.data.session.get(sessionID)
          } catch {
            return undefined
          }
        })()
        if (ended?.parentID) return
        // V2's event stream covers every session of this server. A session in
        // another checkout is still this TUI's: resume it in ITS directory and
        // only navigate/focus when that checkout is the one on screen (F-064).
        const current = resolveDirectory()
        const here = !!current && path.resolve(current) === path.resolve(directory)

        const kind = checkoutKind(directory)
        const branch = branchAt(directory)
        const branchFeature = plan.featureFromBranch(branch)
        let marker = plan.parseMarker(readText(path.join(directory, RESUME_MARKER_REL)))
        if (marker && marker.sessionID !== sessionID) marker = null

        // F-067: ALWAYS leave a resume state before the session is treated idle —
        // marker or not, clean or failed. The writer is idempotent and refuses to
        // overwrite a model checkpoint written during this session.
        const featureForCheckpoint =
          (marker && marker.feature ? String(marker.feature).toUpperCase() : null) || branchFeature
        let stopCount: number | null = null
        if (featureForCheckpoint) {
          try {
            const written = fallback.writeFallbackCheckpoint({
              root: directory,
              feature: featureForCheckpoint,
              sessionID,
              stopReason: idleKind,
              // The TUI cannot know the session-start count; the writer's mtime +
              // session rules keep a newer model checkpoint safe.
              baselineCount: null,
              sessionStartedAt: sessionCreatedAt(sessionID) ?? null,
              filesChanged: fallback.gitFilesChanged(directory),
            })
            stopCount = written.count
          } catch (error) {
            context.ui.toast.show({
              title: "Fallback checkpoint failed",
              message: error instanceof Error ? error.message : String(error),
              variant: "error",
            })
          }
          try {
            fallback.clearHeartbeat(directory, sessionID)
          } catch {
            /* best-effort */
          }
        }

        // An early stop with no context-band marker is still resumable: the
        // fallback just written becomes a stop marker with a `reason` (F-067).
        // An interrupt stays manual by policy; no branch feature means no safe
        // feature to seed from.
        if (!marker) {
          if (idleKind === "interrupted" || !branchFeature || stopCount == null) return
          marker = {
            schema: 1,
            feature: branchFeature,
            sessionID,
            at: new Date().toISOString(),
            checkpoint_count: stopCount,
            reason: "auto-checkpoint",
          }
        }

        const featureFromMarker = marker.feature ? String(marker.feature).toUpperCase() : null
        const entry = entryFor(directory, featureFromMarker)
        const decision: ResumeDecision = plan.planResume({
          marker,
          idleSessionID: sessionID,
          sessionCreatedAt: sessionCreatedAt(sessionID),
          branch,
          checkoutKind: kind,
          // The single-live-session gate applies to every checkout, not only
          // main: two finalize sessions in one feature worktree is the F-050
          // incident. The ended session's own lease is excluded by id.
          leases: readLeases(directory),
          idleSessionIsChild: !!ended?.parentID,
          isAlive: pidAlive,
          handoffText: featureFromMarker
            ? readText(path.join(directory, ".agents", "handoffs", featureFromMarker + ".md"))
            : "",
          backlogText: readText(path.join(directory, "BACKLOG.md")),
          handled: entry.handled,
          resets: entry.resets,
          maxResets: DEFAULT_MAX_CONTEXT_RESETS,
        })
        if (decision.action === "ignore") return

        // Mark this crossing handled BEFORE the side effects: a re-entrant
        // event, a TUI reload, or a second TUI instance must not resume twice.
        const feature = decision.feature || featureFromMarker
        await persist(directory, {
          feature,
          handled: decision.key || null,
          resets: decision.resets ?? entry.resets,
        })
        consumeMarker(directory)

        if (decision.action === "stop") {
          await persist(directory, {
            feature,
            handled: decision.key || null,
            resets: decision.landed ? 0 : decision.resets ?? entry.resets,
          })
          context.ui.toast.show({
            title: decision.landed ? "Auto-resume not needed" : "Auto-resume stopped",
            message: decision.reason,
            variant: decision.landed ? "success" : "warning",
          })
          return
        }

        // A clean end resumes. A failed end resumes ONLY when its error is a
        // context-window overflow AND the same fresh/progressed/cap gates pass
        // (F-064). Any other failure or an interrupt keeps the manual path.
        if (!plan.resumeAfterIdle(idleKind, decision, errorText)) {
          context.ui.toast.show({
            title: "Context boundary recorded",
            message: "Resume manually with `/resume` (or `agent-harness run`) after inspecting the failure.",
            variant: "warning",
          })
          return
        }

        decision.model = plan.modelRef(plan.modelFromConfigText(firstText(modelConfigFiles(directory))))
        await startFresh(decision, directory, here)
        await persist(directory, {
          feature,
          handled: decision.key || null,
          resets: decision.nextResets ?? entry.resets + 1,
        })
      } catch (error) {
        context.ui.toast.show({
          title: "Auto-resume failed",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      } finally {
        inflight.delete(sessionID)
      }
    }

    // `session.execution.succeeded` is V2's end-of-execution signal (the schema
    // declares `session.idle`, but the server does not emit it). A step-level
    // event is deliberately NOT used: resuming mid-session is never safe.
    const stops = [
      context.data.on("session.execution.succeeded", (event: any) => {
        void handle(String(event?.data?.sessionID || ""), "succeeded")
      }),
      context.data.on("session.execution.failed", (event: any) => {
        void handle(String(event?.data?.sessionID || ""), "failed", failureText(event))
      }),
      context.data.on("session.execution.interrupted", (event: any) => {
        void handle(String(event?.data?.sessionID || ""), "interrupted")
      }),
    ]

    return () => {
      for (const stop of stops) {
        try {
          stop()
        } catch {
          /* already disposed */
        }
      }
    }
  },
})
