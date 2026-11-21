// The directory plugin's server entrypoint: a no-op. The badge lives in
// `tui.tsx`, which opencode's CLI loads beside this entry. Keeping an explicit
// server entrypoint makes the directory discoverable by the plugin loader.
export default {
  id: "harness-version-server",
  setup() {},
}
