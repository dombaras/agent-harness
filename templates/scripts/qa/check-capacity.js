#!/usr/bin/env node
"use strict";
/*
 * test:capacity — the machine capacity envelope gate (harness-shipped).
 *
 * The 2026-09-29 freeze was a WSL2 memory/CPU exhaustion, not a stuck agent:
 * emulator (~3 GB) + two opencode agents + `next dev` + a gate filled a 10 GB
 * VM, swap hit 4 GB, load hit 60, and the host<->VM vsock relay starved — every
 * terminal froze at once. Parallel *agents* are fine; parallel *heavy tiers* are
 * not. This gate makes the envelope visible and mechanical:
 *
 *   - reports free RAM / swap / load / live `.serve/` processes + idle ages;
 *   - FAILS when the envelope is already exceeded (free RAM below the floor, or
 *     more live heavy tiers than allowed) — the state in which a heavy launch
 *     tips the machine into thrash;
 *   - WARNS on the softer signals (too many live serves, swap high, an idle
 *     daemon past the reap age) so the fix is obvious before it is fatal;
 *   - SKIPS (exit 0) on a non-Linux host or when AGENT_CAPACITY_DISABLE=1.
 *
 * The numbers are the project-owned envelope in `.agents/memory/orchestration.md`
 * (shared with `serve.js`, the `context-guard` plugin, and `doctor`), falling
 * back to documented defaults. Stay quiet when there is nothing to fix.
 */
const path = require("path");
const capacity = require("./capacity-lib.js");

const root = path.resolve(__dirname, "..", "..");

console.log("capacity gate \u2014 the machine capacity envelope must not already be exceeded");

if (process.env.AGENT_CAPACITY_DISABLE === "1") {
  console.log("  \u26a0 capacity checks disabled (AGENT_CAPACITY_DISABLE=1)");
  console.log("\nRESULT: skipped (0 failures)");
  process.exit(0);
}

const sample = capacity.sample(root);
if (!sample.mem) {
  console.log("  \u26a0 host memory not readable (non-Linux) \u2014 capacity gate skipped");
  console.log("\nRESULT: skipped (0 failures)");
  process.exit(0);
}

const e = sample.envelope;
console.log(`  ${capacity.formatSummary(sample)}`);
console.log(
  `  envelope: max_heavy_tiers=${e.maxHeavyTiers} · max_live_serves=${e.maxLiveServes} · ` +
    `min_available_mem_mb=${e.minAvailableMemMb} · idle_reap_minutes=${e.idleReapMinutes}`
);

const live = sample.serves.filter((s) => s.alive);
if (sample.serves.length) {
  for (const s of sample.serves) {
    const age = s.ageMs != null ? ` · up ${Math.round(s.ageMs / 60000)}m` : "";
    console.log(
      `    ${s.alive ? "live " : "stale"} ${s.name}${s.heavy ? " [heavy]" : ""}${age} \u2014 ${s.cmd || "?"}`
    );
  }
} else {
  console.log("    no serve processes recorded");
}

const ev = capacity.evaluate(sample);
for (const w of ev.warnings) console.log("  \u26a0 " + w);
for (const r of ev.reasons) console.log("  \u2717 " + r);

if (!ev.ok) {
  console.log(
    "\n  Stop an idle dev server / emulator before starting another heavy tier:\n" +
      "    node scripts/serve.js stop --name <name>\n" +
      "    node scripts/serve.js stop-all\n" +
      "  (`node scripts/serve.js list` shows ages; the capacity envelope lives in " +
      ".agents/memory/orchestration.md.)"
  );
}

console.log(
  "\nRESULT: " +
    (ev.ok
      ? live.length
        ? "green (capacity within envelope \u2014 see warnings)"
        : "green"
      : `${ev.reasons.length} FAILURE(S) \u2014 the machine capacity envelope is already exceeded`)
);
process.exit(ev.ok ? 0 : 1);
