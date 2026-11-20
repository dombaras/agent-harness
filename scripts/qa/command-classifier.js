#!/usr/bin/env node
"use strict";
/*
 * command-classifier — decide whether a shell command will launch a
 * memory-heavy process, and whether that process is LONG-LIVED (holds RAM for
 * its whole lifetime) or a ONE-SHOT (spikes and releases).
 *
 * Why a real analyzer instead of a regex over the raw string: a substring match
 * reads arguments and paths as if they were the program. `adb -s emulator-5554
 * shell uiautomator dump` and `python3 - <<EOF … "~/.maestro/…"` are read-only
 * diagnostics, but `/emulator\b/` and `/maestro\b/i` labelled them as launching
 * an emulator and Maestro — which blocked them whenever the device tier was up
 * (the F-311 dead end). So this module:
 *   1. tokenizes the shell (quotes, escapes, operators, redirections, heredocs,
 *      command substitution),
 *   2. resolves each simple command's PROGRAM — peeling `VAR=x` assignments and
 *      wrappers (`env`, `sudo`, `nohup`, `timeout`, `systemd-run`, …) and
 *      resolving interpreters (`bash|sh|node|python … <script>`) and
 *      multiplexers (`npm/yarn/pnpm … run <script>`, `npx <pkg>`),
 *   3. matches ONLY the program / subcommand / script basename against the rule
 *      table, and
 *   4. recurses into embedded payloads (`--cmd "…"`, `sh -c "…"`).
 *
 * Paths, device serials, and heredoc bodies can never be mistaken for a heavy
 * program, and `echo "npm run dev"` / a commit message mentioning "emulator"
 * stay quiet.
 *
 * Pure: string in, findings out, never throws.
 */

/* Heavy labels that are LONG-LIVED tiers: they hold RAM for their whole
 * lifetime and must not run two at once (emulator + `next dev` + a third dev
 * server). Everything else heavy (a build, a test tier, `maestro`) is a
 * ONE-SHOT: it spikes RAM but releases it, so it is legitimate to run while a
 * live tier is up (the live-tier test pattern) and must NOT be counted as an
 * extra concurrent tier. */
const LONG_LIVED = new Set([
  "emulator",
  "next dev",
  "metro",
  "vite",
  "bundler",
  "dev server",
  "docker",
]);

/* Programs that prepend another command; the real program is resolved past
 * them. `systemd-run`/`timeout` need bespoke skipping (see skipWrapper). */
const WRAPPERS = new Set([
  "env",
  "sudo",
  "nohup",
  "time",
  "command",
  "exec",
  "stdbuf",
  "nice",
  "ionice",
  "setsid",
  "timeout",
  "xargs",
  "systemd-run",
]);

/* Wrapper options that consume the following token (so it is not mistaken for
 * the program). */
const WRAPPER_OPTS_WITH_ARG = {
  sudo: [
    "-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
    "-C", "--close-from", "-r", "--role", "-t", "--type", "-T",
    "--command-timeout", "-U", "--other-user", "-D", "--chdir",
  ],
  env: ["-u", "--unset", "-S", "--split-string", "-C", "--chdir"],
  stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  ionice: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"],
  timeout: ["-k", "--kill-after", "-s", "--signal"],
  nice: ["-n", "--adjustment"],
};

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"]);
const NODEISH = new Set(["node", "nodejs", "deno"]);
const PYISH = new Set(["python", "python3", "python2", "ruby", "perl", "php"]);

/* Script basenames and npm/yarn/pnpm script names -> [label, longLived]. These
 * are the harness-owned mobile-e2e wrappers and the project test/dev scripts. */
const SCRIPT_RULES = {
  dev: ["dev server", true],
  develop: ["dev server", true],
  "start:dev": ["dev server", true],
  "test:quick": ["heavy test tier", false],
  "test:api": ["heavy test tier", false],
  "test:verify": ["heavy test tier", false],
  "test:e2e": ["heavy test tier", false],
  "test:mobile": ["heavy test tier", false],
  "test:data": ["heavy test tier", false],
  "test:integration": ["heavy test tier", false],
  "build-dev-apk.sh": ["apk build", false],
  "build-apk.sh": ["apk build", false],
  "prewarm.sh": ["apk build", false],
  "boot-emulator.sh": ["emulator", true],
  "device-up.sh": ["emulator", true],
  "run-maestro.js": ["maestro", false],
  "run-maestro.sh": ["maestro", false],
  "run-detached.sh": ["maestro", false],
};

function finding(label, longLived, evidence) {
  return { label, longLived, evidence };
}

function baseName(token) {
  let t = String(token == null ? "" : token).replace(/["'`]/g, "");
  t = t.replace(/\\/g, "/");
  const parts = t.split("/");
  let b = parts[parts.length - 1] || t;
  return b.replace(/\.exe$/i, "");
}

/* ---------------------------------------------------------------- tokenizer
 * Split a shell command into simple commands (`;`, `&&`, `||`, `|`, `&`,
 * newlines, subshell parens separate). Quoting, escaping, and redirections are
 * honoured; heredoc bodies and command substitutions are NOT scanned as shell
 * (their content can never label the command). Returns an array of segments,
 * each an array of word strings. */
function tokenize(input) {
  const s = String(input == null ? "" : input);
  const segments = [];
  let words = [];
  let cur = "";
  let has = false;
  let i = 0;
  const n = s.length;
  const pending = []; // heredoc delimiters awaiting their bodies

  const flushWord = () => {
    if (has) {
      words.push(cur);
      cur = "";
      has = false;
    }
  };
  const flushSegment = () => {
    flushWord();
    if (words.length) segments.push(words);
    words = [];
  };
  const skipHeredoc = (h) => {
    let done = false;
    while (i < n) {
      let eol = s.indexOf("\n", i);
      if (eol === -1) eol = n;
      const line = s.slice(i, eol);
      const test = h.stripTabs ? line.replace(/^\t+/, "") : line;
      i = eol < n ? eol + 1 : n;
      if (test === h.delim) {
        done = true;
        break;
      }
    }
    return done;
  };

  while (i < n) {
    const c = s[i];

    if (c === "\n") {
      i += 1;
      while (pending.length) {
        const h = pending.shift();
        if (!skipHeredoc(h)) break;
      }
      flushSegment();
      continue;
    }
    if (c === "#" && !has) {
      while (i < n && s[i] !== "\n") i += 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      flushWord();
      i += 1;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      flushWord();
      flushSegment();
      i += 1;
      continue;
    }
    if (c === "<" || c === ">") {
      if (has && /^\d+$/.test(cur)) {
        cur = "";
        has = false;
      }
      flushWord();
      let op = c;
      i += 1;
      if (s[i] === c) {
        op += c;
        i += 1;
      }
      if (s[i] === "&") {
        op += "&";
        i += 1;
      }
      if (op === "<<" || op === "<<-") {
        const stripTabs = op === "<<-";
        while (i < n && (s[i] === " " || s[i] === "\t")) i += 1;
        let delim = "";
        if (s[i] === '"' || s[i] === "'") {
          const q = s[i];
          i += 1;
          while (i < n && s[i] !== q) {
            delim += s[i];
            i += 1;
          }
          if (s[i] === q) i += 1;
        } else {
          while (i < n && !/[\s;&|<>()]/.test(s[i])) {
            delim += s[i];
            i += 1;
          }
        }
        pending.push({ delim, stripTabs });
        continue;
      }
      // Ordinary redirection: drop the target word.
      while (i < n && (s[i] === " " || s[i] === "\t")) i += 1;
      while (i < n && !/[\s;&|<>()]/.test(s[i])) {
        if (s[i] === '"' || s[i] === "'") {
          const q = s[i];
          i += 1;
          while (i < n && s[i] !== q) i += 1;
          if (s[i] === q) i += 1;
        } else {
          i += 1;
        }
      }
      continue;
    }
    if (c === "$" && s[i + 1] === "(") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (s[i] === "(") depth += 1;
        else if (s[i] === ")") depth -= 1;
        i += 1;
      }
      cur += " ";
      has = true;
      continue;
    }
    if (c === "`") {
      i += 1;
      while (i < n && s[i] !== "`") i += 1;
      if (s[i] === "`") i += 1;
      cur += " ";
      has = true;
      continue;
    }
    if (c === "'") {
      i += 1;
      has = true;
      while (i < n && s[i] !== "'") {
        cur += s[i];
        i += 1;
      }
      if (s[i] === "'") i += 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      has = true;
      while (i < n && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < n && /["\\$`]/.test(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        if (s[i] === "$" && s[i + 1] === "(") {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (s[i] === "(") depth += 1;
            else if (s[i] === ")") depth -= 1;
            i += 1;
          }
          cur += " ";
          continue;
        }
        cur += s[i];
        i += 1;
      }
      if (s[i] === '"') i += 1;
      continue;
    }
    if (c === "\\" && i + 1 < n) {
      cur += s[i + 1];
      has = true;
      i += 2;
      continue;
    }

    cur += c;
    has = true;
    i += 1;
  }

  flushSegment();
  return segments;
}

/* ------------------------------------------------------------- resolvers */
function firstNonFlag(args, from) {
  for (let i = from || 0; i < args.length; i += 1) {
    if (args[i] === "--") continue;
    if (!args[i].startsWith("-")) return { value: args[i], index: i };
  }
  return null;
}

function skipWrapper(program, words, idx) {
  let i = idx + 1;
  const argOpts = WRAPPER_OPTS_WITH_ARG[program] || [];
  if (program === "systemd-run") {
    while (i < words.length && words[i] !== "--") {
      if (!words[i].startsWith("-")) break;
      i += 1;
    }
    if (words[i] === "--") i += 1;
    return i;
  }
  if (program === "timeout") {
    while (i < words.length && words[i].startsWith("-")) {
      i += argOpts.includes(words[i]) ? 2 : 1;
    }
    if (i < words.length) i += 1; // the duration
    return i;
  }
  while (i < words.length) {
    const w = words[i];
    if (argOpts.includes(w)) {
      i += 2;
      continue;
    }
    if (w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

/* The real program token of a simple command: assignments stripped, wrappers
 * peeled. Returns `{ program, args }` or null. */
function resolveProgram(words) {
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1;
  while (i < words.length) {
    const p = baseName(words[i]).toLowerCase();
    if (WRAPPERS.has(p)) {
      i = skipWrapper(p, words, i);
      continue;
    }
    break;
  }
  if (i >= words.length) return null;
  const program = baseName(words[i]).toLowerCase();
  if (!program) return null;
  return { program, args: words.slice(i + 1) };
}

function classifyRunner(program, args) {
  const sub = firstNonFlag(args);
  if (!sub) return null;
  if (program === "npx" || program === "bunx") {
    return classifyProgram(baseName(sub.value).toLowerCase(), args.slice(sub.index + 1));
  }
  if (sub.value === "run" || sub.value === "run-script") {
    const script = firstNonFlag(args, sub.index + 1);
    if (!script) return null;
    const r = SCRIPT_RULES[script.value];
    return r ? finding(r[0], r[1], `npm script ${script.value}`) : null;
  }
  if (sub.value === "exec" || sub.value === "x" || sub.value === "dlx") {
    const pkg = firstNonFlag(args, sub.index + 1);
    if (!pkg) return null;
    return classifyProgram(baseName(pkg.value).toLowerCase(), args.slice(pkg.index + 1));
  }
  const r = SCRIPT_RULES[sub.value];
  return r ? finding(r[0], r[1], `script ${sub.value}`) : null;
}

function classifyInterpreter(program, args) {
  if ((NODEISH.has(program) || PYISH.has(program)) && args.some((a) => ["-e", "--eval", "-p", "--print", "-c"].includes(a))) {
    return null; // inline code is opaque
  }
  const script = firstNonFlag(args);
  if (!script) return null;
  const r = SCRIPT_RULES[baseName(script.value).toLowerCase()];
  return r ? finding(r[0], r[1], `script ${baseName(script.value)}`) : null;
}

function classifyProgram(program, args) {
  const ev = (detail) => `program ${program}${detail ? ` ${detail}` : ""}`;
  if (/^qemu-system/.test(program)) return finding("emulator", true, ev());
  switch (program) {
    case "emulator":
      return finding("emulator", true, ev());
    case "maestro":
      return finding("maestro", false, ev());
    case "metro":
      return finding("metro", true, ev());
    case "webpack":
    case "turbopack":
      return finding("bundler", true, ev());
    case "xcodebuild":
      return finding("native build", false, ev());
    case "gradlew":
    case "gradle": {
      const task = args.find((a) => /assemble/i.test(a));
      return finding(task ? "apk build" : "native build", false, ev(task || ""));
    }
    case "next": {
      const s = firstNonFlag(args);
      return s && (s.value === "dev" || s.value === "start") ? finding("next dev", true, ev(s.value)) : null;
    }
    case "expo": {
      const s = firstNonFlag(args);
      if (!s) return null;
      if (s.value === "start") return finding("metro", true, ev(s.value));
      if (s.value === "prebuild" || s.value === "export") return finding("apk build", false, ev(s.value));
      return null;
    }
    case "react-native": {
      const s = firstNonFlag(args);
      if (!s) return null;
      if (s.value === "start") return finding("metro", true, ev(s.value));
      if (s.value === "build" || s.value === "run-android") return finding("apk build", false, ev(s.value));
      return null;
    }
    case "vite": {
      const s = firstNonFlag(args);
      return s && ["dev", "serve", "preview"].includes(s.value) ? finding("vite", true, ev(s.value)) : null;
    }
    case "docker": {
      const s = firstNonFlag(args);
      return s && ["build", "run", "compose"].includes(s.value) ? finding("docker", true, ev(s.value)) : null;
    }
    case "prisma": {
      const s = firstNonFlag(args);
      return s && (s.value === "migrate" || s.value === "generate") ? finding("build", false, ev(s.value)) : null;
    }
    case "turbo":
    case "nx": {
      const s = firstNonFlag(args);
      return s && (s.value === "run" || s.value === "build") ? finding("build", false, ev(s.value)) : null;
    }
    case "tsc":
      return args.includes("--build") || args.includes("-b") ? finding("build", false, ev("--build")) : null;
    case "npm":
    case "yarn":
    case "pnpm":
    case "bun":
    case "npx":
    case "bunx":
      return classifyRunner(program, args);
    default:
      if (SHELLS.has(program) || NODEISH.has(program) || PYISH.has(program)) return classifyInterpreter(program, args);
      return null;
  }
}

/* Analyze ONE simple command (already tokenized words) into findings, including
 * any `--cmd` payload and `sh -c` body it embeds. */
function analyzeSegment(words) {
  const out = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w === "--cmd" && i + 1 < words.length) {
      for (const f of analyzeAll(words[i + 1])) out.push(f);
      i += 1;
    } else if (w.startsWith("--cmd=")) {
      for (const f of analyzeAll(w.slice("--cmd=".length))) out.push(f);
    }
  }
  const cmd = resolveProgram(words);
  if (cmd) {
    const f = classifyProgram(cmd.program, cmd.args);
    if (f) out.push(f);
    if (SHELLS.has(cmd.program)) {
      const ci = cmd.args.indexOf("-c");
      if (ci !== -1 && cmd.args[ci + 1]) for (const g of analyzeAll(cmd.args[ci + 1])) out.push(g);
    }
  }
  return out;
}

function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    if (!f || !f.label || seen.has(f.label)) continue;
    seen.add(f.label);
    out.push(f);
  }
  return out;
}

/* Every heavy finding in a command (may contain several segments/payloads). */
function analyzeAll(cmd) {
  const s = String(cmd == null ? "" : cmd);
  if (!s.trim()) return [];
  const out = [];
  for (const seg of tokenize(s)) {
    for (const f of analyzeSegment(seg)) out.push(f);
  }
  return dedupe(out);
}

/* The single most important finding: a long-lived tier dominates a one-shot. */
function analyzeCommand(cmd) {
  const all = analyzeAll(cmd);
  if (all.length === 0) return null;
  return all.find((f) => f.longLived) || all[0];
}

function classifyHeavy(cmd) {
  const f = analyzeCommand(cmd);
  return f ? f.label : null;
}

function isHeavyCommand(cmd) {
  return analyzeCommand(cmd) !== null;
}

function isLongLivedHeavy(cmd) {
  const f = analyzeCommand(cmd);
  return !!(f && f.longLived);
}

module.exports = {
  LONG_LIVED,
  SCRIPT_RULES,
  tokenize,
  analyzeAll,
  analyzeCommand,
  classifyHeavy,
  isHeavyCommand,
  isLongLivedHeavy,
};
