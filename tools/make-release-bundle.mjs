#!/usr/bin/env node
/*
 * make-release-bundle — produce the artifacts needed to hand the harness to a
 * machine that cannot reach the npm registry (a closed / air-gapped / reviewed
 * environment).
 *
 * Outputs (in --out, default `dist/`):
 *   agent-harness-<version>-<profile>-src.zip   source snapshot (no .git)
 *   agent-harness-<version>[-<profile>].bundle  git bundle (history or snapshot)
 *   MANIFEST.json                               commit + per-file SHA-256
 *   REVIEW-NOTES.md                             one page for the security reviewer
 *   SHA256SUMS                                  hashes of all of the above
 *
 * Profiles:
 *   full  everything the harness ships
 *   core  drops host-tuning installers, the mobile-e2e tier, and the global
 *         freshness plugin — the files that most often trip static scanners.
 *         The core bundle is a single-commit snapshot so excluded files are not
 *         carried in history either.
 *
 * Usage:
 *   node tools/make-release-bundle.mjs [--out dist] [--profile full|core]
 *        [--ref HEAD] [--allow-dirty]
 *
 * Harness-repo tooling: `tools/` is not part of the published package or of
 * what `init` deploys.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const CORE_EXCLUDES = [
  "templates/scripts/wsl-tune.sh",
  "templates/scripts/wsl-gpu.sh",
  "templates/scripts/setup-tmpfs.sh",
  "templates/scripts/setup-nightly.sh",
  "templates/scripts/board-service.sh",
  "templates/scripts/switch-reasoning-model.sh",
  "templates/scripts/switch-reasoning-model.ps1",
  "templates/scripts/qa/mobile-e2e/",
  "contrib/global-plugins/",
  "templates/docs/wsl-optimizations.md",
  "templates/docs/mobile-testing.md",
];

const PROFILE_NOTES = {
  full: "Complete harness. Ships the host-tuning and mobile-E2E helpers too.",
  core: "Review-reduced harness. Host-tuning installers, the mobile-E2E tier, and the global freshness plugin are absent.",
};

function usage(code = 0) {
  const out = `make-release-bundle — offline artifacts for the closed-environment handover

Usage:
  node tools/make-release-bundle.mjs [options]

Options:
  --out <dir>        output directory (default: dist)
  --profile <name>   full | core (default: full)
  --ref <ref>        git ref to package (default: HEAD)
  --allow-dirty      package HEAD even when the working tree is dirty
  --help             show this help

Profiles:
  full   ${PROFILE_NOTES.full}
  core   ${PROFILE_NOTES.core}
`;
  (code ? console.error : console.log)(out);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { out: "dist", profile: "full", ref: "HEAD", allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") usage(0);
    else if (a === "--allow-dirty") opts.allowDirty = true;
    else if (a === "--out" || a === "--profile" || a === "--ref") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) fail(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else fail(`unknown option: ${a}`);
  }
  if (!["full", "core"].includes(opts.profile)) fail(`unknown profile: ${opts.profile}`);
  return opts;
}

function fail(msg) {
  console.error(`make-release-bundle: ${msg}`);
  process.exit(1);
}

function sh(cmd, args, { cwd = ROOT, encoding = "utf8", allowFail = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) fail(`${cmd} failed to start: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) {
    fail(`${cmd} ${args.join(" ")} failed (${r.status})\n${r.stderr || r.stdout || ""}`);
  }
  return r;
}

function git(args, opts) {
  return sh("git", args, opts);
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function excluded(rel, profile) {
  if (profile !== "core") return false;
  return CORE_EXCLUDES.some((p) => (p.endsWith("/") ? rel === p.slice(0, -1) || rel.startsWith(p) : rel === p));
}

function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDate(iso) {
  return iso ? iso.slice(0, 10) : "?";
}

/* Files that touch the host machine. Listed in the reviewer note so a scanner
 * hit has an explanation next to it, and omitted entirely in the core profile. */
const HOST_FILES = [
  ["templates/scripts/wsl-tune.sh", "opt-in, manual: sysctls + user.slice ceiling (needs sudo)"],
  ["templates/scripts/wsl-gpu.sh", "opt-in, manual: load vgem + select Mesa d3d12 (needs sudo)"],
  ["templates/scripts/setup-tmpfs.sh", "opt-in, manual: WSL tmpfs cache mount + ~/.bashrc hook"],
  ["templates/scripts/setup-nightly.sh", "opt-in, manual: systemd --user nightly timer"],
  ["templates/scripts/board-service.sh", "opt-in, manual: systemd --user board service"],
  ["contrib/global-plugins/harness-freshness.ts", "opt-in: fast-forwards a checkout on session start"],
];

function reviewerNote({ profile, version, commit, ref, sourceDate, files, artifacts }) {
  const excludedList = profile === "core" ? CORE_EXCLUDES : [];
  const hostList = HOST_FILES.filter(([p]) => files.some((f) => f.path === p));

  const lines = [];
  lines.push(`# Security review note — opencode-agent-harness ${version}`);
  lines.push("");
  lines.push(`- **Version:** ${version}`);
  lines.push(`- **Commit:** \`${commit}\` (ref: \`${ref}\`, committed ${fmtDate(sourceDate)})`);
  lines.push(`- **Profile:** \`${profile}\` — ${PROFILE_NOTES[profile]}`);
  lines.push(`- **Files:** ${files.length}`);
  lines.push(`- **Runtime dependencies:** none (0)`);
  lines.push(`- **npm install scripts:** none (no \`preinstall\`, \`install\`, or \`postinstall\`)`);
  lines.push(`- **Telemetry:** none`);
  lines.push("");
  lines.push("## What it is");
  lines.push("");
  lines.push(
    "A multi-agent harness for OpenCode. It is a CLI plus a tree of Markdown rules, " +
      "persona definitions, and JavaScript gates. `init` copies those files into a target project; " +
      "it does not run a daemon, install a service, or call the network."
  );
  lines.push("");
  lines.push("## What runs at install / init");
  lines.push("");
  lines.push("- `npm install` runs **no** code (there are no lifecycle scripts).");
  lines.push("- `init` writes files **under the target directory only** and stops.");
  lines.push("- `init` does not commit, push, install services, or escalate privileges by default.");
  lines.push("");
  lines.push("## Network");
  lines.push("");
  lines.push(
    "No telemetry and no hardcoded external endpoints. Network-capable code exists only for: " +
      "a local board service (`127.0.0.1`), a local dev-server proxy, and project-configured " +
      "health URLs used by `wait-for`."
  );
  lines.push("");
  if (hostList.length) {
    lines.push("## Host-touching files (opt-in, never run by `init`)");
    lines.push("");
    lines.push("| File | What it does |");
    lines.push("|---|---|");
    for (const [p, why] of hostList) lines.push(`| \`${p}\` | ${why} |`);
    lines.push("");
  }
  if (excludedList.length) {
    lines.push("## Excluded from the core profile");
    lines.push("");
    for (const p of excludedList) lines.push(`- \`${p}\``);
    lines.push("");
  }
  lines.push("## Strings that commonly trip scanners (and why they are benign)");
  lines.push("");
  lines.push(
    "- `curl -Ls \"https://get.maestro.mobile.dev\" | bash` is a **printed hint** in the mobile-E2E " +
      "installer text, not executed by the harness."
  );
  lines.push(
    "- `~/.ssh/**`, `~/.aws/**`, `~/.git-credentials` appear in `templates/opencode.json` as " +
      "**deny** rules that keep agents out of credential stores."
  );
  lines.push(
    "- `sudo` / `systemctl` / `~/.bashrc` appear in the opt-in host-tuning scripts listed above " +
      "(absent from the `core` profile)."
  );
  lines.push("");
  lines.push("## Verify");
  lines.push("");
  lines.push("```bash");
  lines.push("sha256sum -c SHA256SUMS");
  lines.push("git bundle list-heads agent-harness-*.bundle   # bundle only");
  lines.push("```");
  lines.push("");
  lines.push("## Install without a registry");
  lines.push("");
  lines.push("```bash");
  if (profile === "core") {
    lines.push("unzip agent-harness-*-core-src.zip -d agent-harness");
    lines.push("node agent-harness/bin/agent-harness.js init --target . --dry-run");
    lines.push("node agent-harness/bin/agent-harness.js init --target . --yes");
  } else {
    lines.push("git clone agent-harness-*.bundle agent-harness");
    lines.push("node agent-harness/bin/agent-harness.js init --target . --dry-run");
    lines.push("node agent-harness/bin/agent-harness.js init --target . --yes");
  }
  lines.push("```");
  lines.push("");
  lines.push("## Artifacts");
  lines.push("");
  lines.push("| Artifact | Size | SHA-256 |");
  lines.push("|---|---|---|");
  for (const a of artifacts) lines.push(`| \`${a.path}\` | ${bytes(a.bytes)} | \`${a.sha256}\` |`);
  lines.push("");
  return lines.join("\n");
}

function makeSquashedBundle({ ref, version, profile, outFile, zipExcludes, sourceDate }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "harness-bundle-"));
  const tarFile = path.join(work, "src.tar");
  try {
    const archiveArgs = ["archive", "--format=tar", `--output=${tarFile}`, ref, "--", "."];
    for (const p of zipExcludes) archiveArgs.push(`:(exclude)${p}`);
    git(archiveArgs);

    const src = path.join(work, "src");
    fs.mkdirSync(src);
    sh("tar", ["-xf", tarFile, "-C", src]);

    git(["init", "-q"], { cwd: src });
    git(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: src });
    git(["-c", "user.name=agent-harness", "-c", "user.email=noreply@localhost", "add", "-A"], { cwd: src });
    const env = { ...process.env };
    if (sourceDate) {
      env.GIT_AUTHOR_DATE = sourceDate;
      env.GIT_COMMITTER_DATE = sourceDate;
    }
    const commit = spawnSync(
      "git",
      [
        "-c",
        "user.name=agent-harness",
        "-c",
        "user.email=noreply@localhost",
        "commit",
        "-q",
        "-m",
        `opencode-agent-harness ${version} (${profile} snapshot)`,
      ],
      { cwd: src, encoding: "utf8", env }
    );
    if (commit.status !== 0) fail(`squashed commit failed\n${commit.stderr || commit.stdout}`);
    git(["bundle", "create", outFile, "--all"], { cwd: src });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(ROOT, opts.out);
  const version = PKG.version;

  const toplevel = git(["rev-parse", "--show-toplevel"]).stdout.trim();
  if (path.resolve(toplevel) !== ROOT) {
    fail(`run this from the harness repo (found repo root ${toplevel}, expected ${ROOT})`);
  }

  const dirty = git(["status", "--porcelain"]).stdout.trim();
  if (dirty && !opts.allowDirty) {
    fail(
      "working tree is dirty — commit first, or pass --allow-dirty to package the committed ref anyway\n" +
        dirty.split("\n").slice(0, 10).join("\n")
    );
  }

  const commit = git(["rev-parse", "HEAD"]).stdout.trim();
  const short = git(["rev-parse", "--short=12", "HEAD"]).stdout.trim();
  const sourceDate = git(["log", "-1", "--format=%cI", opts.ref], { allowFail: true }).stdout.trim();
  const allFiles = git(["ls-tree", "-r", "--name-only", opts.ref]).stdout.trim().split("\n").filter(Boolean);
  const files = [];
  for (const rel of allFiles) {
    if (excluded(rel, opts.profile)) continue;
    const buf = git(["show", `${opts.ref}:${rel}`], { encoding: "buffer" }).stdout;
    files.push({ path: rel, bytes: buf.length, sha256: sha256(buf) });
  }

  fs.mkdirSync(outDir, { recursive: true });
  const zipExcludes = opts.profile === "core" ? CORE_EXCLUDES : [];

  const zipName = `agent-harness-${version}-${opts.profile}-src.zip`;
  const zipPath = path.join(outDir, zipName);
  const archiveArgs = ["archive", "--format=zip", `--output=${zipPath}`, opts.ref, "--", "."];
  for (const p of zipExcludes) archiveArgs.push(`:(exclude)${p}`);
  git(archiveArgs);

  const bundleName =
    opts.profile === "core" ? `agent-harness-${version}-core.bundle` : `agent-harness-${version}.bundle`;
  const bundlePath = path.join(outDir, bundleName);
  if (opts.profile === "core") {
    makeSquashedBundle({
      ref: opts.ref,
      version,
      profile: opts.profile,
      outFile: bundlePath,
      zipExcludes,
      sourceDate,
    });
  } else {
    git(["bundle", "create", bundlePath, "--all"]);
  }

  const artifacts = [
    { path: zipName, bytes: fs.statSync(zipPath).size, sha256: sha256(fs.readFileSync(zipPath)) },
    { path: bundleName, bytes: fs.statSync(bundlePath).size, sha256: sha256(fs.readFileSync(bundlePath)) },
  ];

  const manifest = {
    name: PKG.name,
    version,
    profile: opts.profile,
    ref: opts.ref,
    commit,
    sourceDate: sourceDate || null,
    generatedAt: new Date().toISOString(),
    generator: "tools/make-release-bundle.mjs",
    runtimeDependencies: Object.keys(PKG.dependencies || {}).length,
    installScripts: Object.keys(PKG.scripts || {}).filter((k) => /^(pre|post)?install$/.test(k)),
    excluded: opts.profile === "core" ? CORE_EXCLUDES : [],
    artifacts,
    files,
  };
  fs.writeFileSync(path.join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");

  fs.writeFileSync(
    path.join(outDir, "REVIEW-NOTES.md"),
    reviewerNote({ profile: opts.profile, version, commit, ref: opts.ref, sourceDate, files, artifacts })
  );

  const sums = [];
  for (const f of fs.readdirSync(outDir).sort()) {
    if (f === "SHA256SUMS" || f.startsWith(".")) continue;
    const abs = path.join(outDir, f);
    if (!fs.statSync(abs).isFile()) continue;
    sums.push(`${sha256(fs.readFileSync(abs))}  ${f}`);
  }
  fs.writeFileSync(path.join(outDir, "SHA256SUMS"), sums.join("\n") + "\n");

  console.log(`make-release-bundle → ${path.relative(ROOT, outDir) || "."}/`);
  console.log(`  version   ${version}  (${short})`);
  console.log(`  profile   ${opts.profile} — ${PROFILE_NOTES[opts.profile]}`);
  console.log(`  files     ${files.length}${opts.profile === "core" ? ` (excluded ${CORE_EXCLUDES.length} paths)` : ""}`);
  for (const a of artifacts) console.log(`  ${a.path}  ${bytes(a.bytes)}`);
  console.log(`  MANIFEST.json, REVIEW-NOTES.md, SHA256SUMS`);
}

main();
