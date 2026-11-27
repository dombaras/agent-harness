"use strict";
/*
 * F-059 — progressive disclosure for large `.agents/**` state docs.
 *
 * The measured failure: a 52,020 B FINDINGS-REGISTER.md read whole (context
 * 32,880 -> 47,382) when the first edit landed at 72,577. Two behaviours are
 * locked here:
 *   - `outline` lists a markdown file's sections with line ranges, so one
 *     section can be opened with `read` offset/limit;
 *   - the context guard aborts an UNRANGED read of a large `.agents/**`
 *     markdown doc and names the ranged call instead.
 *
 * The fixture's section boundaries are hand-derived (independent oracle), not
 * recomputed by the implementation; the CLI runs as a real process and the
 * deployed/template copies are byte-compared (the F-053 drift class).
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const OUTLINE = path.join(ROOT, "scripts", "qa", "outline.js");
const lib = require("../scripts/qa/outline-lib.js");

const FIXTURE = [
  "# Register",
  "intro line",
  "```md",
  "## not a heading (fenced)",
  "```",
  "## Alpha",
  "alpha body",
  "### Alpha detail",
  "detail body",
  "## Beta",
  "beta body",
  "",
].join("\n");

function tempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-outline-"));
  fs.mkdirSync(path.join(dir, ".agents", "reviews", "x"), { recursive: true });
  return dir;
}

test("A1: parseHeadings returns hand-derived section extents and skips fenced headings", () => {
  const headings = lib.parseHeadings(FIXTURE);
  assert.deepStrictEqual(
    headings.map((h) => ({ level: h.level, name: h.name, line: h.line, endLine: h.endLine })),
    [
      { level: 1, name: "Register", line: 1, endLine: 12 },
      { level: 2, name: "Alpha", line: 6, endLine: 9 },
      { level: 3, name: "Alpha detail", line: 8, endLine: 9 },
      { level: 2, name: "Beta", line: 10, endLine: 12 },
    ],
    "nested extents end before the next same-or-higher heading; a fenced '##' is body text"
  );
});

test("A2: renderOutline prints the byte size, line ranges, and a bounded truncation note", () => {
  const text = lib.renderOutline(".agents/x.md", FIXTURE);
  assert.match(text, /^state-doc outline — \.agents\/x\.md \([\d,]+ B, 12 lines\)/m);
  assert.match(text, /^ {2}L {4}6- {4}9 {4}## Alpha$/m, "a section is copyable as offset: 6, limit: 4");
  assert.doesNotMatch(text, /fenced/, "a heading inside a fence is never listed");

  const capped = lib.renderOutline(".agents/x.md", FIXTURE, { max: 2 });
  assert.match(capped, /2 more heading\(s\)/, "only 2 of 4 headings listed");
  assert.match(capped, /raise --max/);

  const level2 = lib.renderOutline(".agents/x.md", FIXTURE, { maxLevel: 2 });
  assert.doesNotMatch(level2, /### Alpha detail/, "maxLevel filters deeper headings");
});

test("A3: isStateDocPath owns only .agents/** markdown and rejects traversal", () => {
  const root = "/repo";
  assert.strictEqual(lib.isStateDocPath(".agents/reviews/x/FINDINGS.md", root), ".agents/reviews/x/FINDINGS.md");
  assert.strictEqual(lib.isStateDocPath("./.agents/handoffs/F-059.md", root), ".agents/handoffs/F-059.md");
  assert.strictEqual(lib.isStateDocPath(path.join(root, ".agents/memory/orchestration.md"), root), ".agents/memory/orchestration.md");
  assert.strictEqual(lib.isStateDocPath(".agents\\reviews\\x\\R.md", root), ".agents/reviews/x/R.md", "Windows separators normalize");
  assert.strictEqual(lib.isStateDocPath(".agents/notes.txt", root), "", "non-markdown is not a state doc");
  assert.strictEqual(lib.isStateDocPath("AGENTS.md", root), "", "the root AGENTS.md is not under .agents/");
  assert.strictEqual(lib.isStateDocPath("docs/README.md", root), "", "human docs stay outside the guard");
  assert.strictEqual(lib.isStateDocPath("../outside/.agents/x.md", root), "", "traversal is refused");
  assert.strictEqual(lib.isStateDocPath("/elsewhere/.agents/x.md", root), "", "an absolute path outside the root is refused");
});

test("A4: stateDocReadDecision blocks a large unranged .agents doc and allows every intended variant", () => {
  const base = { filePath: ".agents/reviews/x/FINDINGS.md", root: "/repo", bytes: 52020, args: {}, env: {} };
  assert.strictEqual(lib.stateDocReadDecision(base).block, true, "52 KB unranged read is blocked");
  assert.strictEqual(lib.stateDocReadDecision({ ...base, args: { offset: 1, limit: 80 } }).block, false, "ranged reads are the fix");
  assert.strictEqual(lib.stateDocReadDecision({ ...base, args: { limit: 200 } }).block, false, "limit alone is bounded");
  assert.strictEqual(lib.stateDocReadDecision({ ...base, bytes: 2000 }).block, false, "a small doc is not gated");
  assert.strictEqual(lib.stateDocReadDecision({ ...base, args: {}, env: { AGENT_GUARD_STATEDOC: "0" } }).block, false, "explicit disable");
  assert.strictEqual(lib.stateDocReadDecision({ ...base, args: {}, env: { AGENT_STATE_READ_BYTES: "60000" } }).block, false, "threshold override");
  assert.strictEqual(lib.stateDocReadDecision({ ...base, filePath: "src/app.js" }).block, false, "code is never gated");
});

test("A5: stateDocReadText carries the outline, the exact next call, and the disable switch", () => {
  const decision = { block: true, relPath: ".agents/x.md", bytes: 52020, limitBytes: 12000 };
  const text = lib.stateDocReadText(decision, FIXTURE);
  assert.match(text, /TOOL GUARD — `\.agents\/x\.md` is a large state doc \(52,020 B > 12,000 B\)/);
  assert.match(text, /Outline \(L<start>-<end>\):/);
  assert.match(text, /^ {2}L {4}6- {4}9 {4}## Alpha$/m);
  assert.match(text, /Next call: read\(filePath: "\.agents\/x\.md", offset: 6, limit: 4\)\./);
  assert.match(text, /AGENT_GUARD_STATEDOC=0/);
});

test("B1: the outline CLI prints a real outline and exits 2 on a missing file", () => {
  const dir = tempProject();
  const rel = ".agents/reviews/x/REGISTER.md";
  fs.writeFileSync(path.join(dir, rel), FIXTURE);
  try {
    const ok = spawnSync(process.execPath, [OUTLINE, rel, "--root", dir], { encoding: "utf8" });
    assert.strictEqual(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /REGISTER\.md/);
    assert.match(ok.stdout, /^ {2}L {4}6- {4}9 {4}## Alpha$/m);

    const json = spawnSync(process.execPath, [OUTLINE, rel, "--root", dir, "--json"], { encoding: "utf8" });
    assert.strictEqual(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.strictEqual(parsed.headings.length, 4, "JSON carries the same section list");
    assert.deepStrictEqual(parsed.headings[1], { level: 2, name: "Alpha", line: 6, endLine: 9 });

    const missing = spawnSync(process.execPath, [OUTLINE, ".agents/reviews/x/nope.md", "--root", dir], { encoding: "utf8" });
    assert.strictEqual(missing.status, 2, "a missing file is an actionable non-zero exit");
    assert.match(missing.stderr, /cannot read/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("B2: deployed copies are byte-identical to templates (no uncommitted-copy drift)", () => {
  for (const rel of [
    "scripts/qa/outline-lib.js",
    "scripts/qa/outline.js",
    "scripts/qa/context-guard-core.js",
    ".opencode/plugins/outline.ts",
    ".opencode/plugins/context-guard.ts",
  ]) {
    const deployed = fs.readFileSync(path.join(ROOT, rel));
    const template = fs.readFileSync(path.join(ROOT, "templates", rel));
    assert.ok(deployed.equals(template), `${rel} must match templates/${rel}`);
  }
});

test("B3: the guard is wired pre-read in the plugin and exported by the pure core (source contract)", () => {
  const plugin = fs.readFileSync(path.join(ROOT, ".opencode/plugins/context-guard.ts"), "utf8");
  const core = require("../scripts/qa/context-guard-core.js");
  assert.match(plugin, /stateDocReadDecision/, "the plugin consults the state-doc decision");
  assert.match(plugin, /stateDocReadText/, "the abort text comes from the pure module");
  assert.match(plugin, /throw new Error\(stateDocBlock\)/, "the block aborts the read tool");
  assert.strictEqual(typeof core.stateDocReadDecision, "function");
  assert.strictEqual(core.STATE_DOC_READ_BYTES, lib.DEFAULT_STATE_DOC_BYTES);
});
