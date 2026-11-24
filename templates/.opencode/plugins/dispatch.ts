import type { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
import toolLib from "../../scripts/qa/tool-lib.js"
import dispatch from "../../scripts/qa/dispatch-persona.js"

// `dispatch_persona` — one call that turns "delegate to a persona" from a
// retyped spec into a preflighted child session (F-025 S2).
//
// The main agent supplies only the thing it alone knows (`objective`) plus the
// persona. The wrapper reads the persona's decision contract from
// `.opencode/agents/<persona>.md`, derives the working tree/owned files/tier
// gate, and PREFLIGHTS before spawning:
//   1. the persona exists (typo / renamed agent),
//   2. its model pin resolves (`opencode models`, cached once per load),
//   3. an objective that writes maps to a persona whose edit rules allow it
//      (the F-074/F-095 "shipped" dispatch that could not write),
//   4. the tree exists, is on the expected branch, and reports dirty state.
// A rejected dispatch costs zero tokens; a broken one costs a whole feature.
//
// V2 creates a child session with POST /api/session { parentID, agent,
// location } and starts it with POST /api/session/{id}/prompt. From a plugin
// that is `ctx.session.create` + `ctx.session.prompt`. The child reports back
// to this session's inbox after each round (V2 background result), so the
// caller does not poll.

const MODELS_TTL_MS = 10 * 60 * 1000

function gitOut(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim()
  } catch {
    return null
  }
}

export default {
  id: "dispatch-tools",
  async setup(ctx) {
    const directory = ctx.location.directory
    const h = (context: any) => ({
      directory,
      sessionID: context?.sessionID,
      agent: context?.agent,
    })

    let modelsCache: { at: number; list: string[] | null } = { at: 0, list: null }
    const models = (): string[] | null => {
      if (Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.list
      let list: string[] | null = null
      try {
        const out = execFileSync("opencode", ["models"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 15000,
        })
        const parsed = out
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => /^[^\s]+\/[^\s]+$/.test(l))
        if (parsed.length) list = parsed
      } catch {
        list = null // unverified, never a block
      }
      modelsCache = { at: Date.now(), list }
      return list
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "dispatch_persona",
        description:
          "Delegate one bounded unit of work to a persona in ONE call: preflights the persona (exists, model pin resolves, edit scope covers the objective, tree exists/clean state) and assembles the six-field spec (objective, tree, owned files, read-only, contracts, done gate) before creating an agent-scoped child session that reports back. Prefer it to retyping a `subagent` prompt from memory. Rejections name the one fix; a dispatch is the only way to spend tokens in a context you can throw away.",
        input: {
          type: "object",
          properties: {
            persona: {
              type: "string",
              description: "persona id matching .opencode/agents/<id>.md (e.g. qa-architect, frontend-engineer, docs)",
            },
            objective: {
              type: "string",
              description: "the one thing only the caller knows: what this dispatch must produce",
            },
            feature: {
              type: "string",
              description: "backlog row id (optional; recorded in the child title and contracts)",
            },
            files: {
              type: "array",
              items: { type: "string" },
              description: "repo-relative paths the objective may touch (optional; narrows the write-scope preflight)",
            },
          },
          required: ["persona", "objective"],
          additionalProperties: false,
        },
        async execute(input: any, context: any) {
          const helper = h(context)
          const root = toolLib.sessionRoot(helper, ".opencode")
          const files: string[] = Array.isArray(input?.files) ? input.files.map(String) : []
          const branch = gitOut(root, ["branch", "--show-current"])
          const status = gitOut(root, ["status", "--porcelain"])
          const tree = {
            path: root,
            branch: branch || null,
            dirty: status == null ? null : status.split(/\r?\n/).filter(Boolean).length,
          }

          const pf = dispatch.preflight({
            root,
            persona: input?.persona,
            objective: input?.objective,
            files,
            models: models(),
            tree,
          })
          if (!pf.ok) {
            const lines = [`dispatch_persona: REJECTED (no tokens spent)`]
            for (const e of pf.errors) lines.push(`  ✗ ${e.message}`)
            for (const w of pf.warnings) lines.push(`  ⚠ ${w.message}`)
            lines.push("Fix the one line above and call again.")
            return { content: lines.join("\n") }
          }

          const owned = files.length ? files : pf.persona.writes
          const built = dispatch.buildPrompt({
            persona: input.persona,
            objective: input.objective,
            root,
            description: pf.persona.description,
            writes: pf.persona.writes,
            owned,
            tree,
            contracts: input.feature
              ? [`.agents/features/${input.feature}/plan.md (owned/consumes), intent.md (acceptance)`]
              : [],
            outOfScope: input.feature
              ? [`Do not expand beyond the ${input.feature} objective; log follow-ups as deferred items.`]
              : [],
          })

          // The V2 runtime exposes session creation on the plugin context. A
          // runtime without it gets the prepared prompt back (one copy, then
          // the standard `subagent` tool) instead of a silent no-op.
          const sessionApi: any = (ctx as any).session
          if (typeof sessionApi?.create !== "function") {
            return {
              content:
                "dispatch_persona: this runtime has no ctx.session.create — the preflight passed; pass the SPEC below to `subagent`:\n\n" +
                built.prompt,
            }
          }

          let child: any
          try {
            child = await sessionApi.create({
              parentID: context?.sessionID,
              agent: input.persona,
              title: `${input.feature ? input.feature + " · " : ""}${input.persona}: ${String(input.objective).slice(0, 70)}`,
              location: { directory: root },
            })
          } catch (err: any) {
            return {
              content:
                `dispatch_persona: preflight passed but session create failed: ${err?.message || err}\n` +
                `Remediation: confirm .opencode/agents/${input.persona}.md exists here and the runtime is OpenCode V2; ` +
                `if this runtime has no ctx.session.create, call \`subagent\` with the SPEC below.\n\n${built.prompt}`,
            }
          }

          const childID = child?.id || child?.sessionID
          if (!childID) {
            return { content: "dispatch_persona: session create returned no id — nothing was started; retry or use `subagent`." }
          }
          try {
            await sessionApi.prompt({ sessionID: childID, text: built.prompt })
          } catch (err: any) {
            return {
              content:
                `dispatch_persona: child ${childID} created but the prompt did not send: ${err?.message || err}\n` +
                `The child reports back to this session's inbox once started.`,
            }
          }

          return {
            content: dispatch.renderReceipt({
              persona: input.persona,
              sessionID: childID,
              model: pf.persona.model,
              tree: `${tree.path}${tree.branch ? ` (${tree.branch}${tree.dirty ? `, ${tree.dirty} dirty` : ""})` : ""}`,
              hash: built.hash,
              bytes: built.prompt.length,
              note: pf.warnings.length ? pf.warnings.map((w: any) => w.message).join("; ") : "child reports back when each round completes",
            }),
          }
        },
      })
    })
  },
} satisfies Plugin
