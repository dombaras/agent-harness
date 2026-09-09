#!/usr/bin/env node
"use strict";
/*
 * test:docs — documentation hygiene gate (harness-shipped).
 *
 * Enforces the docs-as-code invariants the `docs` persona promises, mechanically:
 *   1. No un-substituted `{{PLACEHOLDER}}` template vars left in any deployed doc
 *      (init/update substitute {{PROJECT_NAME}} / {{PROJECT_DOMAIN}} — a stray
 *      `{{...}}` in a shipped doc is a deploy bug).
 *   2. No dangling relative markdown links in README.md / docs/** (a doc that
 *      points at a path that no longer exists is drift).
 *   3. Every ADR (docs/adr/*.md) carries the required sections, each non-empty:
 *        ## Context  ·  ## Decision  ·  ## Consequences
 *      plus a Status line (proposed | accepted | superseded).
 *   4. Changelog completeness: every shipped commit (`feat`/`fix`/`refactor`/
 *      `perf`) since CHANGELOG.md first appeared must be cited in it by short
 *      hash (`abc1234` — backticked or parenthesized). This is the mechanical
 *      backstop that keeps the changelog from silently drifting.
 *   5. Review/audit ships are changelog-visible: a commit that delivers durable
 *      review findings under `.agents/reviews/**` is a meaningful milestone even
 *      though it ships as `docs`/`chore`, so it must be cited in CHANGELOG.md
 *      like any feat/fix (convention: append a `docs(review)` line). This makes
 *      "we ran a review and filed N rows" appear in the human changelog instead
 *      of being invisible because a code-quality review ships as `docs`/`chore`.
 *
 * Backward compatible: with no README.md and no docs/ tree the gate warns and
 * passes — projects opt in by keeping docs. Links are checked only against the
 * local filesystem; http(s)/mailto/`#anchor`/reference-style links are skipped.
 * A missing CHANGELOG.md (or a git-less checkout) only warns — changelog
 * completeness is enforced once a committed CHANGELOG.md exists.
 *
 *   node scripts/qa/check-docs.js
 *
 * Exit 0 on: no docs, or every doc satisfying the contract.
 * Exit 1 on: any placeholder left behind, dangling link, or malformed ADR.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..", "..");

const failures = [];
const pass = (m) => console.log("  \u2713 " + m);
const fail = (m) => {
  failures.push(m);
  console.log("  \u2717 " + m);
};
const warn = (m) => console.log("  \u26a0 " + m);

console.log("docs gate \u2014 docs-as-code: no placeholders, no dangling links, well-formed ADRs, complete changelog");

// ---- collect doc files -------------------------------------------------------
const docFiles = [];
const readme = path.join(root, "README.md");
if (fs.existsSync(readme)) docFiles.push({ abs: readme, rel: "README.md" });

const docsDir = path.join(root, "docs");
function collectDocs(dir, base) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) collectDocs(abs, base);
    else if (entry.name.endsWith(".md")) docFiles.push({ abs, rel: path.relative(base, abs) });
  }
}
collectDocs(docsDir, root);

if (docFiles.length === 0) {
  warn("no README.md and no docs/ tree \u2014 nothing to enforce");
  console.log("\nRESULT: green (no docs)");
  process.exit(0);
}

// ---- 1. no un-substituted template placeholders -----------------------------
const PLACEHOLDER = /\{\{[A-Z_]+\}\}/;
for (const { abs, rel } of docFiles) {
  const src = fs.readFileSync(abs, "utf8");
  const m = src.match(PLACEHOLDER);
  if (m) fail(`${rel}: un-substituted placeholder \`${m[0]}\` \u2014 deploy substitutes it`);
  else pass(`${rel}: no un-substituted template placeholders`);
}

// ---- 2. no dangling relative links ------------------------------------------
function relativeLinks(src) {
  const links = [];
  const re = /(?<!\!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(src)) !== null) links.push(m[1]);
  return links;
}
function isExternal(target) {
  return (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || // scheme (http:, mailto:, etc.)
    /^\/\//.test(target) || // protocol-relative
    /^#/.test(target) // anchor only
  );
}
for (const { abs, rel } of docFiles) {
  const src = fs.readFileSync(abs, "utf8");
  let dangling = 0;
  for (const raw of relativeLinks(src)) {
    let target = raw.trim();
    if (!target) continue;
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    if (isExternal(target)) continue;
    const filePart = target.split("#")[0];
    if (!filePart) continue; // pure anchor (#heading)
    const resolved = path.resolve(path.dirname(abs), filePart);
    if (!fs.existsSync(resolved)) {
      fail(`${rel}: dangling link \`${raw}\` \u2192 ${path.relative(root, resolved)} does not exist`);
      dangling++;
    }
  }
  if (dangling === 0) pass(`${rel}: relative links resolve`);
}

// ---- 3. ADRs carry Context / Decision / Consequences + Status ---------------
function section(src, re) {
  const lines = src.split(/\r?\n/);
  let inSec = false;
  const body = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!inSec) {
      if (re.test(line)) inSec = true;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) break;
    if (line && !/^<!--/.test(line) && !/_TODO:/.test(line)) body.push(line);
  }
  return body;
}
function hasSection(src, re) {
  return section(src, re).length > 0;
}

const adrDir = path.join(docsDir, "adr");
if (!fs.existsSync(adrDir)) {
  pass("no docs/adr/ directory \u2014 ADR checks skipped");
} else {
  const adrs = fs
    .readdirSync(adrDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md") && !/^(INDEX|README)\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  if (adrs.length === 0) {
    pass("docs/adr/ present but empty");
  } else {
    const H = {
      context: /^#{1,6}\s*Context\b/i,
      decision: /^#{1,6}\s*Decision\b/i,
      consequences: /^#{1,6}\s*Consequences\b/i,
    };
    for (const name of adrs) {
      const src = fs.readFileSync(path.join(adrDir, name), "utf8");
      const missing = [];
      if (!hasSection(src, H.context)) missing.push("## Context");
      if (!hasSection(src, H.decision)) missing.push("## Decision");
      if (!hasSection(src, H.consequences)) missing.push("## Consequences");
      if (!/^Status:\s*(proposed|accepted|superseded|deprecated|rejected)\s*$/im.test(src) && !hasSection(src, /^#{1,6}\s*Status\b/i)) {
        missing.push("Status (proposed|accepted|superseded)");
      }
      if (missing.length) fail(`adr/${name}: missing \u2014 ${missing.join(", ")}`);
      else pass(`adr/${name}: context \u2192 decision \u2192 consequences + status present`);
    }
  }
}

// ---- 4. changelog completeness (every shipped commit is recorded) ----------
const changelogPath = path.join(root, "CHANGELOG.md");
function gitLog(args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}
if (!fs.existsSync(changelogPath)) {
  warn("no CHANGELOG.md \u2014 changelog completeness not enforced");
} else {
  const baseline = gitLog(["log", "--diff-filter=A", "--format=%H", "-1", "--", "CHANGELOG.md"]);
  if (!baseline || !baseline.trim()) {
    warn("CHANGELOG.md has no git history \u2014 changelog completeness skipped");
  } else {
    const changelog = fs.readFileSync(changelogPath, "utf8");
    const cited = new Set();
    const hashRe = /(?:`|[(])([0-9a-f]{7,40})(?:`|[)]|\s)/gi;
    let m;
    while ((m = hashRe.exec(changelog)) !== null) cited.add(m[1].slice(0, 7).toLowerCase());

    const log = gitLog(["log", "--no-merges", "--format=%h%x09%s", `${baseline.trim()}..HEAD`]);
    if (log === null) {
      warn("git unavailable \u2014 changelog completeness skipped");
    } else {
      const missing = [];
      for (const line of log.split(/\r?\n/)) {
        if (!line) continue;
        const sep = line.indexOf("\t");
        if (sep < 0) continue;
        const hash = line.slice(0, sep);
        const subject = line.slice(sep + 1);
        if (!/^(feat|fix|refactor|perf)(\([^)]*\))?:/.test(subject)) continue;
        if (!cited.has(hash.toLowerCase())) missing.push({ hash, subject });
      }

      // 5. Review/audit deliverables are milestones too — a commit that ships
      // `.agents/reviews/**` is changelog-worthy even as docs/chore.
      const reviewLog = gitLog([
        "log",
        "--no-merges",
        "--format=%h%x09%s",
        `${baseline.trim()}..HEAD`,
        "--",
        ".agents/reviews/",
      ]);
      if (reviewLog) {
        for (const line of reviewLog.split(/\r?\n/)) {
          if (!line) continue;
          const sep = line.indexOf("\t");
          if (sep < 0) continue;
          const hash = line.slice(0, sep);
          const subject = line.slice(sep + 1);
          if (!cited.has(hash.toLowerCase())) {
            missing.push({ hash, subject, note: "ships .agents/reviews/ — append a docs(review) changelog line" });
          }
        }
      }

      if (missing.length === 0) {
        pass(`CHANGELOG.md: every shipped commit since ${baseline.trim().slice(0, 7)} is recorded`);
      } else {
        for (const { hash, subject, note } of missing) {
          fail(
            `CHANGELOG.md: missing entry for ${hash} \u2014 ${subject}` +
              (note ? ` (${note})` : "")
          );
        }
      }
    }
  }
}

console.log(
  "\nRESULT: " +
    (failures.length
      ? `${failures.length} FAILURE(S) \u2014 docs must have no placeholders, no dangling links, well-formed ADRs, and a complete changelog`
      : "green \u2014 docs are in sync")
);
process.exit(failures.length ? 1 : 0);
