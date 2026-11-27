"use strict";
/*
 * F-046 — one case/separator-insensitive feature resolver across the resume
 * surfaces (checkpoint, orient, finalize, backlog).
 *
 * Regression this locks: `checkpoint resume --feature f-045` used to build
 * `.agents/handoffs/f-045.md` from the raw argument, miss the canonical
 * `F-045.md`, and exit 1; a lowercase write created a SECOND handoff file; a
 * handoff living only in the main checkout was invisible from a feature
 * worktree; and the readiness output told the session to use a nonexistent
 * `session_move` tool.
 *
 * Fixtures are real temp trees (one with a real linked worktree), so the test
 * exercises the same `git worktree list` / filesystem calls the CLI uses.
 */
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const CP = path.join(ROOT, "scripts", "checkpoint.js");
const resolver = require("../scripts/qa/feature-resolver.js");

function project(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-${name}-`));
  fs.mkdirSync(path.join(dir, ".agents", "handoffs"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".agents", "features"), { recursive: true });
  return dir;
}

function cp(root, ...args) {
  return spawnSync(process.execPath, [CP, ...args, "--root", root], { cwd: root, encoding: "utf8" });
}

function writeCheckpoint(root, feature = "F-045") {
  const w = cp(
    root,
    "write",
    "--feature", feature,
    "--objective", "make resume deterministic",
    "--phase", "testing",
    "--next-action", "resume from a lowercase id"
  );
  assert.strictEqual(w.status, 0, w.stderr);
  return path.join(root, ".agents", "handoffs", `${feature}.md`);
}

function git(cwd, ...args) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.strictEqual(res.status, 0, `git ${args.join(" ")} failed: ${res.stderr}`);
  return String(res.stdout || "").trim();
}

/* A real repo + one linked feature worktree (branch f-045). */
function worktreeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-resume-wt-"));
  const repo = path.join(dir, "repo");
  const wt = path.join(dir, "f-045");
  fs.mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "checkout", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-q", wt, "-b", "f-045");
  return { dir, repo, wt };
}

test("resolver compares ids ignoring case and separators", () => {
  for (const raw of ["f-046", "F_046", "f 046", "F-046"]) {
    assert.strictEqual(resolver.normalizeId(raw), resolver.normalizeId("F-046"), raw);
  }
  assert.strictEqual(resolver.stripExtension("F-046.md"), "F-046", "a .md suffix is stripped before resolving");
  assert.strictEqual(resolver.canonicalId("f-46"), "F-46");
  assert.strictEqual(resolver.canonicalId("F_046"), "F-046");
  assert.strictEqual(resolver.canonicalId("my-feature"), "my-feature", "a non-id slug keeps its spelling");
  assert.ok(resolver.nearMisses("f-044", ["F-045", "F-090"]).includes("F-045"));
});

test("lowercase resume finds the canonical handoff and reports its absolute path", () => {
  const root = project("resume-case");
  const file = writeCheckpoint(root);

  const r = cp(root, "resume", "--feature", "f-045");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^- feature: F-045$/m, "the canonical id is reported");
  assert.match(r.stdout, /> handoff: /, "the resolved absolute path is surfaced");
  assert.ok(r.stdout.includes(file), `output names ${file}`);
  assert.match(r.stdout, /resolved from "f-045"/);
  assert.match(r.stdout, /^- objective: make resume deterministic$/m);

  const json = JSON.parse(cp(root, "resume", "--feature", "f-045", "--json").stdout);
  assert.strictEqual(json.input, "f-045");
  assert.strictEqual(json.feature, "F-045");
  assert.strictEqual(json.file, file);
  assert.deepStrictEqual(json.suggestions, []);

  assert.ok(!fs.existsSync(path.join(root, ".agents", "handoffs", "f-045.md")), "no duplicate lowercase handoff");
});

test("a lowercase write updates the single canonical handoff", () => {
  const root = project("resume-write");
  const file = writeCheckpoint(root);

  const w = cp(root, "write", "--feature", "f_045", "--phase", "verified");
  assert.strictEqual(w.status, 0, w.stderr);
  assert.match(w.stdout, /updated \.agents\/handoffs\/F-045\.md/);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /checkpoint_count: 2/);
  assert.match(text, /- phase: verified/);
  assert.strictEqual(fs.readdirSync(path.join(root, ".agents", "handoffs")).filter((n) => /^f[_-]?045/i.test(n)).length, 1);
});

test("a missing handoff fails loudly with a near-miss suggestion", () => {
  const root = project("resume-miss");
  writeCheckpoint(root);

  const r = cp(root, "resume", "--feature", "f-044");
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no handoff found for "f-044"/);
  assert.match(r.stderr, /did you mean F-045\?/);
  assert.match(r.stderr, /searched .*\.agents\/handoffs/, "the searched roots are named");
});

test("a handoff in the main checkout is read from the feature worktree (single-root regression)", () => {
  const f = worktreeRepo();
  // No worktree is named F-046, so this handoff is written in the main checkout.
  writeCheckpoint(f.repo, "F-046");
  assert.ok(!fs.existsSync(path.join(f.wt, ".agents", "handoffs", "F-046.md")));

  // The session is rooted in the f-045 worktree, but reads F-046 from main.
  const r = cp(f.wt, "resume", "--feature", "f-046");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^- feature: F-046$/m);
  assert.match(r.stdout, /handoff lives in another checkout/);
});

test("resume names the real session-move capability on a root mismatch", () => {
  const f = worktreeRepo();
  writeCheckpoint(f.wt);

  const r = cp(f.repo, "resume", "--feature", "f-045");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /ROOT MISMATCH/);
  assert.ok(r.stdout.includes(`tools.opencode.session.move (directory: "${f.wt}")`), r.stdout);
  assert.doesNotMatch(r.stdout, /session_move[^_]/, "the nonexistent tool is never named");
});

test("backlog row lookup is case/separator-insensitive", () => {
  const backlog = require("../scripts/backlog.js");
  const lines = [
    "## In progress",
    "",
    "| ID | Epic | Task | Handoff |",
    "| --- | --- | --- | --- |",
    "| F-046 | ? | deterministic resume | F-046.md |",
    "",
  ];
  for (const id of ["f-046", "F_046", "f 046"]) {
    const found = backlog.findRow(lines, id);
    assert.ok(found, `findRow(${id})`);
    assert.strictEqual(found.key, "inprogress");
    assert.strictEqual((found.cells[0] || "").trim(), "F-046");
  }
  assert.strictEqual(backlog.findRow(lines, "F-999"), null);
});

test("orient brief never reports an unconfirmed state as ready to proceed", () => {
  const brief = require("../scripts/orient.js").printBrief;
  const base = {
    repo: { kind: "linked", branch: "f-046", head: "abc1234", dirty: 0 },
    root: "/repo/worktrees/f-046",
    harnessVersion: "0.5.6",
    persona: null,
    personas: [],
    memory: null,
    feature: "F-046",
    ownedFiles: null,
    checkpoint: null,
    diagnosis: null,
    board: null,
    capacity: null,
    lastE2e: null,
    nightly: null,
    rootMismatch: false,
    featureWorktree: null,
    featureSource: "branch",
  };
  assert.match(brief(base), /Proceed from the checkpoint\/next/);

  const mismatch = brief({
    ...base,
    rootMismatch: true,
    featureWorktree: { path: "/repo/worktrees/f-046", branch: "f-046" },
  });
  assert.match(mismatch, /DO NOT PROCEED/);
  assert.match(mismatch, /tools\.opencode\.session\.move/);
  assert.doesNotMatch(mismatch, /Proceed from the checkpoint/);

  const boardGuessed = brief({ ...base, featureSource: "board" });
  assert.match(boardGuessed, /inferred from the board/);
  assert.doesNotMatch(boardGuessed, /Proceed from the checkpoint/);
});

/* LibraryOS F-372: the board row's Handoff cell points at a slug-named file
 * (`.agents/handoffs/platform-review-2026-11.md`), so resolving the row id used
 * to miss the checkpoint and suggest unrelated numeric ids instead. */
function writeFileBoard(root, rows) {
  fs.writeFileSync(
    path.join(root, ".harness.json"),
    JSON.stringify({ board: { backend: "file", project: "Fixtures" } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, "BACKLOG.md"),
    [
      "## In progress",
      "",
      "| ID | Epic | Task | Handoff |",
      "| --- | --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
    "utf8"
  );
}

test("a board row's declared slug handoff is resolved by the feature id", () => {
  const root = project("resume-board-handoff");
  const slug = path.join(root, ".agents", "handoffs", "platform-review-2026-11.md");
  const w = cp(
    root,
    "write",
    "--feature", "platform-review-2026-11",
    "--phase", "plan complete",
    "--next-action", "run Phase 0"
  );
  assert.strictEqual(w.status, 0, w.stderr);
  writeFileBoard(root, ["| F-372 | audits | full-stack review | .agents/handoffs/platform-review-2026-11.md |"]);

  const r = cp(root, "resume", "--feature", "F-372");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^- phase: plan complete$/m);
  assert.match(r.stdout, /^- next_action: run Phase 0$/m);
  assert.ok(r.stdout.includes(slug), "the declared slug file is the handoff");

  const json = JSON.parse(cp(root, "resume", "--feature", "F-372", "--json").stdout);
  assert.strictEqual(json.file, slug);
  assert.strictEqual(json.feature, "F-372");

  // A write through the row id updates the declared file, never a second F-372.md.
  const w2 = cp(root, "write", "--feature", "F-372", "--phase", "executing");
  assert.strictEqual(w2.status, 0, w2.stderr);
  assert.ok(!fs.existsSync(path.join(root, ".agents", "handoffs", "F-372.md")), "no id-named duplicate");
  assert.match(fs.readFileSync(slug, "utf8"), /- phase: executing/);
});

test("resume --list names the In-progress checkpoints when the id is unknown", () => {
  const root = project("resume-list");
  writeCheckpoint(root); // F-045, phase testing, next action recorded
  cp(root, "write", "--feature", "platform-review-2026-11", "--phase", "plan", "--next-action", "start Phase 0");
  writeFileBoard(root, [
    "| F-045 | ? | first work unit | .agents/handoffs/F-045.md |",
    "| F-372 | audits | review | .agents/handoffs/platform-review-2026-11.md |",
  ]);

  const r = cp(root, "resume", "--list");
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /resumable checkpoints \(2\)/);
  assert.match(r.stdout, /F-045 · phase testing · next: resume from a lowercase id/);
  assert.match(r.stdout, /F-372 · phase plan · next: start Phase 0/);
  assert.match(r.stdout, /resume --feature <id>/);

  // `resume` with no feature is the same listing, and --json is machine-readable.
  assert.strictEqual(cp(root, "resume").status, 0);
  const json = JSON.parse(cp(root, "resume", "--list", "--json").stdout);
  assert.strictEqual(json.schema, "checkpoint-list/1");
  assert.deepStrictEqual(json.checkpoints.map((c) => c.feature), ["F-045", "F-372"]);
});
