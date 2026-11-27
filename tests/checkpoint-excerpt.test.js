"use strict";
/*
 * F-058 — resume/checkpoint reads are bounded.
 *
 * A fresh context must get the checkpoint state plus a heading outline, never
 * the whole handoff. Fixtures are real 30 KB+ files; the far-end sentinel can
 * only appear if the cap/outline is not applied (the independent oracle).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CP = path.join(ROOT, "scripts", "checkpoint.js");
const ORIENT = require("../scripts/orient.js");

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-${name}-`));
  fs.mkdirSync(path.join(dir, ".agents", "handoffs"), { recursive: true });
  return dir;
}

function cp(root, ...args) {
  return spawnSync(process.execPath, [CP, ...args, "--root", root], { cwd: root, encoding: "utf8" });
}

/* A realistically large handoff: ~35 KB of sections plus an optional checkpoint
 * block at the far end. The sentinel after the last section must never leak
 * into a bounded excerpt. */
function bigHandoff(root, { withBlock = true, blockBytes = 0 } = {}) {
  let s = "# Handoff — big review\n\n## Task\nDo the thing.\n\n";
  for (let i = 0; i < 80; i++) s += `## Section ${i}\n${"x".repeat(400)}\n\n`;
  s += "## Next action\nRead Section 7 next.\n\nFAR-END-MARKER\n";
  if (withBlock) {
    s +=
      "\n## Checkpoint (resume)\n\n- feature: F-058\n- objective: bound reads\n" +
      "- phase: verifying\n- next_action: run the targeted tests then quick\n- checkpoint_count: 2\n";
    if (blockBytes) s += `- facts:\n  - ${"y".repeat(blockBytes)}\n`;
  }
  const file = path.join(root, ".agents", "handoffs", "F-058.md");
  fs.writeFileSync(file, s);
  return file;
}

test("A1: a 30KB+ handoff resumes as a <=3 KB excerpt with phase/next/outline", () => {
  const root = project("excerpt-a1");
  const file = bigHandoff(root, { blockBytes: 6000 });
  assert.ok(fs.statSync(file).size > 30000, "fixture is a realistically large handoff");

  const human = cp(root, "resume", "--feature", "F-058");
  assert.strictEqual(human.status, 0, human.stderr);
  assert.match(human.stdout, /^> excerpt: \d+ B of \d+ B handoff/m);
  assert.ok(Buffer.byteLength(human.stdout) <= 4096, `human resume stayed bounded (${Buffer.byteLength(human.stdout)} B)`);

  const json = JSON.parse(cp(root, "resume", "--feature", "F-058", "--json").stdout);
  assert.strictEqual(json.checkpoint, true);
  assert.strictEqual(json.hasCheckpoint, true);
  assert.strictEqual(json.truncated, true, "the oversized block is capped");
  assert.ok(Buffer.byteLength(json.excerpt) <= 3072, `excerpt is ${Buffer.byteLength(json.excerpt)} B`);
  assert.match(json.excerpt, /^- phase: verifying$/m);
  assert.match(json.excerpt, /^- next_action: run the targeted tests then quick$/m);
  assert.match(json.excerpt, /## Handoff outline/);
  assert.match(json.excerpt, /- Task/);
  assert.doesNotMatch(json.excerpt, /FAR-END-MARKER/, "the far end of the file is never included");
  assert.ok(json.headings.length > 0);
});

test("A2: a handoff without a ## Checkpoint block yields a bounded best-effort excerpt", () => {
  const root = project("excerpt-a2");
  bigHandoff(root, { withBlock: false });

  const human = cp(root, "resume", "--feature", "F-058");
  assert.strictEqual(human.status, 0, human.stderr);
  assert.match(human.stdout, /no ## Checkpoint block; best-effort phase\/next/);

  const json = JSON.parse(cp(root, "resume", "--feature", "F-058", "--json").stdout);
  assert.strictEqual(json.checkpoint, false);
  assert.strictEqual(json.hasCheckpoint, false);
  assert.ok(Buffer.byteLength(json.excerpt) <= 3072);
  assert.match(json.excerpt, /no `## Checkpoint` block found/);
  assert.match(json.excerpt, /^- next_action: Read Section 7 next\.$/m);
  assert.match(json.excerpt, /## Handoff outline/);
  assert.doesNotMatch(json.excerpt, /FAR-END-MARKER/);
});

test("A3: a truly missing handoff still fails loudly", () => {
  const root = project("excerpt-a3");
  bigHandoff(root);
  const miss = cp(root, "resume", "--feature", "F-999");
  assert.strictEqual(miss.status, 1);
  assert.match(miss.stderr, /no handoff found for "F-999"/);
});

test("A4: orient carries the bounded phase/next plus the top-level outline", () => {
  const root = project("excerpt-a4");
  const o = ORIENT.collectOrient({
    root,
    feature: "F-058",
    git: () => null,
    run: () => null,
    readCheckpoint: () => ({
      feature: "F-058",
      file: path.join(root, ".agents", "handoffs", "F-058.md"),
      state: { phase: "verifying", next_action: "q".repeat(2000), checkpoint_count: 1 },
      checkpoint: true,
      headings: [
        { level: 2, name: "Task" },
        { level: 2, name: "Risks" },
        { level: 3, name: "Sub" },
      ],
    }),
  });

  const report = ORIENT.printHuman(o);
  assert.match(report, /^sections: Task · Risks$/m, "only level-2 headings are listed");
  assert.doesNotMatch(report, /q{600}/, "the next action is clipped");
  assert.ok(Buffer.byteLength(report) < 8192, `report stays bounded (${Buffer.byteLength(report)} B)`);

  const brief = ORIENT.printBrief(o);
  assert.ok(Buffer.byteLength(brief) < 2048, `brief stays bounded (${Buffer.byteLength(brief)} B)`);
  assert.doesNotMatch(brief, /q{400}/, "the brief clips the next action tighter");
});
