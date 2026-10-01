#!/usr/bin/env node
"use strict";
/*
 * capacity-lib — the machine-capacity envelope shared by `serve.js`,
 * `check-capacity.js`, the `context-guard` plugin, and `agent-harness doctor`.
 *
 * Why: WSL2 is ONE Linux VM. Every agent, worktree, emulator, `next dev`, and
 * gate shares its RAM/CPU/swap, and there is no per-agent cgroup limit. When the
 * working set (emulator ~3 GB + agents + dev server) exceeds the VM cap, the
 * kernel thrashes reclaim/swap AND starves the host<->VM vsock relay — so every
 * terminal freezes at once (the 2026-09-29 freeze: 10 GB cap, 4 GB swap full,
 * load 60). The root fix is policy (serialize heavy tiers, reap idle daemons),
 * and the harness makes it MECHANICAL: an envelope read from the project-owned
 * `.agents/memory/orchestration.md`, sampled against live `/proc` + `.serve/`
 * state, with one owner of the numbers so every surface agrees.
 *
 * Pure-ish (fs reads only, never throws). Every path is env-overridable so the
 * gate and its tests can inject synthetic host state:
 *   AGENT_CAPACITY_MEMINFO   (default /proc/meminfo)
 *   AGENT_CAPACITY_LOADAVG   (default /proc/loadavg)
 *   AGENT_CAPACITY_MOUNTS    (default /proc/mounts)
 *   AGENT_CAPACITY_PSI_DIR   (default /proc/pressure)
 *   AGENT_CAPACITY_FORCE_WSL (1 -> treat as WSL2 even off-Linux, 0 -> never)
 *   AGENT_CAPACITY_DISABLE   (1 -> skip capacity gates entirely)
 *   AGENT_HEAVY_LOCK         (default ~/.agent-harness/heavy.lock)
 *   AGENT_WSL_CONFIG         (explicit .wslconfig path for doctor)
 *   AGENT_HOST_RAM_MB / AGENT_HOST_CPUS (inject Windows host totals for tests)
 *   AGENT_TUNING_SYSCTL_DIR / AGENT_TUNING_SLICE_FILE (tuning status for tests)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

/* Documented defaults. The project overrides them in `orchestration.md` (the
 * same machine-read file the context guard uses) — a missing row falls back
 * here, so the guard survives a hand-trimmed file. Values target the 10 GB WSL2
 * box the harness is built on; a project on a bigger host can raise them. */
const DEFAULT_ENVELOPE = {
  minAvailableMemMb: 1024,
  maxSwapUsedPct: 80,
  maxLiveServes: 2,
  maxHeavyTiers: 1,
  idleReapMinutes: 90,
  emulatorRamMb: 2048,
  heavyLockTtlMinutes: 240,
  // A heavy tier (emulator, Metro/Next dev, live E2E) is capped in its own
  // cgroup by default (serve.js). The cap is deliberately generous — above the
  // observed peak (an AVD from a 2048 MB guest peaks ~3.9 GB RSS) — so normal
  // E2E is never throttled, but a runaway is OOM-killed inside its slice
  // instead of freezing every terminal. Overridable per launch with --mem-max.
  heavyMemMaxMb: 5120,
  // Combined budget for ONE tier group (serve.js --group, e.g. the `mobile`
  // emulator + dev server). Each member's per-process cap (`heavy_mem_max_mb`)
  // is generous, so two members could legally fill the whole VM (2 × 5 GB on a
  // 10 GB box — the 2026-09-30 freeze, where the emulator + `next dev` + an
  // inline Gradle build together exhausted RAM). `serve.js` tightens a new
  // member's cap to the group's remaining budget so the pair stays inside one
  // tier; `evaluate` warns when a live group overshoots.
  groupMemMaxMb: 6144,
  // Soft `MemoryHigh` backstop for the cgroup that actually holds the agents
  // (WSL puts the `wsl.exe` session in init.scope, NOT user.slice). Soft: it
  // throttles/reclaims near the freeze line and never OOM-kills. 8.5 GB sits
  // above the observed non-reclaimable working set (~6.9 GB) so the cap only
  // reclaims page cache in normal E2E, and below the ~9.5 GB freeze peak.
  backstopMemHighMb: 8704,
  // PSI (`/proc/pressure/*`) is the earliest true freeze signal — load average
  // lies, but memory "some avg10" climbing means processes are already stalled
  // on reclaim. Warning thresholds, not hard failures.
  maxMemPressureAvg10: 10,
  maxCpuPressureAvg10: 80,
};

const ENVELOPE_KEYS = {
  min_available_mem_mb: "minAvailableMemMb",
  max_swap_used_pct: "maxSwapUsedPct",
  max_live_serves: "maxLiveServes",
  max_heavy_tiers: "maxHeavyTiers",
  idle_reap_minutes: "idleReapMinutes",
  emulator_ram_mb: "emulatorRamMb",
  heavy_lock_ttl_minutes: "heavyLockTtlMinutes",
  heavy_mem_max_mb: "heavyMemMaxMb",
  group_mem_max_mb: "groupMemMaxMb",
  backstop_mem_high_mb: "backstopMemHighMb",
  max_mem_pressure_avg10: "maxMemPressureAvg10",
  max_cpu_pressure_avg10: "maxCpuPressureAvg10",
};

/* Heavy-process classifier. Deliberately narrow: it must fire on the things
 * that actually caused the freeze (emulator, Metro/Next dev, a big tier) and
 * stay quiet on trivial `node srv.js` helpers, so the preflight/refusal never
 * blocks ordinary work. Label is used in messages. */
const HEAVY_PATTERNS = [
  [/\bemulator\b|-avd\b|qemu-system/i, "emulator"],
  [/maestro\b/i, "maestro"],
  [/next\s+dev\b|next\s+start\b/i, "next dev"],
  [/expo\s+start\b|react-native\s+start\b|\bmetro\b/i, "metro"],
  [/\bvite\b[^\n]*\b(dev|serve|preview)\b/i, "vite"],
  [/\bwebpack\b|\bturbopack\b/i, "bundler"],
  [/npm\s+run\s+(dev|develop|start:dev)\b/i, "dev server"],
  [/npm\s+run\s+(test:quick|test:api|test:verify|test:e2e|test:mobile|test:data|test:integration)\b/i, "heavy test tier"],
  [/\bdocker\s+(build|run|compose)\b/i, "docker"],
  // The Android APK build is the 2026-09-30 freeze: a Gradle daemon + Kotlin
  // daemon + R8/D8 job that ran INLINE (not via serve.js), so it had no cgroup
  // cap and no envelope preflight. Match the wrapper script name — the top-level
  // bash command is `bash scripts/qa/mobile-e2e/build-dev-apk.sh`, which never
  // contains `gradlew` — as well as the gradle task/wrapper itself.
  [/build-dev-apk\.sh|build-apk\.sh|prewarm\.sh|\bassemble(Release|Debug)\b|expo\s+(prebuild|export)|react-native\s+(build|run-android)/i, "apk build"],
  [/\b(gradlew|gradle|xcodebuild)\b/i, "native build"],
  [/prisma\s+(migrate|generate)|\btsc\b[^\n]*--build|turbo\s+(run|build)|nx\s+(run|build)/i, "build"],
];

/* Heavy labels that are LONG-LIVED tiers: they hold RAM for their whole
 * lifetime and must not run two at once (emulator + `next dev` + a third dev
 * server). Everything else heavy (a build, a test tier, `maestro`) is a
 * ONE-SHOT command: it spikes RAM but releases it, so it is legitimate to run
 * while a dev server is up (the live-tier test pattern) and must NOT be counted
 * as an extra concurrent tier. The distinction is what keeps the guard from
 * blocking `test:api` next to a running dev server, while still refusing a
 * second emulator. */
const LONG_LIVED_HEAVY = new Set([
  "emulator",
  "next dev",
  "metro",
  "vite",
  "bundler",
  "dev server",
  "docker",
]);

function procPath(envKey, fallback) {
  return process.env[envKey] || fallback;
}

function isAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function classifyHeavy(cmd) {
  const s = String(cmd == null ? "" : cmd);
  if (!s) return null;
  for (const [re, label] of HEAVY_PATTERNS) if (re.test(s)) return label;
  return null;
}

function isHeavyCommand(cmd) {
  return classifyHeavy(cmd) !== null;
}

/* True when a command is a long-lived heavy tier (holds RAM for its lifetime),
 * as opposed to a one-shot heavy command (build/test/maestro). Callers use this
 * to decide whether adding the command would introduce a concurrent tier. */
function isLongLivedHeavy(cmd) {
  const label = classifyHeavy(cmd);
  return label !== null && LONG_LIVED_HEAVY.has(label);
}

/* Parse a MemoryMax-style value (`5120M`, `4G`, `1024`) to whole MB; null when
 * absent/unparseable. Used to sum a tier group's live budget. */
function parseMemMb(value) {
  if (value == null) return null;
  const m = String(value).match(/^\s*([0-9.]+)\s*([KMGT]?)B?\s*$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] || "M").toUpperCase();
  const mult = unit === "K" ? 1 / 1024 : unit === "M" ? 1 : unit === "G" ? 1024 : 1024 * 1024;
  return Math.round(n * mult);
}

/* `| \`key\` | 2048 | ... |` rows. Non-envelope keyed rows (turn/stuck) are
 * ignored because their key is not in ENVELOPE_KEYS. */
function parseEnvelope(text) {
  const env = Object.assign({}, DEFAULT_ENVELOPE);
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\|\s*`?([a-z_]+)`?\s*\|\s*(\d+)\s*\|/);
    if (!m) continue;
    const key = ENVELOPE_KEYS[m[1]];
    if (key) env[key] = Number(m[2]);
  }
  return env;
}

function envelopePath(root) {
  return path.join(root, ".agents", "memory", "orchestration.md");
}

function readEnvelopeText(root) {
  try {
    return fs.readFileSync(envelopePath(root), "utf8");
  } catch (_) {
    return "";
  }
}

function readEnvelope(root) {
  return parseEnvelope(readEnvelopeText(root));
}

function isWsl() {
  if (process.env.AGENT_CAPACITY_FORCE_WSL === "1") return true;
  if (process.env.AGENT_CAPACITY_FORCE_WSL === "0") return false;
  if (process.platform !== "linux") return false;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch (_) {
    return false;
  }
}

function readMem() {
  try {
    const text = fs.readFileSync(procPath("AGENT_CAPACITY_MEMINFO", "/proc/meminfo"), "utf8");
    const get = (key) => {
      const m = text.match(new RegExp("^" + key + ":\\s+(\\d+)", "m"));
      return m ? Number(m[1]) : null;
    };
    const toMb = (kb) => (kb == null ? null : Math.round(kb / 1024));
    const total = toMb(get("MemTotal"));
    const available = toMb(get("MemAvailable"));
    const swapTotal = toMb(get("SwapTotal")) || 0;
    const swapFree = toMb(get("SwapFree")) || 0;
    return {
      total,
      available,
      swapTotal,
      swapFree,
      swapUsedPct: swapTotal > 0 ? Math.round(((swapTotal - swapFree) / swapTotal) * 100) : 0,
    };
  } catch (_) {
    return null;
  }
}

function readLoad() {
  try {
    const text = fs.readFileSync(procPath("AGENT_CAPACITY_LOADAVG", "/proc/loadavg"), "utf8").trim();
    const load1 = parseFloat(text.split(/\s+/)[0]);
    return { load1: Number.isFinite(load1) ? load1 : null, cpus: os.cpus().length || 1 };
  } catch (_) {
    return null;
  }
}

/* PSI (`/proc/pressure/{memory,cpu}`): the kernel's own stall accounting. `some
 * avg10` is the share of the last 10 s during which at least one task was
 * stalled; a memory `some` value climbing past ~10 is the freeze arriving,
 * before free-RAM or load make it obvious. Returns null where PSI is absent. */
function readPsi() {
  const dir = process.env.AGENT_CAPACITY_PSI_DIR || "/proc/pressure";
  const readOne = (name) => {
    try {
      const text = fs.readFileSync(path.join(dir, name), "utf8");
      const get = (re) => {
        const m = text.match(re);
        return m ? parseFloat(m[1]) : null;
      };
      return {
        some10: get(/some\s+avg10=([0-9.]+)/),
        full10: get(/full\s+avg10=([0-9.]+)/),
      };
    } catch (_) {
      return null;
    }
  };
  const mem = readOne("memory");
  const cpu = readOne("cpu");
  if (!mem && !cpu) return null;
  return { mem, cpu };
}

/* Windows-host totals, for host-aware advice. On WSL the VM is a slice of the
 * real machine, so "raise memory" is only sensible when the host has room and
 * "processors=N" only when it leaves Windows threads to run the terminal/relay.
 * Best-effort (powershell may be slow/unavailable); overridable for tests. */
function readHost() {
  if (process.env.AGENT_HOST_RAM_MB || process.env.AGENT_HOST_CPUS) {
    const ramMb = Number(process.env.AGENT_HOST_RAM_MB);
    const cpus = Number(process.env.AGENT_HOST_CPUS);
    return {
      ramMb: Number.isFinite(ramMb) && ramMb > 0 ? ramMb : null,
      cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : null,
    };
  }
  if (!isWsl()) return null;
  const ps = (expr) => {
    try {
      const r = require("child_process").execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", expr],
        { encoding: "utf8", timeout: 8000, stdio: ["ignore", "pipe", "ignore"] }
      );
      const n = Number(String(r).trim());
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) {
      return null;
    }
  };
  const ramBytes = ps("(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory");
  const cpus = ps("(Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors");
  if (!ramBytes && !cpus) return null;
  return { ramMb: ramBytes ? Math.round(ramBytes / 1048576) : null, cpus };
}

/* Whether the one-time in-WSL tuning (`scripts/wsl-tune.sh apply`) is present:
 * a low swappiness, the user.slice resource ceiling, and the soft init.scope
 * backstop. Doctor reads this to tell the operator the single command that
 * finishes the setup.
 *
 * The cgroup facts are the important part. WSL's `wsl.exe` session — and so
 * every agent, emulator, and dev server — lands in `init.scope`, NOT
 * `user.slice`; a ceiling only on `user.slice` never binds the real workload.
 * `workloadCapped` is true only when the cgroup that holds the workload carries
 * a finite limit (`init.scope` MemoryHigh/MemoryMax). `sliceApplied` alone is
 * not enough, which is exactly the gap this detects. */
function readTuning() {
  const sysctlDir = process.env.AGENT_TUNING_SYSCTL_DIR || "/proc/sys";
  let swappiness = null;
  try {
    const v = fs.readFileSync(path.join(sysctlDir, "vm", "swappiness"), "utf8").trim();
    swappiness = Number(v);
    if (!Number.isFinite(swappiness)) swappiness = null;
  } catch (_) {
    swappiness = null;
  }
  const sliceFile =
    process.env.AGENT_TUNING_SLICE_FILE || "/etc/systemd/system/user.slice.d/90-agent-cap.conf";
  const backstopUnit =
    process.env.AGENT_TUNING_BACKSTOP_UNIT || "/etc/systemd/system/agent-wsl-backstop.service";
  const cgroupRoot = process.env.AGENT_TUNING_CGROUP_ROOT || "/sys/fs/cgroup";
  const readCg = (rel) => {
    try {
      return fs.readFileSync(path.join(cgroupRoot, rel), "utf8").trim();
    } catch (_) {
      return null;
    }
  };
  const finite = (v) => v != null && v !== "" && v !== "max";
  const initHigh = readCg("init.scope/memory.high");
  const initMax = readCg("init.scope/memory.max");
  const userSliceMax = readCg("user.slice/memory.max");
  return {
    swappiness,
    sliceFile,
    sliceApplied: fs.existsSync(sliceFile),
    backstopUnit,
    backstopApplied: fs.existsSync(backstopUnit),
    initHigh,
    initMax,
    userSliceMax,
    workloadCapped: finite(initHigh) || finite(initMax),
  };
}

/* Live long-lived processes recorded by `serve.js` under `.serve/*.pid`. A pid
 * file whose pid is dead is still reported (so a stale file is visible) but
 * never counts as live. `ageMs` comes from the recorded start timestamp. */
function readServes(root) {
  const dir = path.join(root, ".serve");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".pid"));
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    const name = f.slice(0, -4);
    let info = {};
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch (_) {
      info = { name };
    }
    const pid = Number(info.pid);
    const startedAt = info.startedAt ? Date.parse(info.startedAt) : null;
    const ageMs = Number.isFinite(startedAt) ? Date.now() - startedAt : null;
    const cmd = info.cmd || "";
    const memMax = info.memMax || null;
    out.push({
      name,
      pid: Number.isFinite(pid) ? pid : null,
      cmd,
      url: info.url || null,
      port: info.port || null,
      group: info.group || null,
      startedAt: info.startedAt || null,
      ageMs,
      alive: isAlive(pid),
      heavy: info.heavy != null ? !!info.heavy : isHeavyCommand(cmd),
      memMax,
      memMaxMb: parseMemMb(memMax),
    });
  }
  return out;
}

/* Mounted tmpfs roots (the RAM-backed cache from `setup-tmpfs.sh`). Only
 * informative: tmpfs pages are RAM, so a large cache eats the very headroom the
 * emulator/agents need — the freeze's hidden third contributor. */
function readTmpfs() {
  try {
    const text = fs.readFileSync(procPath("AGENT_CAPACITY_MOUNTS", "/proc/mounts"), "utf8");
    const mounts = text
      .split(/\r?\n/)
      .filter((l) => /\btmpfs\b/.test(l))
      .map((l) => l.split(" ")[1])
      .filter((p) => p && !/^\/(dev\/shm|run|sys|proc)(\/|$)/.test(p));
    const out = [];
    for (const raw of mounts) {
      const mount = raw.replace(/\\040/g, " ");
      try {
        const st = fs.statfsSync(mount);
        const bsize = st.bsize || 4096;
        out.push({
          mount,
          totalMb: Math.round((st.blocks * bsize) / 1048576),
          usedMb: Math.round(((st.blocks - st.bfree) * bsize) / 1048576),
        });
      } catch (_) {
        /* unmounted or unreadable — skip */
      }
    }
    return out;
  } catch (_) {
    return [];
  }
}

function sample(root, envelopeText) {
  const envelope = parseEnvelope(envelopeText != null ? envelopeText : readEnvelopeText(root));
  return {
    root,
    envelope,
    mem: readMem(),
    load: readLoad(),
    psi: readPsi(),
    serves: readServes(root),
    tmpfs: readTmpfs(),
    wsl: isWsl(),
  };
}

/* Evaluate a sample. `opts.pendingHeavy` / `opts.pendingLive` let a caller ask
 * "would adding this process exceed the envelope?" — the preflight must count
 * the process it is ABOUT to start, not only what is already running.
 *
 * `opts.pendingGroup` is a shared tier group (e.g. `mobile`): the device tier
 * legitimately needs two heavy processes (emulator + dev server), so members of
 * ONE group count as a single heavy tier rather than tripping `maxHeavyTiers`.
 * A second, unrelated heavy tier is still refused. */
function evaluate(s, opts) {
  const e = (s && s.envelope) || DEFAULT_ENVELOPE;
  const pendingHeavy = (opts && opts.pendingHeavy) || 0;
  const pendingLive = (opts && opts.pendingLive) || 0;
  const pendingGroup = (opts && opts.pendingGroup) || null;
  const reasons = [];
  const warnings = [];
  const live = ((s && s.serves) || []).filter((x) => x.alive);
  const heavy = live.filter((x) => x.heavy);

  if (s && s.mem && s.mem.available != null && s.mem.available < e.minAvailableMemMb) {
    reasons.push(
      `only ${s.mem.available} MB RAM available (envelope min ${e.minAvailableMemMb} MB)`
    );
  }
  // Members of the pending group join the existing heavy tier instead of adding
  // one, so emulator + dev server = one budgeted `mobile` tier.
  const heavyGroups = new Set(heavy.map((x) => x.group).filter(Boolean));
  const joinsRunningGroup =
    !!pendingGroup && heavy.length > 0 && heavyGroups.size === 1 && heavyGroups.has(pendingGroup);
  // A process joining an already-live group shares that ONE tier (emulator +
  // dev server + a one-shot build = one budgeted `mobile` tier), so it does not
  // add to the count even when several group members are already live (F-296).
  const heavyTiers = joinsRunningGroup ? 1 : heavy.length + pendingHeavy;
  if (heavyTiers > e.maxHeavyTiers) {
    reasons.push(
      `${heavyTiers} heavy tier(s) would run at once ` +
        `(${[...heavy.map((h) => h.name), pendingHeavy ? "this launch" : null].filter(Boolean).join(", ")}); ` +
        `envelope allows ${e.maxHeavyTiers}`
    );
  }
  if (live.length + pendingLive > e.maxLiveServes) {
    warnings.push(
      `${live.length + pendingLive} live serve process(es); envelope suggests max ${e.maxLiveServes}`
    );
  }
  // Combined per-group budget: each heavy member is capped generously
  // (`heavy_mem_max_mb`), so without this a two-member mobile tier could fill
  // the VM. `serve.js` enforces it by tightening a new member's cap; this warns
  // when an already-live group is over budget.
  if (e.groupMemMaxMb > 0) {
    const groupMem = new Map();
    for (const x of heavy) {
      if (!x.group || x.memMaxMb == null) continue;
      groupMem.set(x.group, (groupMem.get(x.group) || 0) + x.memMaxMb);
    }
    for (const [g, sum] of groupMem) {
      if (sum > e.groupMemMaxMb) {
        warnings.push(
          `tier group "${g}" is budgeted ${sum} MB (group_mem_max_mb ${e.groupMemMaxMb} MB) — ` +
            `lower a member with --mem-max or stop one`
        );
      }
    }
  }
  if (s && s.mem && s.mem.swapTotal > 0 && s.mem.swapUsedPct >= e.maxSwapUsedPct) {
    warnings.push(`swap ${s.mem.swapUsedPct}% used (envelope max ${e.maxSwapUsedPct}%)`);
  }
  if (s && s.psi && s.psi.mem && s.psi.mem.some10 != null && s.psi.mem.some10 >= e.maxMemPressureAvg10) {
    warnings.push(
      `memory pressure ${s.psi.mem.some10.toFixed(1)} (PSI some avg10 ≥ ${e.maxMemPressureAvg10}) — ` +
        `processes are already stalling on reclaim`
    );
  }
  if (s && s.psi && s.psi.cpu && s.psi.cpu.some10 != null && s.psi.cpu.some10 >= e.maxCpuPressureAvg10) {
    warnings.push(`CPU pressure ${s.psi.cpu.some10.toFixed(1)} (PSI some avg10 ≥ ${e.maxCpuPressureAvg10})`);
  }
  for (const x of live) {
    if (x.ageMs != null && x.ageMs > e.idleReapMinutes * 60000) {
      warnings.push(
        `"${x.name}" has been up ${Math.round(x.ageMs / 60000)}m — stop it when its tier is done (idle hint ${e.idleReapMinutes}m)`
      );
    }
  }
  return { ok: reasons.length === 0, reasons, warnings, live, heavy };
}

/* Live memory budget of one tier group: sum of the live members' applied caps,
 * and what remains of `group_mem_max_mb`. `serve.js` uses `remainingMb` to
 * tighten a new member's cap so the group stays inside one budget. */
function groupBudget(serves, group, envelope) {
  const e = envelope || DEFAULT_ENVELOPE;
  const total = e.groupMemMaxMb > 0 ? e.groupMemMaxMb : Infinity;
  let used = 0;
  for (const x of serves || []) {
    if (!x.alive || x.group !== group || x.memMaxMb == null) continue;
    used += x.memMaxMb;
  }
  return { usedMb: used, totalMb: e.groupMemMaxMb, remainingMb: total === Infinity ? null : total - used };
}

function formatSummary(s) {
  const parts = [];
  if (s && s.mem && s.mem.total != null) {
    parts.push(`RAM ${s.mem.available}/${s.mem.total} MB free`);
    if (s.mem.swapTotal > 0) parts.push(`swap ${s.mem.swapUsedPct}% of ${s.mem.swapTotal} MB`);
  }
  if (s && s.load && s.load.load1 != null) parts.push(`load ${s.load.load1}/${s.load.cpus} cpu`);
  if (s && s.psi && s.psi.mem && s.psi.mem.some10 != null) {
    parts.push(`mem pressure ${s.psi.mem.some10.toFixed(1)}`);
  }
  const live = ((s && s.serves) || []).filter((x) => x.alive);
  parts.push(`${live.length} live serve(s)`);
  if (s && s.tmpfs && s.tmpfs.length) {
    const used = s.tmpfs.reduce((a, t) => a + t.usedMb, 0);
    if (used > 0) parts.push(`tmpfs ${used} MB`);
  }
  return `capacity: ${parts.join(" \u00b7 ")}`;
}

/* The refusal body for a blocked heavy launch. Lists what is already running
 * with ages so the operator can stop the right one. */
function heavyBlockText(label, ev, s) {
  const lines = [`refused: "${label}" would exceed the machine capacity envelope`];
  for (const r of ev.reasons) lines.push(`  - ${r}`);
  const running = ((s && s.serves) || [])
    .filter((x) => x.alive)
    .map((x) => `${x.name}${x.ageMs != null ? ` (${Math.round(x.ageMs / 60000)}m)` : ""}`);
  lines.push(`  running: ${running.length ? running.join(", ") : "none"}`);
  lines.push(
    `  stop one first (node scripts/serve.js stop --name <name> | stop-all), ` +
      `or re-run with --force to override`
  );
  return lines.join("\n");
}

/* A short tail nudge the context-guard plugin can inject (same envelope, live
 * sample). Returns null when there is nothing to say. */
function notice(ev) {
  if (!ev || (ev.ok && !(ev.warnings && ev.warnings.length))) return null;
  const head = ev.ok ? "capacity warning" : "CAPACITY OVER ENVELOPE";
  const lines = [head, ...(ev.reasons || []).map((r) => `  - ${r}`), ...(ev.warnings || []).map((w) => `  - ${w}`)];
  lines.push("  Serialize heavy tiers; stop idle dev servers/emulators (node scripts/serve.js stop-all).");
  return lines.join("\n");
}

/* --------------------------------------------------------------- heavy lock
 * A machine-wide, single-holder lock so two sessions can never both start a
 * device/live tier. Cross-process and cross-session by design (unlike the
 * per-tree session leases): `serve.js start` acquires it for a heavy command
 * and `serve.js stop` releases it. TTL + dead-pid detection mean a crashed
 * holder can never wedge the machine. */
function lockPath() {
  return process.env.AGENT_HEAVY_LOCK || path.join(os.homedir(), ".agent-harness", "heavy.lock");
}

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(lockPath(), "utf8"));
  } catch (_) {
    return null;
  }
}

/* Members of a lock. A current lock carries `members: [{name, pid, unit}]` — the
 * REAL server pids, because the `serve.js start` CLI process that writes the
 * lock exits immediately and would make a pid-based lock look stale at once.
 * A legacy `{pid, name}` record is normalised to a single member. */
function lockMembers(lock) {
  if (!lock) return [];
  if (Array.isArray(lock.members) && lock.members.length > 0) return lock.members;
  if (lock.pid) return [{ name: lock.name || "heavy", pid: lock.pid, unit: lock.unit || null }];
  return [];
}

function writeLock(record) {
  const p = lockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(record, null, 2));
}

/* Stale when no recorded member process is alive, or the lock has outlived its
 * TTL (a crashed tier can never wedge the machine). */
function lockIsStale(lock, ttlMinutes) {
  if (!lock) return true;
  const members = lockMembers(lock);
  if (members.length === 0) return true;
  if (!members.some((m) => isAlive(m.pid))) return true;
  const since = lock.since ? Date.parse(lock.since) : null;
  const ttl = Number(ttlMinutes) > 0 ? Number(ttlMinutes) : DEFAULT_ENVELOPE.heavyLockTtlMinutes;
  if (since != null && Number.isFinite(since) && Date.now() - since > ttl * 60000) return true;
  return false;
}

/* Returns { ok, held, lock?, joined?, error? }. `ok` false + `held` true means
 * another live tier holds the lock; `held` false means it could not be written.
 * `group` records a shared tier (e.g. `mobile`): a live holder of the SAME group
 * is compatible, and this member is appended rather than refused. The member pid
 * is the short-lived CLI pid until serve.js calls `updateHeavyMember` with the
 * real server pid. */
function acquireHeavyLock(name, envelope, group) {
  const ttl = (envelope && envelope.heavyLockTtlMinutes) || DEFAULT_ENVELOPE.heavyLockTtlMinutes;
  const p = lockPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const fd = fs.openSync(p, "wx");
      fs.writeSync(
        fd,
        JSON.stringify(
          {
            name: name || "heavy",
            group: group || null,
            host: os.hostname(),
            since: new Date().toISOString(),
            members: [{ name: name || "heavy", pid: process.pid, unit: null }],
          },
          null,
          2
        )
      );
      fs.closeSync(fd);
      return { ok: true, held: true };
    } catch (err) {
      if (err.code !== "EEXIST") return { ok: false, held: false, error: err.message || String(err) };
      const existing = readLock();
      if (lockIsStale(existing, ttl)) {
        try {
          fs.unlinkSync(p);
        } catch (_) {}
        continue;
      }
      if (group != null && existing.group === group) {
        return { ok: true, held: true, joined: true, lock: existing };
      }
      return { ok: false, held: true, lock: existing };
    }
  }
  return { ok: false, held: true, lock: readLock() };
}

/* Register/replace a lock member with the REAL running server pid + unit. Called
 * by serve.js after the spawn, so the lock tracks a process that outlives the
 * `start` CLI. Adds the member to a same-group lock (never clobbers a sibling). */
function updateHeavyMember(member) {
  const lock = readLock();
  if (!lock) {
    writeLock({
      name: member.name,
      group: member.group || null,
      host: os.hostname(),
      since: new Date().toISOString(),
      members: [{ name: member.name, pid: member.pid, unit: member.unit || null }],
    });
    return true;
  }
  const members = lockMembers(lock).filter((m) => m.name !== member.name);
  members.push({ name: member.name, pid: member.pid, unit: member.unit || null });
  lock.members = members;
  if (member.group != null) lock.group = member.group;
  writeLock(lock);
  return true;
}

/* Release this member. `name` (the server being stopped) removes its member
 * entry; the lock is deleted only when the last member is gone, so a shared
 * group (emulator + dev server) releases exactly once. `group` is a fallback for
 * a legacy record without a members list. */
function releaseHeavyLock(name, group) {
  const lock = readLock();
  if (!lock) return false;
  const members = lockMembers(lock);
  if (Array.isArray(lock.members) && lock.members.length > 0 && name != null) {
    const remaining = members.filter((m) => m.name !== name);
    if (remaining.length > 0) {
      lock.members = remaining;
      writeLock(lock);
      return true;
    }
  } else {
    const mine = Number(lock.pid) === process.pid;
    const named = name != null && lock.name === name;
    const grouped = group != null && lock.group === group;
    if (!mine && !named && !grouped) return false;
  }
  try {
    fs.unlinkSync(lockPath());
    return true;
  } catch (_) {
    return false;
  }
}

/* Remove the machine-wide heavy lock unconditionally. Teardown only:
 * `serve.js stop-all` has already stopped every member — including an orphaned
 * lock member whose `.serve/` record was lost in another worktree (the F-302
 * leak: a dev server started in MAIN survived a worktree-scoped stop-all and
 * pinned RAM, refusing the F-304/F-305 device tiers). */
function clearHeavyLock() {
  try {
    fs.unlinkSync(lockPath());
    return true;
  } catch (_) {
    return false;
  }
}

/* --------------------------------------------------------------- .wslconfig
 * Doctor-only: read the Windows-side `.wslconfig` (best-effort) and turn its
 * vmIdleTimeout/memory/swap/autoMemoryReclaim into concrete advice. */
function parseWslConfig(text) {
  const out = {};
  let section = "";
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) {
      section = sec[1].trim().toLowerCase();
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (kv) out[(section ? section + "." : "") + kv[1].toLowerCase()] = kv[2].trim();
  }
  return out;
}

function readWslConfig() {
  const candidates = [];
  if (process.env.AGENT_WSL_CONFIG) candidates.push(process.env.AGENT_WSL_CONFIG);
  try {
    for (const user of fs.readdirSync("/mnt/c/Users")) {
      candidates.push(path.join("/mnt/c/Users", user, ".wslconfig"));
    }
  } catch (_) {
    /* not on a Windows-mount host */
  }
  for (const c of candidates) {
    try {
      const text = fs.readFileSync(c, "utf8");
      return { path: c, text, config: parseWslConfig(text) };
    } catch (_) {
      /* keep looking */
    }
  }
  return null;
}

function memToGb(value) {
  const m = String(value || "").match(/^([0-9.]+)\s*(GB|MB|TB)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = (m[2] || "GB").toUpperCase();
  if (!Number.isFinite(n)) return null;
  if (unit === "MB") return n / 1024;
  if (unit === "TB") return n * 1024;
  return n;
}

function wslConfigAdvice(wsl, host) {
  const advice = [];
  if (!wsl || !wsl.config) return advice;
  const cfg = wsl.config;
  const hostGb = host && host.ramMb ? host.ramMb / 1024 : null;
  const mem = cfg["wsl2.memory"];
  const gb = mem ? memToGb(mem) : null;
  if (gb != null) {
    if (hostGb != null) {
      // Host-aware: only push back when the VM leaves Windows too little.
      const leftForWindows = hostGb - gb;
      if (leftForWindows < 5) {
        advice.push(
          `.wslconfig memory=${mem} leaves Windows ~${leftForWindows.toFixed(1)} GB on a ${hostGb.toFixed(1)} GB host — ` +
            `too tight (Windows needs room for the terminal + vsock relay); keep WSL at ~${Math.max(6, Math.floor(hostGb - 6))} GB or serialize heavy tiers`
        );
      }
    } else if (gb < 12) {
      advice.push(
        `.wslconfig memory=${mem} — raise it only if the Windows host has headroom (a 10 GB VM + emulator + 2 agents + next dev does not fit)`
      );
    }
  }
  const proc = Number(cfg["wsl2.processors"]);
  const hostCpus = host && host.cpus;
  if (Number.isFinite(proc) && hostCpus && proc > hostCpus - 4) {
    advice.push(
      `.wslconfig processors=${proc} of ${hostCpus} host logical CPUs leaves only ${hostCpus - proc} thread(s) for ` +
        `Windows (terminal, vsock relay) — set processors=${Math.max(2, hostCpus - 4)}`
    );
  }
  const idle = cfg["wsl2.vmidletimeout"];
  const idleMs = idle ? Number(idle) : NaN;
  if (idle && Number.isFinite(idleMs) && idleMs > 2 * 3600 * 1000) {
    advice.push(`.wslconfig vmIdleTimeout=${idle} (>2h) — lower it so idle WSL RAM is returned to Windows`);
  }
  const reclaim = cfg["experimental.automemoryreclaim"] || cfg["wsl2.automemoryreclaim"];
  if (!reclaim) {
    advice.push(".wslconfig has no autoMemoryReclaim=gradual — idle WSL memory is never reclaimed");
  }
  const swap = cfg["wsl2.swap"];
  if (swap === "0") {
    advice.push(".wslconfig swap=0 disables swap — keep a modest swap file so a spike degrades instead of OOM-freezing");
  } else if (swap && memToGb(swap) != null && memToGb(swap) >= 8) {
    advice.push(
      `.wslconfig swap=${swap} allows long swap-thrash before an OOM — a smaller swap (2–4 GB) fails faster and lets the ` +
        `capacity guard intervene (scripts/wsl-tune.sh sets this)`
    );
  }
  return advice;
}

module.exports = {
  DEFAULT_ENVELOPE,
  ENVELOPE_KEYS,
  classifyHeavy,
  isHeavyCommand,
  isLongLivedHeavy,
  parseMemMb,
  groupBudget,
  parseEnvelope,
  envelopePath,
  readEnvelopeText,
  readEnvelope,
  isWsl,
  readMem,
  readLoad,
  readPsi,
  readHost,
  readTuning,
  readServes,
  readTmpfs,
  sample,
  evaluate,
  formatSummary,
  heavyBlockText,
  notice,
  lockPath,
  readLock,
  lockMembers,
  lockIsStale,
  acquireHeavyLock,
  updateHeavyMember,
  releaseHeavyLock,
  clearHeavyLock,
  isAlive,
  parseWslConfig,
  readWslConfig,
  wslConfigAdvice,
};
