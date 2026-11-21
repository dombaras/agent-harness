import { Plugin } from "@opencode/plugin/tui"
import { readHarnessVersion } from "./version.mjs"

// A constant "harness vX.Y.Z" badge in the two footer rows that already carry
// version/model indicators:
//   * home.footer.status   — after opencode's health indicators, before its own
//                            version, so the two read side by side;
//   * prompt.footer.status — the session composer footer, beside the model.
// The version comes from the checkout's `.harness.json`, so it tracks what
// `agent-harness update` deployed. A repo without that file gets no badge.
export default Plugin.define({
  id: "harness-version-badge",
  setup(context) {
    // `context.location` is set in a session; on the home screen fall back to
    // the active location so the badge also sits beside opencode's version.
    let directory = context.location?.directory
    if (!directory) {
      try {
        directory = context.data.location.default()?.directory
      } catch {
        directory = undefined
      }
    }
    const version = readHarnessVersion(directory)
    if (!version) return

    const badge = () => <text fg={context.theme.text.muted}>harness v{version}</text>
    const home = context.ui.slot({ append: "home.footer.status", render: badge })
    const prompt = context.ui.slot({ append: "prompt.footer.status", render: badge })

    return () => {
      if (typeof home === "function") home()
      if (typeof prompt === "function") prompt()
    }
  },
})
