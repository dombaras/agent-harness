#!/usr/bin/env bash
#
# mobile E2E — build the release APK the device run installs, CAPPED.
#
# Why this exists: the Android release build is a Gradle daemon + Kotlin daemon
# + R8/D8 job that can take several GB. On 2026-09-30 it ran inline as
# `bash .../build-dev-apk.sh` — no `serve.js`, no cgroup cap, no envelope
# preflight — while the emulator and the dev server were already up; the three
# together filled the 10 GB WSL VM, thrashed swap, and starved the host<->VM
# relay so every terminal froze at once. This wrapper runs the one-shot build
# through `serve.js run`, which puts it in a transient systemd scope with a
# `MemoryMax` (default 3 GB, `MOBILE_E2E_APK_MEM_MAX` overrides) so a runaway is
# OOM-killed inside its own cgroup instead of freezing the box, and it right-sizes
# Gradle (single worker, no daemon, one ABI, small heap) so the build fits.
#
# The app must be a RELEASE build with its JS bundle embedded: a debug / Metro
# dev-client build is the F-288 `clearState` blocker (`clearState` wipes the
# dev-server URL). The bundle also bakes the dev backend URL, and the generated
# Android manifest must allow cleartext HTTP to `10.0.2.2:3000`.
#
# Order is always: prebuild (only when the android project is absent) -> PATCH
# cleartext -> assemble. `expo prebuild` re-writes AndroidManifest.xml and DROPS
# `usesCleartextTraffic`, so we never prebuild over an existing project.
# cleartext is NEVER set in `mobile/app.json` — production would inherit it; it
# is patched into the generated (gitignored) manifest only.
#
# Caching (apk-cache.js): the native shell and the JS bundle are content-
# addressed independently, so a fresh worktree reuses the invariant native
# compile and only re-bundles JS. Order: full-key cache hit -> native-base +
# fresh-bundle OVERLAY (re-sign only) -> full Gradle build. The cache is a pure
# accelerator: any miss or doubt falls through to a real build, and the overlay
# never touches resources.arsc.
#
# Android SDK: resolved from the conventional locations and exported for Gradle
# (`ANDROID_HOME` / `ANDROID_SDK_ROOT`, then `~/android-sdk`), mirroring
# `device-up.sh`. A headless run (the nightly systemd timer, CI) has a stripped
# env with no `ANDROID_HOME`, so the Gradle Android plugin aborts
# "SDK location not found" before it configures — this wrapper is self-contained,
# so no project needs an env shim.
#
# Project config: `scripts/qa/mobile-e2e/local.json` (`appId`, `avd`); the paths
# below follow the conventional Expo/React-Native layout. Tunables (env):
#   MOBILE_E2E_APK           output APK path (default: conventional Gradle path)
#   MOBILE_E2E_ABI           ABI to build      (default: x86_64 — the emulator)
#   MOBILE_E2E_APK_MEM_MAX   cgroup MemoryMax  (default: 6G — a cold release
#                            D8/dex-merge needs ~4-6 GB; 3G OOMs)
#   MOBILE_E2E_APK_CPU_MAX   cgroup CPUQuota   (default: 600%)
#   MOBILE_E2E_SKIP_CACHE    set 1 to bypass the cache entirely
#   MOBILE_E2E_APK_OVERLAY   set 0 to disable the native-base overlay (full
#                            build on every JS change instead)
#
# Usage:
#   scripts/qa/mobile-e2e/build-apk.sh [--api-url http://10.0.2.2:3000]
#
# Output: the release APK path on success (also echoed as `APK=...`).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
MOBILE_DIR="${ROOT}/mobile"
ANDROID_DIR="${MOBILE_DIR}/android"
MANIFEST="${ANDROID_DIR}/app/src/main/AndroidManifest.xml"
APK="${MOBILE_E2E_APK:-${ANDROID_DIR}/app/build/outputs/apk/release/app-release.apk}"
ABIS="${MOBILE_E2E_ABI:-x86_64}"
MEM_MAX="${MOBILE_E2E_APK_MEM_MAX:-6G}"
CPU_MAX="${MOBILE_E2E_APK_CPU_MAX:-600%}"

API_URL="http://10.0.2.2:3000"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --api-url) API_URL="$2"; shift 2 ;;
    --api-url=*) API_URL="${1#*=}"; shift ;;
    -h|--help) grep '^#' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "FAIL: node is not on PATH" >&2; exit 1; }
[ -d "$MOBILE_DIR" ] || { echo "FAIL: no mobile/ project at $MOBILE_DIR" >&2; exit 1; }

# Resolve the Android SDK and export it for Gradle. A headless invocation (the
# nightly systemd timer, CI) runs with a stripped env that has no ANDROID_HOME,
# so the Gradle Android plugin aborts "SDK location not found" before it even
# configures. Mirror device-up.sh's default so this wrapper is self-contained —
# no project-side shim is needed (F-331).
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"

echo "Mobile E2E release APK build (capped: mem≤${MEM_MAX}, cpu≤${CPU_MAX}, abi=${ABIS})"
echo "  repo:    ${ROOT}"
echo "  api url: ${API_URL}"
echo "  sdk:     ${SDK}"
echo ""

# The bundle key bakes the API URL, so the cache and the build must agree on it.
export MOBILE_E2E_API_URL="${API_URL}"
CACHE_JS="${ROOT}/scripts/qa/mobile-e2e/apk-cache.js"

# An APK is only usable if the embedded bundle actually targets the requested
# backend. `EXPO_PUBLIC_API_URL` is NOT a Gradle task input, so a previous build
# for a different backend (e.g. a Play/EAS `preview` build that baked uat) left
# `createBundleReleaseJsAndAssets` UP-TO-DATE and shipped the old URL — F-331:
# the emulator called `ekedio-uat.vercel.app`, where the dev-minted actors do
# not exist, so every valid login 401'd and the whole matrix failed. Verify
# BEFORE caching, so a wrong-URL APK is never stored under a dev cache key.
verify_baked_api_url() {
  local apk="$1"
  if [ ! -f "$apk" ]; then
    echo "FAIL — APK not found at $apk" >&2
    return 1
  fi
  # No `grep -q` here: under `set -o pipefail`, grep exiting on its first match
  # SIGPIPEs `unzip` (exit 141) and fails the pipeline even though the URL was
  # found. Drain the stream instead so the exit code is grep's.
  if ! unzip -p "$apk" assets/index.android.bundle 2>/dev/null | grep -a -F -- "$API_URL" >/dev/null; then
    echo "FAIL — $apk does not bake EXPO_PUBLIC_API_URL=$API_URL" >&2
    echo "       A stale Gradle createBundleReleaseJsAndAssets output was reused." >&2
    echo "       Delete mobile/android/app/build/generated/{assets,res}/react and rebuild." >&2
    return 1
  fi
}

# 0. Reuse before building. A full-key hit means native + JS are unchanged; the
#    overlay re-signs a fresh bundle onto the cached native base. Both are pure
#    accelerators — any failure (exit != 0) falls through to the Gradle build.
if [ "${MOBILE_E2E_SKIP_CACHE:-0}" != "1" ] && [ -f "${CACHE_JS}" ]; then
  if hit="$(node "${CACHE_JS}" get 2>/dev/null)"; then
    if verify_baked_api_url "$hit"; then
      echo "cache hit (native + JS unchanged): reusing ${hit}"
      echo ""
      echo "APK=${hit}"
      exit 0
    fi
    echo "  cached APK ignored (wrong baked API URL); rebuilding"
  fi
  if [ "${MOBILE_E2E_APK_OVERLAY:-1}" != "0" ]; then
    if hit="$(node "${CACHE_JS}" overlay 2>/dev/null)"; then
      if verify_baked_api_url "$hit"; then
        echo "cache overlay (native base + fresh JS bundle): ${hit}"
        echo ""
        echo "APK=${hit}"
        exit 0
      fi
      echo "  overlaid APK ignored (wrong baked API URL); building"
    fi
  fi
  echo "cache miss — building (override with MOBILE_E2E_SKIP_CACHE=1)"
fi

# 1. Generate the native project only when it is absent. Never prebuild over an
#    existing android/ (it would wipe the cleartext patch below).
if [ ! -d "${ANDROID_DIR}" ]; then
  echo "-> android/ project missing; running 'npx expo prebuild -p android'"
  (cd "${MOBILE_DIR}" && npx expo prebuild -p android)
fi

# 2. Ensure the manifest allows cleartext to the emulator dev backend. Idempotent:
#    a no-op when the attribute is already present.
echo "-> ensuring android:usesCleartextTraffic=\"true\" in the generated manifest"
node - "${MANIFEST}" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
let xml = fs.readFileSync(file, 'utf8');
if (xml.includes('android:usesCleartextTraffic')) {
  console.log('   already present');
} else if (/<application\b[^>]*>/.test(xml)) {
  xml = xml.replace(/<application\b/, '<application android:usesCleartextTraffic="true"');
  fs.writeFileSync(file, xml);
  console.log('   patched');
} else {
  console.error('   FAIL: no <application> element found in ' + file);
  process.exit(1);
}
NODE

# 3. Right-size Gradle for a ~10 GB VM. mobile/android/ is gitignored and
#    regenerated by `expo prebuild`, so the tuning lives in one MANAGED block at
#    the end of gradle.properties (marked `safe to delete`). The block is
#    REFRESHED each run, not merely appended once: a cold release `mergeDexRelease`
#    (D8) needs ~4-6 GB, so a stale or hand-edited 1 GB heap OOMs (F-296), and a
#    later `expo prebuild` that regenerates the file would otherwise leave two
#    competing `org.gradle.jvmargs`. Workers + the Kotlin daemon are separate
#    processes, but they share this one capped cgroup — keep the sum under MEM_MAX.
GRADLE_PROPS="${ANDROID_DIR}/gradle.properties"
node - "$GRADLE_PROPS" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const MARKER = "# agent-harness mobile E2E build tuning (managed; safe to delete)";
let text = "";
try { text = fs.readFileSync(file, "utf8"); } catch (_) { text = ""; }
const at = text.indexOf(MARKER);
if (at !== -1) text = text.slice(0, at); // drop our own block (and anything after it)
text = text.replace(/\s*$/, "");
const block =
  "\n" +
  MARKER +
  "\n" +
  "org.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=768m\n" +
  "org.gradle.parallel=false\n" +
  "org.gradle.workers.max=1\n" +
  "kotlin.daemon.jvmargs=-Xmx1024m\n" +
  // Reuse invariant task outputs across worktrees (the shared build cache lives
  // in the common ~/.gradle). The configuration cache skips re-configuring the
  // project each run; `problems=warn` degrades to a normal configure instead of
  // failing if a React-Native/Expo plugin is not yet configuration-cache safe.
  "org.gradle.caching=true\n" +
  "org.gradle.configuration-cache=true\n" +
  "org.gradle.configuration-cache.problems=warn\n";
fs.writeFileSync(file, text + block);
NODE

# 4. Assemble the release APK inside a capped cgroup, with the dev backend URL
#    baked into the JS bundle. `serve.js run` streams output and returns the
#    build's exit code; a Gradle runaway is OOM-killed in its own scope, not the
#    whole VM. One ABI (the emulator's) keeps the native build from compiling
#    all four.
#
#    Delete the generated bundle tree first: `EXPO_PUBLIC_API_URL` is read at
#    task execution but is not a task input, so Gradle keeps
#    `createBundleReleaseJsAndAssets` UP-TO-DATE from a build that baked a
#    different backend (F-331: a stale uat bundle shipped and every login 401'd).
rm -rf "${ANDROID_DIR}/app/build/generated/assets/react" "${ANDROID_DIR}/app/build/generated/res/react"
echo "-> serve.js run: ./gradlew assembleRelease (EXPO_PUBLIC_API_URL=${API_URL})"
GRADLE_CMD="cd \"${ANDROID_DIR}\" && EXPO_PUBLIC_API_URL=\"${API_URL}\" ./gradlew --no-daemon --build-cache --configuration-cache --max-workers=1 -PreactNativeArchitectures=${ABIS} assembleRelease"
node "${ROOT}/scripts/serve.js" run \
  --name apk-build \
  --mem-max "${MEM_MAX}" \
  --cpu-max "${CPU_MAX}" \
  --cmd "${GRADLE_CMD}"

verify_baked_api_url "${APK}" || exit 1

# 5. Populate the cache for the next run/worktree (best-effort): the native base
#    (reused by the overlay) and the full-key artifact (instant no-op reuse).
#    Only a verified APK is stored, so a wrong-URL bundle can never poison a dev
#    cache key (the verification above already ran).
if [ "${MOBILE_E2E_SKIP_CACHE:-0}" != "1" ] && [ -f "${CACHE_JS}" ]; then
  node "${CACHE_JS}" base-put "${APK}" >/dev/null 2>&1 || true
  node "${CACHE_JS}" put "${APK}" >/dev/null 2>&1 || true
fi

echo ""
echo "OK — release dev APK built:"
echo "APK=${APK}"
