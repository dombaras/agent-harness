# WSL2 / agentic-development optimizations

Four harness-managed, re-runnable mechanisms that keep recursive work cheap and
the VM healthy on a 10 GB / 10 CPU WSL2 box while staying safe outside it:

1. **Ignore-aware search** — a canonical `.ignore` plus `scripts/agent-search.sh`
   so recursive discovery never walks `node_modules`, `.git`, or build output.
2. **RAM-backed build/cache storage** — `scripts/setup-tmpfs.sh` mounts a tmpfs
   and points cache/build env vars at it.
3. **Machine capacity envelope** — one set of numbers (`.agents/memory/orchestration.md`)
   enforced by `serve.js`, `test:capacity`, the `context-guard` plugin, and
   `agent-harness doctor`, so parallel agents can never stack parallel *heavy
   tiers* into a freeze.
4. **WSL2 GPU acceleration** — `scripts/wsl-gpu.sh` loads `vgem` and selects
   Mesa's `d3d12` driver so the device E2E emulator renders on the Windows GPU
   instead of the CPU software rasterizer.

All are scripts/config/docs only; none touches application source.

## 1. Ignore-aware search

### The canonical ignore file (`.ignore`)

`.ignore` is read by ripgrep and fd (git does **not** read it — `.gitignore`
stays the project's own file and the harness never writes it). `agent-harness
update` merges a harness-managed begin/end block listing the high-cost trees:

```
node_modules/ .git/ .venv/ venv/ __pycache__/ .mypy_cache/ .pytest_cache/
target/ dist/ build/ .next/ .nuxt/ coverage/ .gradle/ .cargo/ vendor/
.terraform/ tmp/ .cache/
```

Project entries outside the markers are preserved; the managed block is replaced
in place, so re-running `update` never duplicates or truncates anything.

### `scripts/agent-search.sh`

A thin ripgrep wrapper that:

- relies on the default ignore files and **never** passes `--no-ignore` or
  `--unrestricted` (it refuses those flags, and `--hidden`, outright);
- excludes lockfiles, minified bundles, source maps, and oversized files via
  `--max-columns` / `--max-filesize`;
- supports `--files` for cheap discovery with no content reads;
- caps output (default 200 lines; `--limit N` / `AGENT_SEARCH_LIMIT`).

```bash
scripts/agent-search.sh --files                 # candidate files, no content read
scripts/agent-search.sh -g '*.ts' 'interface Foo'
scripts/agent-search.sh --limit 50 'TODO'
```

### When to use `git grep` instead

For a **symbol search over tracked files** (where you want the repo's definition
of the file set and nothing generated or untracked), `git grep` reads the git
index and searches tracked files only — no ignore-file dependence, so it is the
deterministic choice for "where is this symbol defined":

```bash
git grep -n 'functionName' -- '*.ts' '*.tsx'   # tracked files only, reads the index
git grep -l 'SymbolName'                       # list matching tracked files
```

Rule of thumb:

- `git grep` — tracked-source symbol search; the index already knows the files
  and ignores are irrelevant. Prefer it for "where is this defined".
- `scripts/agent-search.sh` (rg) — content search that must also see untracked
  files while still honouring the canonical ignores; best for "what changed
  locally / what's generated". On small warm trees raw `rg` is often the fastest
  of all; `git grep` wins on large trees where tracked-only traversal pays off.
- Never `rg --no-ignore` / `rg -u` in an agent workspace — it walks `node_modules`
  and build trees and floods both time and context.

No harness agent/tool config forces `--no-ignore`; if a local wrapper does,
remove it and rely on `.ignore` + explicit `-g` globs.

## 2. RAM-backed build/cache storage

`scripts/setup-tmpfs.sh` mounts a single tmpfs root (default `/mnt/ramdisk`)
sized 25–40 % of WSL RAM (default 30 %), then exports cache/build env vars for
**only the toolchains present**:

| Toolchain | Env |
| --- | --- |
| Python | `PIP_CACHE_DIR` |
| npm | `npm_config_cache` |
| pnpm | `PNPM_STORE_DIR` |
| Yarn | `YARN_CACHE_FOLDER` |
| Cargo | `CARGO_TARGET_DIR` |
| Go | `GOCACHE` |
| Gradle | `GRADLE_USER_HOME` |
| ccache / sccache | `CCACHE_DIR` / `SCCACHE_DIR`, `RUSTC_WRAPPER=sccache` |

```bash
scripts/setup-tmpfs.sh up          # mount + write env (idempotent)
eval "$(scripts/setup-tmpfs.sh env)"
scripts/setup-tmpfs.sh status
scripts/setup-tmpfs.sh install     # persist: ~/.bashrc hook + systemd --user unit
scripts/setup-tmpfs.sh down        # unmount + drop the env file
scripts/setup-tmpfs.sh uninstall   # down + remove unit + hook
```

- **Idempotent**: `up` is a no-op mount when the tmpfs is already mounted.
- **No-op outside WSL**: every action detects WSL (override with
  `AGENT_TMPFS_FORCE=1`).
- **Persisted per boot / per shell**: `install` writes an idempotent managed
  block into `~/.bashrc` (which runs `ensure` and sources the env file) and, when
  available, a `systemd --user` unit. `ensure` is the quiet variant the hook uses.
- **Overrides**: `AGENT_RAMDISK`, `AGENT_TMPFS_PERCENT` (clamped 25–40),
  `AGENT_TMPFS_CONFIG`, `AGENT_TMPFS_DRY_RUN=1`.

### Volatility warning

tmpfs lives in RAM. A reboot, an OOM kill, a WSL restart, or `down` **erases**
it. Only **caches and build artifacts** belong there — **never** source code,
databases, secrets, or git state. `down`/`uninstall` remove the env file so
new shells fall back to the default on-disk caches.

### tmpfs is not free RAM

Because the cache lives in RAM, at the default 30 % of a 10 GB VM it competes
directly with the emulator and the agents — the hidden third contributor to the
2026-09-29 freeze. Keep it small while running device tiers:

```bash
AGENT_TMPFS_PERCENT=25 scripts/setup-tmpfs.sh up
```

`serve.js list` and `agent-harness doctor` both report tmpfs usage.

## 3. Machine capacity envelope

WSL2 is **one** Linux VM: every agent, worktree, emulator, dev server, and gate
shares its RAM/CPU/swap, and there is no per-agent cgroup limit. When the working
set exceeds the VM cap the kernel thrashes reclaim/swap and starves the
host↔VM **vsock relay** — so every terminal freezes at once. That is a capacity
failure, not a stuck agent. **Parallel agents are fine; parallel heavy tiers are
not.**

The envelope is project-owned and machine-readable in
`.agents/memory/orchestration.md` (`min_available_mem_mb`, `max_swap_used_pct`,
`max_live_serves`, `max_heavy_tiers`, `idle_reap_minutes`, `emulator_ram_mb`,
`heavy_mem_max_mb`, `group_mem_max_mb`, `backstop_mem_high_mb`,
`heavy_lock_ttl_minutes`). One owner of the numbers, read by every surface:

| Surface | Role |
| --- | --- |
| `scripts/qa/capacity-lib.js` | samples `/proc` + PSI + `.serve/`, parses the envelope, owns the machine-wide heavy lock, classifies heavy commands (long-lived vs one-shot), detects whether the real workload cgroup is capped |
| `scripts/serve.js start` | **refuses** a heavy launch that would exceed the envelope or a held heavy lock (naming what is up); `--force` overrides; caps a heavy tier **by default** (transient `user.slice` unit, `heavy_mem_max_mb`); tightens a `--group` member to the group's remaining `group_mem_max_mb`; `--mem-max`/`--cpu-max` override; `--no-cap` opts out; `list` shows capacity + ages + caps |
| `scripts/serve.js run` | runs a heavy **one-shot** (build/test tier) in a transient systemd scope with `MemoryMax` (default `heavy_mem_max_mb`, `--mem-max` overrides), streaming output and returning its exit code; leaves no `.serve/` record; the APK build wrapper uses it |
| `scripts/serve.js prune` | removes `.serve/*.pid` records whose process is gone (all agent worktrees with `--worktrees`) so a stopped heavy tier is never misreported as live |
| `scripts/qa/check-capacity.js` (`npm run test:capacity`) | reports free RAM/swap/load/PSI/live serves; **fails** when the envelope is already exceeded; skips on non-Linux / `AGENT_CAPACITY_DISABLE=1` |
| `context-guard` plugin | **blocks** any over-envelope heavy command (long-lived counts as a tier; a one-shot build/test is gated by the free-RAM floor), logs `kind:"capacity"` to `.agents/guard-events.jsonl` |
| `agent-harness doctor` | capacity + **PSI** + host-aware `.wslconfig` advice + in-WSL tuning status (including whether the cgroup agents actually run in is capped) |

A heavy launch (`serve.js start` on an emulator / Metro / Next dev / live tier)
is capped **by default** — not only when `--mem-max` is passed. It runs as a
transient `systemd-run --user` unit under `user.slice` with `MemoryMax` from the
envelope (`heavy_mem_max_mb`, default 5 GB, deliberately above the observed
emulator peak so normal E2E is never throttled). A runaway is then
throttled/OOM-killed **inside its cgroup** instead of dragging the VM into
swap-thrash; it passes the caller's cwd + environment through and is a graceful
no-op where systemd is absent. `--mem-max`/`--cpu-max` override the default,
`--no-cap` opts out. Running heavy tiers under `user.slice` is also what makes
the `user.slice` ceiling below actually bind them (see the backstop note).

A heavy **one-shot** — a build or a heavy test tier — is heavy but not a
long-lived tier, so `serve.js start`'s lock does not cover it. Run it through
`serve.js run` (a transient `--scope` with `MemoryMax`, streaming output, exit
code propagated) so it, too, is contained. The 2026-09-30 freeze was exactly a
miss: an inline `bash .../build-dev-apk.sh` (Gradle daemon + Kotlin daemon + R8)
ran uncapped while the emulator and `next dev` were up, and the three filled the
10 GB VM. The APK wrapper (`scripts/qa/mobile-e2e/build-apk.sh`) now runs the
build through `serve.js run` and right-sizes Gradle (no daemon, one worker, one
ABI, 1 GB heap).

The machine-wide heavy lock (`~/.agent-harness/heavy.lock`, TTL + dead-pid
detection) is what lets many agents coexist while guaranteeing **one
emulator/live tier at a time across sessions**. It is acquired on a heavy
`serve.js start` and released on `stop`/`stop-all`.

### One-time VM tuning: `scripts/wsl-tune.sh`

`doctor` reports whether it is applied; `sudo bash scripts/wsl-tune.sh apply`
does it all (auto-sudo where passwordless), idempotently:

- **sysctls** (`/etc/sysctl.d/99-agent-wsl.conf`): `vm.swappiness=10`,
  bounded dirty ratios, a `min_free_kbytes` floor — less swap/writeback thrash.
- **user.slice ceiling** (`/etc/systemd/system/user.slice.d/90-agent-cap.conf`):
  `MemoryHigh=8G`, `MemoryMax=9G`, `CPUQuota=800%` — a backstop so user work can
  never consume the whole VM and starve the kernel/relay.
- **init.scope soft backstop** (`agent-wsl-backstop.service`, enabled): a
  `MemoryHigh` (`backstop_mem_high_mb`, default 8.5 GB) on the cgroup the workload
  actually lives in. This is the important correction: WSL's `wsl.exe` session —
  and so every agent, emulator, and dev server — runs in **`init.scope`**, a
  sibling of `user.slice`, **not** a child, so the ceiling above never binds it.
  `MemoryHigh` is deliberately *soft*: as the line is approached the kernel
  reclaims and throttles instead of thrash-freezing, and it never OOM-kills.
  Verified live: agents/emulators show `ControlGroup=/init.scope` while the
  `user.slice` drop-in applies to a cgroup holding ~4 MB.
- **`.wslconfig`** keys merged safely by `scripts/qa/wslconfig-merge.js`
  (processors = host CPUs − 4, swap 4 GB, 2 h idle timeout, reclaim on); the
  only manual step is `wsl --shutdown` from Windows PowerShell, because the VM
  must restart. `wsl-tune.sh status` / `down` inspect / remove.

Env overrides (also used to test the guards): `AGENT_CAPACITY_MEMINFO`,
`AGENT_CAPACITY_LOADAVG`, `AGENT_CAPACITY_MOUNTS`, `AGENT_CAPACITY_PSI_DIR`,
`AGENT_CAPACITY_FORCE_WSL`, `AGENT_CAPACITY_DISABLE`, `AGENT_HEAVY_LOCK`,
`AGENT_WSL_CONFIG`, `AGENT_HOST_RAM_MB`, `AGENT_HOST_CPUS`,
`AGENT_TUNING_SYSCTL_DIR`, `AGENT_TUNING_SLICE_FILE`, `AGENT_WSL_TUNE_*`.

## 4. GPU acceleration for the device emulator: `scripts/wsl-gpu.sh`

The Android E2E emulator is the slowest, most CPU-bound part of a mobile run:
on a software renderer each Maestro command costs ~2.5 s and QEMU pins ~3 cores
just compositing (F-291/F-296). WSL2 can render on the Windows GPU, but Mesa
does not use it unless two things are true — and on a typical WSL install
neither is:

- **`vgem` must be loaded.** WSL kernels ≥ 2.5 ship `vgem` as a *loadable*
  module and never auto-load it, so `/dev/dri` is absent and the GL stack falls
  back to `llvmpipe` (WSL issues #12702 / #11837). The Windows GPU is still
  exposed at `/dev/dxg`; only the DRM render node is missing.
- **Mesa must select `d3d12`.** Even with `/dev/dri` present, the default
  renderer stays `llvmpipe`; `GALLIUM_DRIVER=d3d12`
  (`MESA_LOADER_DRIVER_OVERRIDE=d3d12`, with `/usr/lib/wsl/lib` on the loader
  path) is required.

```bash
bash scripts/wsl-gpu.sh status    # /dev/dxg? vgem? which d3d12 renderer?
bash scripts/wsl-gpu.sh apply     # load + persist vgem, verify (auto-sudo)
bash scripts/wsl-gpu.sh env       # print the GL exports for a process
```

`apply` runs `modprobe vgem` and persists it via
`/etc/modules-load.d/vgem.conf`, then verifies with a forced-d3d12 `glxinfo`.
`doctor` warns when `/dev/dxg` exists but `/dev/dri` is missing (the
not-loaded state). `boot-emulator.sh` probes the same path: it forces the
`d3d12` driver when `/dev/dxg` is present, and when that reports an accelerated
renderer it launches the emulator with `-gpu host` **and** the matching
`GALLIUM_DRIVER`/`MESA_LOADER_DRIVER_OVERRIDE` env (serve.js forwards the
caller's env into the transient unit). Otherwise it stays on
`swiftshader_indirect` and prints the `wsl-gpu.sh apply` hint.

No-op outside WSL (no `/dev/dxg`). Env: `AGENT_WSL_GPU_DRIVER` (default
`d3d12`), `AGENT_WSL_GPU_MODULE` (`vgem`), `AGENT_WSL_GPU_MODULES_FILE`,
`AGENT_WSL_GPU_GLXINFO`, `AGENT_WSL_GPU_FORCE`. If `apply` loads `vgem` but the
renderer is still software, the Windows GPU driver lacks WSL support — update
it to the vendor's WSL driver and `wsl --shutdown`.

## 5. Always-loaded prefix: size budget, orient digest, opt-in LSP

The always-loaded leading context (root `AGENTS.md` + `.agents/AGENTS.md` +
`.agents/rules/00-operating.md` + the session-start memory files) is the prompt
prefix every turn is billed against. Three mechanisms keep it honest:

- **Size budget** — `test:prefix` (`scripts/qa/check-prefix-stability.js`) fails
  when a harness-owned prefix file, or their combined size, exceeds the budget
  shipped in the gate. The gate prints each file against its budget; raising it
  must be a deliberate edit. `AGENT_PREFIX_STRICT=0` disables the size check;
  `AGENT_PREFIX_MAX_BYTES` overrides the combined ceiling.
- **orient digest** — instead of re-reading five memory files at session start,
  `scripts/orient.js` returns a bounded digest per file (its `##` section index
  plus its first markdown table). The `context-guard` plugin injects
  `orient --brief` into the cache-safe conversation tail at session start
  (cleared on the first material action), so a resume/claim prologue re-derives
  nothing by hand.
- **Opt-in LSP** — opencode LSP is **disabled by default** (opencode's own
  guidance: language servers can be memory-heavy and drift out of sync, and the
  project already runs `tsc`/eslint directly). A project that wants edit-time
  diagnostics may set `"lsp": true` in its own `opencode.json`; the harness merge
  preserves the project key. On a memory-tight WSL2 box, weigh it against the
  capacity envelope (§3) — an LSP server per session adds RSS across parallel
  sessions.
