/* heal-playbook — parse and validate project-owned repair playbooks.
 *
 * Split out of heal-lib.js (P3 right-size). Playbooks are untrusted, project-
 * owned data: the parser is deliberately strict and dependency-free, and a
 * command is always argv, never a shell string. */
const crypto = require("node:crypto");

const PLAYBOOK_SCHEMA = "heal-playbook/1";
const PLAYBOOK_ACTIONS = ["retry", "rerun", "quarantine", "resync", "clear_cache", "restart_server", "rebase", "patch"];
const SHELL_META = /[;&|<>$`\n\r\0]/;

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

/* Split a tiny YAML frontmatter block (key: value, no nesting). An unreadable
 * playbook is a refusal, never a guessed command. */
function splitFrontmatter(text) {
  const src = String(text == null ? "" : text).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) throw new Error("playbook must start with a frontmatter block (---)");
  const end = src.indexOf("\n---", 4);
  if (end === -1) throw new Error("playbook frontmatter is not closed with ---");
  const head = src.slice(4, end);
  const body = src.slice(end + 4).replace(/^\n/, "");
  const meta = {};
  for (const raw of head.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at <= 0) throw new Error(`playbook frontmatter line is not key: value (${line.slice(0, 80)})`);
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`playbook frontmatter key is invalid (${key})`);
    if (value.startsWith("[") || value.startsWith("{")) {
      try {
        value = JSON.parse(value);
      } catch (_) {
        throw new Error(`playbook frontmatter ${key} is not valid JSON`);
      }
    } else if (value === "true" || value === "false") value = value === "true";
    else if (/^-?\d+$/.test(value)) value = Number(value);
    else value = value.replace(/^(['"])(.*)\1$/, "$2");
    meta[key] = value;
  }
  return { meta, body };
}

/* A command is an argv array, never a shell string: metacharacters are refused
 * so evidence (which is untrusted) can never become part of a command line. */
function commandToArgv(command) {
  if (command == null || (typeof command === "string" && !command.trim())) {
    return { ok: false, argv: [], reason: "no command configured" };
  }
  let argv;
  if (Array.isArray(command)) argv = command.map(String);
  else {
    const tokens = String(command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
    argv = tokens.map((token) => token.replace(/^(['"])(.*)\1$/, "$2"));
  }
  if (!argv.length) return { ok: false, argv: [], reason: "no command configured" };
  for (const arg of argv) {
    if (!arg) return { ok: false, argv, reason: "command has an empty argument" };
    if (SHELL_META.test(arg)) return { ok: false, argv, reason: "command contains a shell metacharacter" };
  }
  return { ok: true, argv, reason: null };
}

function playbookHash(playbook) {
  return sha256(JSON.stringify({
    action: playbook.action,
    command: playbook.command,
    timeout_sec: playbook.timeout_sec,
    verify: playbook.verify,
  }));
}

function parsePlaybook(text, opts = {}) {
  const { meta, body } = splitFrontmatter(text);
  const name = String(opts.name || meta.name || "playbook").trim();
  const action = String(meta.action || opts.action || "").trim();
  if (!PLAYBOOK_ACTIONS.includes(action)) {
    throw new Error(`playbook action must be one of ${PLAYBOOK_ACTIONS.join(", ")}`);
  }
  const cmd = commandToArgv(meta.command);
  const timeout = meta.timeout_sec == null ? 600 : Number(meta.timeout_sec);
  if (!(Number.isInteger(timeout) && timeout >= 1 && timeout <= 3600)) {
    throw new Error("playbook timeout_sec must be an integer between 1 and 3600");
  }
  const verify = String(meta.verify || "exit_code");
  if (verify !== "exit_code") throw new Error("playbook verify must be exit_code");
  const playbook = {
    schema: PLAYBOOK_SCHEMA,
    name,
    action,
    command: cmd.argv,
    enabled: cmd.ok === true,
    disabled_reason: cmd.ok ? null : cmd.reason,
    timeout_sec: timeout,
    verify,
    description: String(meta.description || "").slice(0, 300),
    body: String(body || "").trim().slice(0, 4000),
  };
  playbook.sha256 = playbookHash(playbook);
  return playbook;
}

module.exports = {
  PLAYBOOK_SCHEMA,
  PLAYBOOK_ACTIONS,
  splitFrontmatter,
  commandToArgv,
  playbookHash,
  parsePlaybook,
};
