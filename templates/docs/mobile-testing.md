# Mobile / device testing runbook

How an agent boots the Android emulator, installs a build, and runs Maestro
flows **without freezing its own tool call**. The mechanics here are the reason
this doc exists: the naïve way to background the emulator hangs the agent's
`bash` tool forever (no error, no timeout), which looks like "the tests are
taking ages" when in fact nothing is running at all.

## The rule

Any long-lived process — emulator, Metro/dev server, adb server, Maestro driver —
must be launched **detached with its own stdio**, via `scripts/serve.js`:

```bash
node scripts/serve.js start --cmd "<command>" [--url <health url> | --port <n>] [--name <label>] [--timeout <ms>]
node scripts/serve.js list
node scripts/serve.js stop --name <label>
```

`serve.js` spawns with `stdio: "ignore"` in a detached session (POSIX) / its own
hidden console (Windows), records the PID under `.serve/`, and polls the
readiness target with live heartbeats. The tool call returns as soon as the
server is ready.

A **one-shot** heavy command (the APK/Gradle build, a heavy test tier) must run
**capped** too — synchronously, via `run`:

```bash
node scripts/serve.js run --cmd "<one-shot command>" [--name <label>] [--mem-max 3G] [--cpu-max 600%]
```

`run` executes the command in a transient systemd scope with a `MemoryMax`,
streams its output, and returns its exit code; a build that balloons is
OOM-killed inside its own cgroup instead of thrashing the VM. It leaves no
`.serve/` record (there is nothing to stop). An **inline** `./gradlew
assembleRelease` with no cgroup is exactly the 2026-09-30 freeze (Gradle + the
emulator + the dev server filled the 10 GB VM).

## Booting the device tier

**One command brings the whole tier up** (adb server + emulator + app build/install
+ dev server, verified against the health URL), idempotently — reuse it instead of
hand-rolling the ~15 setup calls a device session otherwise needs:

```bash
bash scripts/qa/mobile-e2e/device-up.sh              # full bring-up (reuses what is already up)
bash scripts/qa/mobile-e2e/device-up.sh --no-dev     # emulator + app only
bash scripts/qa/mobile-e2e/device-down.sh            # stop dev server + prune
bash scripts/qa/mobile-e2e/device-down.sh --emulator # also stop the emulator (session end)
```

`device-up.sh` sequences the lower-level primitives, which you can still call
directly. The **adb-server + emulator** primitive brings the adb server up first
(detached via `serve.js`, because a bare `adb devices`/`adb start-server` hangs
forever when the server is down — the forked daemon is reaped with the tool's
process group), then the emulator, then runs a **bounded** readiness gate. It is
safe to re-run — an already-booted emulator and a live adb server are reused — and
it reads the AVD from `scripts/qa/mobile-e2e/local.json` / `MOBILE_E2E_AVD`:

```bash
node scripts/qa/mobile-e2e/boot-emulator.sh          # auto-sizes CPU/RAM/GPU to the box
node scripts/qa/mobile-e2e/boot-emulator.sh --print-profile   # preview the resolved profile as JSON
```

It expands to (adb server, then emulator, then a bounded gate):

```bash
node scripts/serve.js prune
node scripts/serve.js start --cmd "~/android-sdk/platform-tools/adb -a nodaemon server" \
  --name adb-server --port 5037 --timeout 30000
node scripts/serve.js start --group mobile \
  --cmd "~/android-sdk/emulator/emulator -avd <avd> -no-window -no-audio -no-boot-anim -no-snapshot -cores <n> -memory <mb> -gpu <backend>" \
  --name emulator --port 5554 --timeout 180000
timeout 90 adb wait-for-device
timeout 10 adb shell getprop sys.boot_completed   # must print 1
```

**Right-sizing** (the device tier is the slowest, heaviest part of a run):
`boot-emulator.sh` derives the profile instead of hardcoding it —
`cores = min(AVD hw.cpu.ncore, nproc − reserve)`, guest RAM from the envelope's
`emulator_ram_mb` (the single owner of that number), and the GPU backend is
auto-detected (`host` only when a real renderer answers, else
`swiftshader_indirect`; `-gpu host` on a box whose only renderer is `llvmpipe` is
software GL anyway). Override any of them with `MOBILE_E2E_CORES`,
`MOBILE_E2E_MEMORY`, `MOBILE_E2E_GPU`.

### GPU acceleration on WSL2 (the biggest wall-clock lever)

On a software renderer the emulator is CPU-bound — ~2.5 s/command, ~3.6 s/tap
(F-291/F-296), pinned near 3 cores just compositing. WSL2 can pass the Windows
GPU through, but Mesa does **not** use it by default, and the DRM node is often
missing too, so `boot-emulator.sh` silently resolves to `swiftshader_indirect`
even on a capable box. Two things are needed, both handled by
`scripts/wsl-gpu.sh`:

1. **Load `vgem`.** Modern WSL kernels (≥ 2.5) ship the DRM module but do not
   auto-load it, so `/dev/dri` is absent and every GL app falls back to
   `llvmpipe` (WSL issues [#12702](https://github.com/microsoft/WSL/issues/12702),
   [#11837](https://github.com/microsoft/WSL/issues/11837)).
2. **Select the `d3d12` driver.** Even with `/dev/dri` present, Mesa still picks
   `llvmpipe` unless `GALLIUM_DRIVER=d3d12` (with `/usr/lib/wsl/lib` on the
   loader path) is set.

```bash
bash scripts/wsl-gpu.sh status    # diagnose: /dev/dxg, vgem, d3d12 renderer
bash scripts/wsl-gpu.sh apply     # load + persist vgem, verify d3d12 (auto-sudo)
```

Once active, `glxinfo -B` reports `D3D12 (<Windows GPU>)` and `Accelerated: yes`,
and `boot-emulator.sh --print-profile` resolves `gpu: "host"` with a `gpuEnv`
that exports the two variables to the emulator (serve.js forwards the caller's
env), plus a `gpuExtra` of `-feature -Vulkan`. **Vulkan must be disabled on this
path**: the emulator's gfxstream Vulkan backend segfaults qemu mid-boot under
Mesa `d3d12` (the `Segmentation fault (core dumped)` that made every F-296 run
fall back to the software rasterizer), while GLES-over-`host` on d3d12 is stable
and hardware-accelerated. Verified on this box: `-gpu host -feature -Vulkan`
boots to `D3D12 (Intel(R) Graphics)` in ~20 s; `-gpu host` without it crashes. Verification on this box: before — `llvmpipe`, `Accelerated: no`; after —
`D3D12 (Intel(R) Graphics)`, `Accelerated: yes`. The script is a no-op outside
WSL (no `/dev/dxg`). The Huawei/Xiaomi/etc. GPU must have a WSL-capable driver
(the Intel/AMD/NVIDIA "WSL" driver); if `apply` loads `vgem` but d3d12 still
reports software, `wsl --shutdown` from Windows and retry.

The emulator joins the machine-wide **`mobile` tier group** (`--group mobile`):
the emulator and the dev server are two heavy processes that legitimately run
together for device E2E, so they share ONE budgeted tier instead of tripping the
single-heavy-tier lock. Start the dev server in the same group (see below). A
third, unrelated heavy tier is still refused.

The group shares ONE **combined** memory budget (`group_mem_max_mb`, default 7 GB):
each member's per-process cap is generous (a 2048 MB AVD peaks ~4.4 GB RSS), so
`serve.js` tightens a new member to the group's remaining budget instead of letting
emulator + dev server each take 5 GB and fill the VM. An explicit `--mem-max` wins;
a near-exhausted budget refuses (`--force` overrides).

### Building the APK (always capped)

`scripts/qa/mobile-e2e/build-apk.sh` builds the release APK: it runs `expo prebuild`
only when `mobile/android/` is absent, patches `usesCleartextTraffic` into the
generated manifest, right-sizes Gradle (no daemon, one worker, one ABI, 1 GB heap),
and runs `assembleRelease` through `serve.js run` (default `mem≤3G`). Run the
build BEFORE the dev server is up, and never call `./gradlew assembleRelease`
inline — that is the 2026-09-30 freeze. `device-up.sh` calls it automatically:

Every adb call is `timeout`-wrapped: a wedged adb fails fast instead of hanging
the tool. `run-maestro.js` also preflights adb (10 s probe) and exits with the
exact recovery step rather than blocking. `serve.js list`/`start` auto-prune dead
`.serve/` records, so a stale adb-server/emulator entry from a killed session
cannot misreport the machine.

On Linux with a systemd user bus, `--mem-max`/`--cpu-max` put the emulator in
its own cgroup: if it runs away it is throttled or OOM-killed *inside the unit*
rather than dragging the whole WSL VM into swap-thrash. They are ignored with a
warning elsewhere.

- **Size it to the box.** The emulator is a heavy tier: software rendering
  (`-gpu swiftshader_indirect`) pins a core and *still* used ~3 GB in the
  2026-09-29 freeze (QEMU + software-GPU overhead far above `hw.ramSize`) — the
  observed QEMU RSS at a 2048 MB guest is ~4.4 GB. `boot-emulator.sh` right-sizes
  cores to the host (a fixed 2 cores made QEMU the bottleneck on an 8-vCPU box),
  reads guest RAM from the envelope, and picks the GPU backend automatically.
  Keep `heavy_mem_max_mb` ≥ `emulator_ram_mb` + ~2 GB, or the emulator is
  OOM-killed inside its own cgroup. `serve.js` refuses a heavy launch that would
  exceed the capacity envelope (`.agents/memory/orchestration.md`) — stop another
  tier first, or `--force` to override deliberately.
- The SDK path and AVD name are per-project. On WSL2 the active AVD is
  `libraryos`. The emulator exposes the adb port at **5554**, which is what
  `--port` probes.
- A full cold boot takes ~30 s; `--timeout 120000` gives headroom. A start
  prints a "launching" line up front, so an in-progress wait is never silent.
- On a systemd-less WSL there is no `/run/user/<uid>`; the emulator aborts
  (`Aborted (core dumped)`) without a writable `XDG_RUNTIME_DIR`. `boot-emulator.sh`
  resolves a private temp runtime dir automatically, so this is not a manual step.
- The dev server is a **separate** detached process, but part of the same device
  tier — start it in the **same group** so the pair is budgeted as one:
  `node scripts/serve.js start --cmd "npm run dev" --url http://localhost:3000 --name app-dev --group mobile`.

### Startup speed: content-addressed APK cache + quickboot

The cold `assembleRelease` dominates the tier (7-11 min on a fresh worktree; the
reanimated/worklets C++ compile, new-arch codegen, and dex merge are the cost).
Almost all of it is invariant across worktrees for a fixed dependency set — only
the JS bundle changes. `scripts/qa/mobile-e2e/apk-cache.js` content-addresses each
stage so the invariant work is done once:

```
~/.cache/agent-harness/mobile-e2e/
├── native/<nativeKey>/base.apk      native shell  (deps/toolchain; ignores JS)
├── bundle/<bundleKey>/              Hermes bundle + exported assets (JS sources)
└── apk/<fullKey>/app-release.apk    ready-to-install APK (native + JS)
```

`build-apk.sh` (and therefore `device-up.sh`) tries, in order: **full-key hit →
overlay → full build**. The overlay re-bundles only JS, drops it into the cached
native base, and re-signs with the app's debug keystore (`zipalign` +
`apksigner`); it never touches `resources.arsc`, and it declines (falling back to
Gradle) if the bundle references an asset the base lacks or if any verify step
fails. It is a pure accelerator — correctness never depends on it. Measured on
LibraryOS: **~7 s warm / ~20-30 s cold** for the overlay versus minutes for a
cold build.

| env | default | effect |
| --- | --- | --- |
| `MOBILE_E2E_SKIP_CACHE` | `0` | `1` bypasses the cache entirely |
| `MOBILE_E2E_APK_OVERLAY` | `1` | `0` disables the overlay (full build on JS change) |
| `MOBILE_E2E_SNAPSHOT` | `1` | `0` disables the emulator quickboot snapshot |
| `MOBILE_E2E_SNAPSHOT_NAME` | `agent-e2e` | snapshot name |
| `MOBILE_E2E_OVERLAP` | `1` | `0` starts the dev server after the boot, not with it |

- **Gradle reuse.** The managed `gradle.properties` block now enables
  `org.gradle.caching` (shared local cache in `~/.gradle`) and the configuration
  cache, and the assemble runs with `--build-cache --configuration-cache`, so a
  fresh worktree reuses invariant task outputs instead of recompiling.
- **Prewarm off the critical path.** `scripts/qa/mobile-e2e/prewarm.sh` warms the
  cache (hit/overlay/build, capped) and is idempotent; `prewarm.sh --detach`
  runs it in the background. Set `AGENT_HARNESS_PREWARM=1` to have
  `agent-harness update` launch it automatically. It obeys the capacity envelope
  (`prewarm.sh` classifies as an "apk build" one-shot), so it refuses when a
  heavy tier is live rather than thrashing the VM.
- **Quickboot snapshot.** `boot-emulator.sh` boots with `-snapshot agent-e2e`
  when enabled, so a warm snapshot turns the ~40-60 s cold boot into seconds.
  Because a snapshot is stateful, a failed boot retries once **cold** before the
  GPU fallback; `device-down.sh --emulator` saves the snapshot before stopping.
- **Overlap.** The dev-server start (independent of the device) runs
  concurrently with the emulator boot; the install joins both. `device-up.sh`
  prints `device-up:timings {…}` per phase and appends it to
  `.serve/device-up-timings.jsonl`.

### Readiness gate (never `sleep`-and-pray)

```bash
adb wait-for-device
adb shell getprop sys.boot_completed   # must print 1
```

Only then `adb install -r <apk>` and run flows. Both are synchronous one-shots —
run them inline and let output stream; never pipe a run through a buffering
filter (`| tail`, redirect-to-file-then-read), or it looks frozen and gets
aborted mid-flight.

## Making a full run fast and observable

A full multi-journey Maestro matrix on a software-rendered emulator can take tens
of minutes. The runner (`scripts/qa/mobile-e2e/run-maestro.js`, harness-owned)
carries a performance layer; coverage and assertions are unchanged:

1. **Launch detached, then get notified — do NOT sleep/poll.** Never block the
   tool for the whole run, and never guess a finish time with `sleep N; grep`.
   The helper runs the matrix with its own session/stdio and writes a
   machine-readable job:

   ```bash
   scripts/qa/mobile-e2e/run-detached.sh --flows all --reuse-session
   ```

   It writes `<jobdir>/<id>.events.jsonl` (one JSON line per scenario: start,
   pass/fail, fail-fast, done) plus `<jobdir>/<id>.json` (pid + log + events
   paths). The `job-notify` opencode plugin tails the stream and turns it into a
   **push**: a TUI toast per scenario (live progress with no LLM turn), and a
   message injected back into the session (`session.promptAsync`) on the **first
   failure** and at **completion** — so the agent resumes on real results instead
   of polling. The report lands at `.serve/mobile-e2e-last-run.json`.

   **To block for the run's exit code, prefer the async `wait` TOOL, not a
   `--wait` shell call.** The general `wait` tool (`scripts/wait-for.js`, e.g.
   `wait --job <record.json>`) spawns its child asynchronously, so it does
   **not** freeze opencode's event loop — the plugin's toasts and
   first-failure/completion wakes keep flowing while the agent waits. (Before
   0.1.115 the `wait` tool used `execFileSync` and starved the notifier: every
   event flushed in one burst when the wait returned, which is why the F-296 run
   looked frozen.)

   `--wait` on the helper is the **headless fallback** (no plugin watching, e.g.
   a bare CI shell). It blocks the calling shell for the entire run:

   ```bash
   # headless only — from an agent `bash` call this holds the tool for the whole
   # matrix and leaves the transcript blind (the F-296 resume did exactly this).
   scripts/qa/mobile-e2e/run-detached.sh --flows all --reuse-session --wait
   ```

   Because that foot-gun recurs, `run-detached.sh` prints a loud warning before
   blocking. From an agent session: launch detached, then either let the plugin
   push, or call the `wait` tool — never `--wait`.

2. **`--reuse-session`** reuses the device session and signs in only when there
   is none, batching consecutive same-actor, setup-free journeys into one
   `maestro test` invocation (fewer JVMs). The shared
   `flows/_shared/session.yaml` subflow **never `clearState`s** — it launches
   without clearing, signs the current actor out when the journey's `actor:`
   (in `flows/matrix.yaml`) changes (`MOBILE_E2E_SWITCH=1`), and signs in as the
   target actor.    This is the single biggest wall-clock win. Omit it for a strict
   per-journey run (the default still switches session per flow, but no longer
   clears app data). The runner also **regroups the selected flows by actor**
   (firstLogin first, then each actor's standalone setup/oracle/`endsAs` flows
   before its setup-free run) so a batch is never interrupted by an unrelated
   flow. Alphabetical order otherwise scattered an actor's journeys among
   standalone flows — the F-296 run batched just 2 of 26 journeys (24
   invocations).

   **First login is one dedicated scenario.** The first-login walkthrough is
   gated on a per-member `AsyncStorage` flag, and `clearState` (`pm clear`)
   wipes it for *every* member. So exactly one journey declares
   `firstLogin: true` in `flows/matrix.yaml`: it is run **first** and alone, it
   is the only place that `clearState`s, and it asserts the fresh
   onboarding/walkthrough. Every other journey reuses a mixed set of sessions
   and never sees the walkthrough. Ordering the `clearState` first stops its
   app-data wipe from resetting the sessions the rest of the run depends on.
3. **Animations are disabled** for the run by `config.yaml`
   (`platform.android.disableAnimations: true`, passed via `maestro test
   --config`), removing the per-command animation-settle wait. Override with
   `--config <file>`.
4. **`--no-seed`** runs `reset.js --no-seed` (mint actor auth, keep the seeded
   data) so a re-verification run skips the full DB seed.
5. **`--failed`** re-runs only the journeys that failed last time, from
   `.serve/mobile-e2e-last-run.json` (written after every run). Iterate on the
   failing subset, then do one full pass at the end.
6. **`--max-same-reason`** (default 3) is the fail-fast stop. Leave the default
   for a verification run so a systemic break stops early; pass `0` only for a
   full attribution sweep that must touch every journey.
7. The Maestro driver APKs are **not reinstalled** per invocation
   (`--no-reinstall-driver`); pass `--reinstall-driver` only if the driver is
   suspect.

Project-specific defaults (app id, default actor) live in
`scripts/qa/mobile-e2e/local.json` — project-owned, not overwritten by the
harness. The mechanism (`run-maestro.js`, `check-flows.js`, `config.yaml`,
`boot-emulator.sh`, `run-detached.sh`, `job-events.js`) plus the `job-notify`
plugin are harness-owned under `templates/`, so fix them upstream and
`agent-harness update` the projects.

## Reuse vs. stop

- **Reuse** the emulator across runs *within a session* — leave it booted
  between tiers so a cold boot is not paid twice. Never kill an emulator you
  didn't start.
- **Stop the emulator at session end**, and a dev server as soon as its tier is
  done: `node scripts/serve.js stop --name <label>` (or `stop-all`). An idle
  emulator left up for hours held ~3 GB and was a direct contributor to the
  2026-09-29 freeze. You do not have to remember: `serve.js` records the owning
  session and **auto-closes** the serve — `reap` stops one whose owner's lease is
  gone/stale (or an untagged one past `idle_reap_minutes` with no recent log
  activity) and reconciles an untracked `agent-serve-*` unit from a killed
  session. `reap` runs at every `start` and when the context-guard plugin sees
  `session.deleted`, so an abandoned emulator/dev server is not kept alive.
- `node scripts/serve.js list` is the machine view: capacity (free RAM / swap /
  load / live serves) plus each process's age and whether it is heavy. Treat an
  old process as an idle-reap candidate; `npm run test:capacity` fails when the
  envelope is already exceeded.

## Anti-pattern that hangs the agent

```bash
# DO NOT DO THIS
setsid bash -c '~/android-sdk/emulator/emulator -avd <avd> … > /tmp/emulator.log 2>&1' < /dev/null &
```

The redirect lands on the **inner** command, not on the detached `bash -c`
wrapper. The wrapper therefore keeps the agent tool's stdout/stderr socket open
and stays alive as the emulator's parent — so the launch call never sees EOF and
subtly "runs" forever. No timeout fires, because the launched shell itself
already exited; the agent is simply blocked. The same failure hits a plain
trailing `&` (the process tree stays attached to the tool's console).

If you must launch by hand, redirect the wrapper's own fds:

```bash
setsid sh -c 'exec ~/android-sdk/emulator/emulator -avd <avd> …' </dev/null >/tmp/emulator.log 2>&1 &
```

## Recovering an already-wedged run

1. Interrupt the hung tool call in the agent (or restart the session).
2. **Keep the emulator** — it booted fine; verify with `adb devices` and
   `adb shell getprop sys.boot_completed`. Do not reboot it.
3. If the detached wrapper still lingers, confirm ownership before killing it:
   `node scripts/serve.js list` and check the PID's session/parent. Never kill an
   emulator you didn't start.
4. Relaunch through `serve.js` per this runbook before continuing.

See also: [wsl-optimizations.md](wsl-optimizations.md) (why WSL2 is the primary
environment) and `.agents/skills/mobile-engineer/SKILL.md` (the persona's device
rules).
