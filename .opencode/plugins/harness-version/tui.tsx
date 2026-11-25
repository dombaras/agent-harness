import { Plugin } from "@opencode/plugin/tui"
import { formatHarnessBadge, readHarnessRestart, readHarnessUpdate, readHarnessVersion } from "./version.mjs"

// A constant "harness vX.Y.Z" badge in the two footer rows that already carry
// version/model indicators:
//   * home.footer.status   — after opencode's health indicators, before its own
//                            version, so the two read side by side;
//   * prompt.footer.status — the session composer footer, beside the model.
// The version comes from the checkout's `.harness.json`, so it tracks what
// `agent-harness update` deployed. A repo without that file gets no badge.
// When the cached registry probe (scripts/harness-update.js, F-023) reports a
// newer harness, the badge appends `↑<latest>` in the warning colour — the same
// "Update available" affordance opencode shows for itself.
// When the global `harness-freshness` plugin reports `restart-needed` (the
// deployed version is current but the running server predates the last write),
// the badge appends `↻restart` so it never reads as "the new version is active".
export default Plugin.define({
  id: "harness-version-badge",
  setup(context) {
    // `context.location` is set in a session; on the home screen fall back to
    // the active location so the badge also sits beside opencode's version.
    // Resolved on every render too: the active location can become available
    // (or change to a worktree) after setup, and a pinned directory would read
    // another checkout's `.harness.json` and verdicts (F-038).
    const resolveDirectory = () => {
      const live = context.location?.directory
      if (typeof live === "string" && live) return live
      try {
        return context.data.location.default()?.directory
      } catch {
        return undefined
      }
    }
    const setupDirectory = resolveDirectory()
    // The version this TUI/plugin process actually loaded. It is the best
    // local evidence of the build in memory when a later deploy rewrote
    // `.harness.json`; `formatHarnessBadge` compares it with the on-disk read.
    const loaded = readHarnessVersion(setupDirectory)
    if (!loaded) return
    // Read the verdicts inside `badge`, not at setup: a new/cleared/compacted
    // session re-probes the registry and rewrites `.serve/harness-update.json`,
    // so the footer must pick up the fresh arrow/version on the next render
    // instead of pinning the verdict from process start.
    const badge = () => {
      const directory = resolveDirectory() || setupDirectory
      const current = readHarnessVersion(directory) || loaded
      const update = readHarnessUpdate(directory)
      const restart = readHarnessRestart(directory)
      const text = formatHarnessBadge({ current, loaded, update, restart })
      if (!text) return null
      const color = update || restart
        ? ((context.theme as any)?.text?.warning ?? context.theme.text.muted)
        : context.theme.text.muted
      return <text fg={color}>{text}</text>
    }
    const home = context.ui.slot({ append: "home.footer.status", render: badge })
    const prompt = context.ui.slot({ append: "prompt.footer.status", render: badge })

    return () => {
      if (typeof home === "function") home()
      if (typeof prompt === "function") prompt()
    }
  },
})
