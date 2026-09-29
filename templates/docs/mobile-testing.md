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

## Booting the emulator

```bash
node scripts/serve.js start --heavy \
  --cmd "~/android-sdk/emulator/emulator -avd <avd> -no-window -no-audio -no-boot-anim -no-snapshot -cores 2 -memory 2048 -gpu host" \
  --name emulator --port 5554 --timeout 120000
```

- **Size it to the box.** The emulator is a heavy tier: software rendering
  (`-gpu swiftshader_indirect`) pins a core and *still* used ~3 GB in the
  2026-09-29 freeze (QEMU + software-GPU overhead far above `hw.ramSize`). Prefer
  a host GPU (`-gpu host`) when one is available; otherwise cap it with
  `-cores 2 -memory 2048`. `serve.js` will refuse to start a heavy process when
  the capacity envelope (`.agents/memory/orchestration.md`) is already exceeded —
  stop another tier first, or `--force` to override deliberately.
- The SDK path and AVD name are per-project. On WSL2 the active AVD is
  `libraryos`. The emulator exposes the adb port at **5554**, which is what
  `--port` probes.
- A full cold boot takes ~30 s; `--timeout 120000` gives headroom. A start
  prints a "launching" line up front, so an in-progress wait is never silent.
- The dev server is a **separate** detached process — and a second heavy tier,
  so run it *after* a device-only tier, not alongside:
  `node scripts/serve.js start --cmd "npm run dev" --url http://localhost:3000 --name app-dev`.

### Readiness gate (never `sleep`-and-pray)

```bash
adb wait-for-device
adb shell getprop sys.boot_completed   # must print 1
```

Only then `adb install -r <apk>` and run flows. Both are synchronous one-shots —
run them inline and let output stream; never pipe a run through a buffering
filter (`| tail`, redirect-to-file-then-read), or it looks frozen and gets
aborted mid-flight.

## Reuse vs. stop

- **Reuse** the emulator across runs *within a session* — leave it booted
  between tiers so a cold boot is not paid twice. Never kill an emulator you
  didn't start.
- **Stop the emulator at session end**, and a dev server as soon as its tier is
  done: `node scripts/serve.js stop --name <label>` (or `stop-all`). An idle
  emulator left up for hours held ~3 GB and was a direct contributor to the
  2026-09-29 freeze.
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
