#!/usr/bin/env node
"use strict";
/*
 * apk-cache — cut the device-tier bring-up time by reusing the parts of the
 * release APK that do not change between feature worktrees.
 *
 * The device tier's cost is dominated by a cold `./gradlew assembleRelease`
 * (the reanimated/worklets/screens C++ compile, codegen, dex merge, and the
 * Hermes JS bundle). Almost all of that is invariant across worktrees for a
 * fixed dependency/toolchain set; only the JS bundle changes per feature. This
 * module content-addresses each stage so the invariant work is done once:
 *
 *   native/<nativeKey>/base.apk        the native shell (ignores JS)
 *   bundle/<bundleKey>/                the Hermes bundle + exported assets
 *   apk/<fullKey>/app-release.apk      a ready-to-install APK
 *
 * `nativeKey` hashes the dependency/toolchain inputs only (package-lock,
 * patches, app.json, the generated android gradle files, ABIs, build-apk.sh).
 * `bundleKey` hashes the JS/resource sources + the baked API URL. `fullKey` is
 * both, so an unchanged worktree is an instant cache hit.
 *
 * CLI (all paths printed on stdout, diagnostics on stderr):
 *   apk-cache.js key [--json]     print fullKey (or {native,bundle,full})
 *   apk-cache.js get              print a cached final APK path (exit 1 if none)
 *   apk-cache.js put <apk>        store <apk> under fullKey
 *   apk-cache.js base-get         print a cached native base APK (exit 1 if none)
 *   apk-cache.js base-put <apk>   store <apk> as the native base
 *   apk-cache.js overlay          base + fresh bundle -> final APK (exit 2 if it
 *                                 cannot safely overlay; caller does a full build)
 *   apk-cache.js status           human-readable cache state
 *
 * `overlay` NEVER touches resources.arsc or the compiled res/: it replaces only
 * `assets/index.android.bundle`, and only when every exported asset name is
 * already present in the base APK's resource table (a feature that adds a new
 * static image falls back to a full Gradle build). It re-signs with the app's
 * debug keystore and verifies the result; any doubt -> a non-zero exit so the
 * caller builds normally. It is a pure accelerator: correctness never depends
 * on it.
 *
 * Env:
 *   MOBILE_E2E_CACHE_DIR    cache root (default ~/.cache/agent-harness/mobile-e2e)
 *   MOBILE_E2E_ABI          ABI built      (default x86_64)
 *   MOBILE_E2E_API_URL      baked dev API  (default http://10.0.2.2:3000)
 *   MOBILE_E2E_APK          APK path       (default conventional Gradle output)
 *   ANDROID_HOME            Android SDK root (default ~/android-sdk)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const MOBILE = path.join(ROOT, "mobile");
const ANDROID = path.join(MOBILE, "android");
const SDK = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "android-sdk");
const ABI = process.env.MOBILE_E2E_ABI || "x86_64";
const API_URL = process.env.MOBILE_E2E_API_URL || "http://10.0.2.2:3000";
const CACHE = process.env.MOBILE_E2E_CACHE_DIR || path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "agent-harness", "mobile-e2e"
);

const SKIP_DIRS = new Set(["node_modules", ".git", ".expo", "android", "ios", "build", ".cxx", "tmp", ".gradle"]);
const ANCHOR_FILES = [
  "package.json",
  "package-lock.json",
  "app.json",
  "babel.config.js",
  "metro.config.js",
  "tailwind.config.js",
  "global.css",
  "tsconfig.json",
  "android/gradle.properties",
  "android/build.gradle",
  "android/settings.gradle",
  "android/gradle/wrapper/gradle-wrapper.properties",
  "android/app/build.gradle",
  "android/app/src/main/AndroidManifest.xml",
];
const NATIVE_TREES = ["patches"];
const JS_TREES = ["app", "components", "lib", "assets"];

function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function sha256File(p) { try { return sha256(fs.readFileSync(p)); } catch (_) { return ""; } }

function walkFiles(dir, base) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...walkFiles(path.join(dir, entry.name), base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, path.join(dir, entry.name)).split(path.sep).join("/"));
    }
  }
  return out;
}

function hashTree(dirs, base) {
  const files = [];
  for (const d of dirs) files.push(...walkFiles(path.join(base, d), base));
  files.sort();
  const h = crypto.createHash("sha256");
  for (const rel of files) {
    h.update(rel); h.update("\0"); h.update(fs.readFileSync(path.join(base, rel))); h.update("\0");
  }
  return h.digest("hex");
}

function fileMap(rels, base) {
  const out = {};
  for (const rel of rels) {
    const p = path.join(base, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) out[rel] = sha256File(p);
  }
  return out;
}

function depsDigest(pkgPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const pick = (o) => Object.keys(o || {}).sort().map((k) => `${k}@${o[k]}`).join(",");
    return sha256(`${pick(pkg.dependencies)}|${pick(pkg.devDependencies)}`);
  } catch (_) { return ""; }
}

function nativeKey() {
  const manifest = {
    v: 1,
    abi: ABI,
    deps: depsDigest(path.join(MOBILE, "package.json")),
    trees: hashTree(NATIVE_TREES, MOBILE),
    files: fileMap(ANCHOR_FILES, MOBILE),
    buildScript: sha256File(path.join(__dirname, "build-apk.sh")),
  };
  return sha256(JSON.stringify(manifest));
}

function bundleKey() {
  const manifest = {
    // v2: v1 entries could hold a bundle whose URL did not match `apiUrl` (a
    // stale Gradle createBundleReleaseJsAndAssets output; F-331). Invalidated
    // so a poisoned cache entry is never reused.
    v: 2,
    apiUrl: API_URL,
    entry: 1, // bump when the entry resolution changes
    trees: hashTree(JS_TREES, MOBILE),
    files: fileMap(ANCHOR_FILES, MOBILE),
    deps: depsDigest(path.join(MOBILE, "package.json")),
  };
  return sha256(JSON.stringify(manifest));
}

function fullKey() { return sha256(`${nativeKey()}\n${bundleKey()}`); }

function dirs() {
  return {
    finalDir: path.join(CACHE, "apk", fullKey()),
    nativeDir: path.join(CACHE, "native", nativeKey()),
    bundleDir: path.join(CACHE, "bundle", bundleKey()),
  };
}

function finalApkPath() { return path.join(dirs().finalDir, "app-release.apk"); }
function baseApkPath() { return path.join(dirs().nativeDir, "base.apk"); }

function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }

function atomicCopy(src, dest) {
  mkdirp(path.dirname(dest));
  const tmp = `${dest}.tmp-${process.pid}`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dest);
}

function tool(bin) {
  for (const root of [path.join(SDK, "build-tools")]) {
    if (!fs.existsSync(root)) continue;
    for (const v of fs.readdirSync(root).sort().reverse()) {
      const p = path.join(root, v, bin);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }, opts));
  if (r.error) return { ok: false, out: "", err: r.error.message, status: -1 };
  return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "", status: r.status };
}

function resolveEntry() {
  const r = sh(process.execPath, ["-e", "require('expo/scripts/resolveAppEntry')", MOBILE, "android", "absolute"], { cwd: MOBILE });
  const entry = (r.out || "").trim().split("\n").pop();
  return r.ok && entry ? entry : null;
}

function expoCli() {
  const bin = path.join(MOBILE, "node_modules", ".bin", "expo");
  return fs.existsSync(bin) ? bin : null;
}

/* Build the Hermes bundle for the current JS into bundle/<key>/ (atomic). */
function ensureBundle() {
  const dir = dirs().bundleDir;
  const bundled = path.join(dir, "assets", "index.android.bundle");
  if (fs.existsSync(bundled)) return { ok: true, dir };
  const entry = resolveEntry();
  if (!entry) return { ok: false, err: "could not resolve the app entry" };
  const expo = expoCli();
  if (!expo) return { ok: false, err: "no node_modules/.bin/expo" };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-e2e-bundle-"));
  mkdirp(path.join(tmp, "assets"));
  const args = [
    "export:embed",
    "--platform", "android",
    "--dev", "false",
    "--entry-file", entry,
    "--bundle-output", path.join(tmp, "assets", "index.android.bundle"),
    "--assets-dest", tmp,
  ];
  const env = Object.assign({}, process.env, { EXPO_PUBLIC_API_URL: API_URL });
  // Run Metro through `serve.js run` so the bundle is capped in a cgroup and
  // obeys the machine-wide envelope (it classifies as an "apk build" one-shot).
  // Metro is much smaller than Gradle, but a prewarm must never contend with a
  // live heavy tier; serve.js refuses it there instead.
  const serve = path.join(ROOT, "scripts", "serve.js");
  const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const r = fs.existsSync(serve)
    ? sh(process.execPath, [serve, "run", "--name", "apk-bundle", "--mem-max", "2G", "--cmd", [expo, ...args].map(shq).join(" ")], { cwd: MOBILE, env })
    : sh(expo, args, { cwd: MOBILE, env });
  if (!r.ok || !fs.existsSync(path.join(tmp, "assets", "index.android.bundle"))) {
    return { ok: false, err: `expo export:embed failed: ${(r.err || "").slice(-400)}` };
  }
  mkdirp(path.dirname(dir));
  const staging = `${dir}.tmp-${process.pid}`;
  fs.renameSync(tmp, staging);
  fs.renameSync(staging, dir);
  return { ok: true, dir };
}

/* Resource names present in an APK's resource table (aapt2). */
function apkResourceNames(apk) {
  const aapt2 = tool("aapt2");
  if (!aapt2) return null;
  const r = sh(aapt2, ["dump", "resources", apk]);
  if (!r.ok) return null;
  const names = new Set();
  for (const m of r.out.matchAll(/(?:drawable|raw)\/([A-Za-z0-9_.]+)/g)) names.add(m[1]);
  return names;
}

/* Resource names the freshly exported bundle will reference: derive from the
 * staged export asset file names (aapt2 lowercases and replaces non-alnum). */
function stagedResourceNames(bundleDir) {
  const names = new Set();
  if (!fs.existsSync(bundleDir)) return names;
  for (const d of fs.readdirSync(bundleDir)) {
    if (!/^(drawable|raw)/.test(d)) continue;
    const full = path.join(bundleDir, d);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      names.add(f.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9_]/g, "_"));
    }
  }
  return names;
}

/* Rewrite the APK replacing assets/index.android.bundle only, via python3's
 * zipfile (no `zip` dependency; preserves every other entry's compression). */
const PY_REWRITE = `
import sys, os, zipfile
base, stage, out, repl = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
repl = set(repl.split(",")) if repl else set()
replacements = {}
for root, _, files in os.walk(stage):
    for f in files:
        p = os.path.join(root, f)
        rel = os.path.relpath(p, stage).replace(os.sep, "/")
        if rel in repl:
            replacements[rel] = p
zin = zipfile.ZipFile(base, "r")
zout = zipfile.ZipFile(out, "w")
for item in zin.infolist():
    n = item.filename
    if n.startswith("META-INF/") and (n.endswith(".RSA") or n.endswith(".SF") or n.endswith(".MF") or n.endswith(".EC")):
        continue
    if n in replacements:
        data = open(replacements[n], "rb").read()
        zi = zipfile.ZipInfo(n, date_time=item.date_time)
        zi.compress_type = item.compress_type
        zi.external_attr = item.external_attr
        zout.writestr(zi, data)
    else:
        zout.writestr(item, zin.read(n))
zin.close(); zout.close()
`;

function overlay() {
  const base = baseApkPath();
  if (!fs.existsSync(base)) return { ok: false, err: "no native base cached yet" };
  const b = ensureBundle();
  if (!b.ok) return { ok: false, err: b.err };

  const baseNames = apkResourceNames(base);
  if (!baseNames) return { ok: false, err: "aapt2 unavailable — cannot verify resource compatibility" };
  const staged = stagedResourceNames(b.dir);
  for (const n of staged) {
    if (!baseNames.has(n)) return { ok: false, err: `new boot asset "${n}" not in the native base — full build needed` };
  }

  const python = sh("python3", ["-c", "import zipfile"]).ok ? "python3" : null;
  if (!python) return { ok: false, err: "python3/zipfile unavailable — cannot rewrite the APK safely" };
  const zipalign = tool("zipalign");
  const apksigner = tool("apksigner");
  const keystore = path.join(ANDROID, "app", "debug.keystore");
  if (!zipalign || !apksigner || !fs.existsSync(keystore)) return { ok: false, err: "zipalign/apksigner/keystore unavailable" };

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "agent-e2e-overlay-"));
  const unsigned = path.join(work, "unsigned.apk");
  const aligned = path.join(work, "aligned.apk");
  const signed = path.join(work, "signed.apk");
  const rewrite = sh(python, ["-c", PY_REWRITE, base, b.dir, unsigned, "assets/index.android.bundle"]);
  if (!rewrite.ok) return { ok: false, err: `apk rewrite failed: ${rewrite.err.slice(-300)}` };
  const al = sh(zipalign, ["-f", "-p", "4", unsigned, aligned]);
  if (!al.ok) return { ok: false, err: `zipalign failed: ${al.err.slice(-300)}` };
  const sgn = sh(apksigner, [
    "sign", "--ks", keystore, "--ks-pass", "pass:android", "--key-pass", "pass:android",
    "--ks-key-alias", "androiddebugkey", "--out", signed, aligned,
  ]);
  if (!sgn.ok) return { ok: false, err: `apksigner failed: ${sgn.err.slice(-300)}` };
  if (!sh(apksigner, ["verify", "--print-certs", signed]).ok) return { ok: false, err: "apksigner verify failed" };
  if (sh(apksigner, ["verify", signed]).status !== 0) return { ok: false, err: "apksigner verify failed" };

  atomicCopy(signed, finalApkPath());
  return { ok: true, path: finalApkPath() };
}

function cmdKey(args) {
  const k = { native: nativeKey(), bundle: bundleKey() };
  k.full = sha256(`${k.native}\n${k.bundle}`);
  if (args.includes("--json")) console.log(JSON.stringify(k, null, 2));
  else console.log(k.full);
}

function cmdGet() {
  const p = finalApkPath();
  if (fs.existsSync(p)) { console.log(p); return 0; }
  return 1;
}

function cmdBaseGet() {
  const p = baseApkPath();
  if (fs.existsSync(p)) { console.log(p); return 0; }
  return 1;
}

function store(src, dest, extra) {
  atomicCopy(src, dest);
  const meta = Object.assign({ storedAt: new Date().toISOString(), bytes: fs.statSync(dest).size }, extra || {});
  fs.writeFileSync(path.join(path.dirname(dest), "meta.json"), JSON.stringify(meta, null, 2));
  return dest;
}

function cmdPut(args) {
  const src = args[0];
  if (!src || !fs.existsSync(src)) { console.error("apk-cache put: no such APK:", src); return 2; }
  console.log(store(src, finalApkPath()));
  return 0;
}

function cmdBasePut(args) {
  const src = args[0];
  if (!src || !fs.existsSync(src)) { console.error("apk-cache base-put: no such APK:", src); return 2; }
  const names = apkResourceNames(src);
  console.log(store(src, baseApkPath(), names ? { resourceNames: [...names].sort() } : {}));
  return 0;
}

function cmdOverlay() {
  const r = overlay();
  if (!r.ok) { console.error(`apk-cache overlay: ${r.err}`); return 2; }
  console.log(r.path);
  return 0;
}

function cmdStatus() {
  const k = { native: nativeKey(), bundle: bundleKey() };
  console.log(JSON.stringify({
    key: k,
    cached: {
      final: fs.existsSync(finalApkPath()),
      nativeBase: fs.existsSync(baseApkPath()),
      bundle: fs.existsSync(path.join(dirs().bundleDir, "assets", "index.android.bundle")),
    },
    cache: CACHE,
  }, null, 2));
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  let code = 0;
  switch (cmd) {
    case "key": cmdKey(args); break;
    case "get": code = cmdGet(); break;
    case "put": code = cmdPut(args); break;
    case "base-get": code = cmdBaseGet(); break;
    case "base-put": code = cmdBasePut(args); break;
    case "overlay": code = cmdOverlay(); break;
    case "status": cmdStatus(); break;
    default:
      console.error("usage: apk-cache.js <key|get|put|base-get|base-put|overlay|status> [apk] [--json]");
      code = 2;
  }
  process.exit(code);
}

if (require.main === module) main();

module.exports = { nativeKey, bundleKey, fullKey, hashTree, walkFiles, dirs, finalApkPath, baseApkPath };
