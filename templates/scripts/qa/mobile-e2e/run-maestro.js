#!/usr/bin/env node
'use strict';

/**
 * mobile E2E device-run entrypoint (Maestro) — harness-owned.
 *
 * Encapsulates the operator-run device tier: guards the environment boundary
 * (never mutate UAT/production), optionally resets the dev DB via a
 * project-provided `reset.js` (seed + actor auth, unless `--no-reset`), prints
 * the documented sequence, and hands off to `maestro test`. It never starts
 * servers itself — the operator/agent starts the dev backend + emulator first.
 *
 * This file is harness-owned and overwritten by `agent-harness update`; project
 * specifics live in the sibling `local.json` (appId / defaultActor) and in the
 * project's own `flows/`, `matrix.yaml`, and `reset.js`.
 *
 * Performance layer (all additive; coverage and assertions unchanged):
 *   * `--config <file>` (default `config.yaml`) enables
 *     `platform.android.disableAnimations: true`, which removes the per-command
 *     animation-settle wait that dominates device-run wall time.
 *   * `--no-reinstall-driver` is passed to every `maestro test` (the driver
 *     APKs only need installing once per device), via `--reinstall-driver` to
 *     opt back in.
 *   * `--reuse-session` signs in once per actor instead of once per flow. The
 *     shared `_shared/session.yaml` subflow reuses an existing session and
 *     never `clearState`s, so each actor's one-time first-login walkthrough
 *     stays dismissed for the whole run; consecutive same-actor, setup-free
 *     journeys are batched into one `maestro test` invocation (fewer JVMs). A
 *     journey whose `actor:` changes is its own invocation with
 *     `MOBILE_E2E_SWITCH=1` (sign the current actor out, then sign in).
 *   * A journey with `firstLogin: true` in `flows/matrix.yaml` is run first and
 *     alone: it is the single scenario allowed to `clearState` and assert the
 *     fresh onboarding/walkthrough, and ordering it first keeps its app-data
 *     wipe from resetting the sessions every other journey reuses.
 *   * `--no-seed` runs `reset.js --no-seed` (mint actor auth against the
 *     existing dev data) for fast re-verification runs.
 *   * `--failed` re-runs only the journeys that failed in the previous run
 *     (read from `.serve/mobile-e2e-last-run.json`, written after every run).
 *
 * Usage:
 *   node scripts/qa/mobile-e2e/run-maestro.js --help
 *   node scripts/qa/mobile-e2e/run-maestro.js --flows auth-join,discovery-borrow
 *
 * Options:
 *   --flows <a,b,...>   journey ids (flow basenames) or `all` (required to run)
 *   --api-url <url>     EXPO_PUBLIC_API_URL for the dev backend (default http://localhost:3000)
 *   --app-id <id>       app under test (default local.json `appId`, then com.example.app)
 *   --no-reset          skip the reset.js step (use the current dev DB state)
 *   --no-seed           run reset.js --no-seed (mint actor auth only; keep seeded data)
 *   --reuse-session     sign in once per actor and batch same-actor setup-free flows
 *   --failed            re-run only the journeys that failed in the last run
 *   --config <file>     Maestro workspace config (default config.yaml — disables animations)
 *   --reinstall-driver  force Maestro to reinstall its device driver (default: skip)
 *   --max-same-reason <n> stop after n flows fail for the same reason (default 3; 0 disables)
 *   --root <dir>        repository root (default: the script's repository)
 *   -h, --help          print this usage and exit 0
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');
const jobEvents = require('./job-events.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FLOWS_DIR = path.join(__dirname, 'flows');
const RESET_SCRIPT = path.join(__dirname, 'reset.js');
const MATRIX_FILE = path.join(FLOWS_DIR, 'matrix.yaml');
const CONFIG_FILE = path.join(__dirname, 'config.yaml');
const LOCAL_CONFIG_FILE = path.join(__dirname, 'local.json');
const REPORT_FILE = path.join(REPO_ROOT, '.serve', 'mobile-e2e-last-run.json');

/**
 * Optional project-owned defaults (`local.json` in this directory, written by
 * the project, never by the harness): `{ "appId": "...", "defaultActor": "..." }`.
 * The harness ships the mechanism; the project names its app and actor. Env
 * vars `MOBILE_E2E_APP_ID` / `MOBILE_E2E_DEFAULT_ACTOR` override the file.
 */
function readLocalConfig() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}
const LOCAL_CONFIG = readLocalConfig();
const DEFAULT_APP_ID = process.env.MOBILE_E2E_APP_ID || LOCAL_CONFIG.appId || 'com.example.app';
const DEFAULT_ACTOR = process.env.MOBILE_E2E_DEFAULT_ACTOR || LOCAL_CONFIG.defaultActor || '';
const SEED_STATE_FILE = 'mobile-e2e-seed.json';

/**
 * Resolve the development DATABASE_URL exactly the way `reset.js` does — process
 * env wins, then `.env`/`.env.local`, then the localhost dev fallback — by
 * importing the project's own `scripts/env-util.js`. The runner and the reset can
 * therefore never disagree, and the runner stops printing the false
 * "DATABASE_URL is not set" warning when the value lives in `.env` (which is the
 * normal local setup and made the old warning fire on every run).
 */
function resolveDevDatabaseUrl(root = REPO_ROOT) {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const util = require(path.join(root, 'scripts', 'env-util.js'));
    if (util && typeof util.databaseUrlFor === 'function') {
      return util.databaseUrlFor('development') || '';
    }
  } catch {
    /* project has no env-util: fall through to the bare env value */
  }
  return process.env.DATABASE_URL || '';
}

/**
 * Content-addressed seed fingerprint: the reset script + the project's seed
 * scripts + `env-util.js` + the resolved dev URL. A change to any of these
 * invalidates it and forces a full reseed; an app-code change (which does not
 * touch seed inputs) keeps it stable so a subset re-run can skip the ~90 s seed.
 */
function seedFingerprint(root = REPO_ROOT) {
  const crypto = require('crypto');
  const hash = crypto.createHash('sha256');
  const scriptsDir = path.join(root, 'scripts');
  const rels = new Set(['qa/mobile-e2e/reset.js', 'db-seed.js', 'env-util.js']);
  try {
    for (const name of fs.readdirSync(scriptsDir)) {
      if (/^seed[-_.]/.test(name) || name === 'seed.ts' || name === 'seed.js') rels.add(name);
    }
  } catch {
    /* no scripts dir */
  }
  for (const rel of [...rels].sort()) {
    hash.update(rel);
    hash.update('\0');
    try {
      hash.update(fs.readFileSync(path.join(scriptsDir, rel)));
    } catch {
      hash.update('MISSING');
    }
    hash.update('\0');
  }
  hash.update('db=');
  hash.update(resolveDevDatabaseUrl(root));
  return hash.digest('hex');
}

/**
 * The dev Postgres is one shared database across every worktree, so the seed
 * state lives in the MAIN checkout's `.serve/` (a worktree's own `.serve/` is
 * separate and would miss the seed another tree performed).
 */
function seedStatePath() {
  const main = mainWorktreeRoot();
  return path.join(main || REPO_ROOT, '.serve', SEED_STATE_FILE);
}

function readSeedState() {
  try {
    return JSON.parse(fs.readFileSync(seedStatePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeSeedState(state) {
  try {
    const file = seedStatePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    /* best-effort */
  }
}

/**
 * Pure decision seam (unit-tested). Auto-skip the full seed ONLY for a subset
 * re-run with an unchanged fingerprint; a full matrix run always reseeds (it
 * lands the known baseline), and an explicit --no-seed / --no-reset /
 * --force-reset always wins.
 */
function shouldAutoNoSeed({ explicitNoSeed, noReset, forceReset, subset, stateMatches }) {
  if (explicitNoSeed || noReset || forceReset) return false;
  return Boolean(subset && stateMatches);
}

function usage() {
  return [
    'F-285/F-291 mobile E2E device-run entrypoint (Maestro)',
    '',
    'Usage:',
    '  node scripts/qa/mobile-e2e/run-maestro.js --flows <a,b,...|all> [options]',
    '  node scripts/qa/mobile-e2e/run-maestro.js --help',
    '',
    'Options:',
    '  --flows <a,b,...>    journey ids (flow basenames) or `all` (required to run)',
    '  --api-url <url>      EXPO_PUBLIC_API_URL for the dev backend (default http://localhost:3000)',
    '  --app-id <id>        app under test (default com.libraryos.app; Expo Go = host.exp.exponent)',
    '  --no-reset           skip reset.js (use the current dev DB state)',
    '  --no-seed            run reset.js --no-seed (mint actor auth only)',
    '  --force-reset        always run the full seed (disable the automatic subset skip)',
    '  --reuse-session      reuse the device session; batch same-actor setup-free flows (no clearState)',
    '  --failed             re-run only the journeys that failed in the last run',
    '  --report <file>      last-run report for --failed (default: this checkout, then the main checkout)',
    '  --config <file>      Maestro workspace config (default config.yaml — disables animations)',
    '  --reinstall-driver   force Maestro to reinstall its device driver (default: skip)',
    '  --max-same-reason <n> stop after n flows fail for the same reason (default 3; 0 disables)',
    '  --root <dir>         repository root (default: the script\'s repository)',
    '  -h, --help           print this usage and exit 0',
    '',
    'Documented operator sequence (run these once before this script):',
    '  1. node scripts/qa/mobile-e2e/boot-emulator.sh            # or serve.js start the emulator',
    '  2. node scripts/serve.js start --cmd "npm run dev" --url http://localhost:3000',
    '  3. npm run mobile-e2e:reset                               # seed dev DB + mint E2E actors',
    '  4. node scripts/qa/mobile-e2e/run-maestro.js --flows all',
    '',
    'By default this runner performs step 3 itself (reset.js); pass --no-reset to',
    'reuse the current database state.',
    '',
    'For the full matrix, prefer the detached helper (keeps the run observable and',
    'never blocks the tool for half an hour):',
    '  scripts/qa/mobile-e2e/run-detached.sh --flows all --reuse-session',
  ].join('\n');
}

function parseMaxSameReason(raw, fallback) {
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

function parseArgs(argv) {
  const options = {
    help: false,
    flows: null,
    apiUrl: 'http://localhost:3000',
    appId: DEFAULT_APP_ID,
    noReset: false,
    noSeed: false,
    forceReset: false,
    reuseSession: false,
    failed: false,
    config: CONFIG_FILE,
    reinstallDriver: false,
    maxSameReason: 3,
    root: REPO_ROOT,
    report: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--flows' && argv[i + 1]) options.flows = argv[++i];
    else if (arg.startsWith('--flows=')) options.flows = arg.slice('--flows='.length);
    else if (arg === '--api-url' && argv[i + 1]) options.apiUrl = argv[++i];
    else if (arg.startsWith('--api-url=')) options.apiUrl = arg.slice('--api-url='.length);
    else if (arg === '--app-id' && argv[i + 1]) options.appId = argv[++i];
    else if (arg.startsWith('--app-id=')) options.appId = arg.slice('--app-id='.length);
    else if (arg === '--no-reset') options.noReset = true;
    else if (arg === '--no-seed') options.noSeed = true;
    else if (arg === '--force-reset') options.forceReset = true;
    else if (arg === '--reuse-session') options.reuseSession = true;
    else if (arg === '--failed') options.failed = true;
    else if (arg === '--report' && argv[i + 1]) options.report = path.resolve(argv[++i]);
    else if (arg.startsWith('--report=')) options.report = path.resolve(arg.slice('--report='.length));
    else if (arg === '--config' && argv[i + 1]) options.config = path.resolve(argv[++i]);
    else if (arg.startsWith('--config=')) options.config = path.resolve(arg.slice('--config='.length));
    else if (arg === '--reinstall-driver') options.reinstallDriver = true;
    else if (arg === '--no-reinstall-driver') options.reinstallDriver = false;
    else if (arg === '--max-same-reason' && argv[i + 1]) options.maxSameReason = parseMaxSameReason(argv[++i], options.maxSameReason);
    else if (arg.startsWith('--max-same-reason=')) options.maxSameReason = parseMaxSameReason(arg.slice('--max-same-reason='.length), options.maxSameReason);
    else if (arg === '--root' && argv[i + 1]) options.root = path.resolve(argv[++i]);
    else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice('--root='.length));
    else if (!options.unknown) options.unknown = arg;
  }
  return options;
}

function assertDevDatabase() {
  const dbUrl = resolveDevDatabaseUrl();
  if (!dbUrl) {
    console.warn('  ! DATABASE_URL is not set — the flows need a dedicated DEV database.');
    console.warn('    Set DATABASE_URL to the local dev connection before running.');
    return;
  }
  if (/uat|prod/i.test(dbUrl)) {
    console.error('FAIL — refusing to run against a non-dev DATABASE_URL (contains "uat"/"prod").');
    console.error('       The mobile E2E harness must only mutate the dedicated DEV database.');
    process.exit(2);
  }
}

function resolveFlowFiles(selection) {
  if (!selection) return null;
  if (selection.trim() === 'all') {
    // Sort so the run order (and therefore warm-session batching) is
    // deterministic rather than dependent on filesystem readdir order.
    return fs
      .readdirSync(FLOWS_DIR)
      .filter((name) => name.endsWith('.yaml') && name !== 'matrix.yaml')
      .sort()
      .map((name) => path.join(FLOWS_DIR, name));
  }
  return selection
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => path.join(FLOWS_DIR, id.endsWith('.yaml') ? id : `${id}.yaml`));
}

/**
 * Bounded, dependency-free parser for `flows/matrix.yaml`. Returns a Map of
 * flow basename -> `{ id, actor, setup, oracle }`. A missing/blank manifest
 * yields an empty map (the runner still works).
 */
function parseJourneySteps(matrixPath) {
  const map = new Map();
  let content;
  try {
    content = fs.readFileSync(matrixPath, 'utf8');
  } catch {
    return map;
  }
  let current = null;
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (trimmed === 'journeys:') return;
    const idMatch = trimmed.match(/^-\s+id:\s*(.+)$/);
    if (idMatch) {
      current = { id: idMatch[1].trim(), actor: null, endsAs: null, setup: null, oracle: null, firstLogin: false };
      return;
    }
    const kvMatch = trimmed.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!kvMatch || !current) return;
    const [, key, rawValue] = kvMatch;
    if (key === 'flow') {
      current.flow = rawValue.trim();
      if (current.flow) map.set(current.flow, current);
    } else if (key === 'actor') {
      current.actor = rawValue.trim().replace(/^["']|["']$/g, '');
    } else if (key === 'endsAs') {
      current.endsAs = rawValue.trim().replace(/^["']|["']$/g, '');
    } else if (key === 'setup') {
      current.setup = rawValue.trim();
    } else if (key === 'oracle') {
      current.oracle = rawValue.trim();
    } else if (key === 'firstLogin') {
      current.firstLogin = rawValue.trim() === 'true';
    }
  });
  return map;
}

/** Split a declaration into commands: the manifest convention joins them with ` + `. */
function commandSegments(declaration) {
  return String(declaration)
    .split(/\s+\+\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * A parametric command carries an unresolved `<placeholder>` (an id minted at
 * device-run time) and cannot be auto-invoked — it is printed for the operator.
 */
function isParametricCommand(command) {
  return /<[A-Za-z_][A-Za-z0-9_]*>/.test(command);
}

/** Resolve the declared setup/oracle steps for the selected flow files, in order. */
function resolveDeclaredSteps(flowFiles, stepsByFlow) {
  const setups = [];
  const oracles = [];
  flowFiles.forEach((file) => {
    const journey = stepsByFlow.get(path.basename(file));
    if (!journey) return;
    commandSegments(journey.setup || '').forEach((command) => setups.push({ journey: journey.id, command }));
    commandSegments(journey.oracle || '').forEach((command) => oracles.push({ journey: journey.id, command }));
  });
  return { setups, oracles };
}

function printDeclaredSteps(declared) {
  if (declared.setups.length === 0 && declared.oracles.length === 0) return;
  console.log('Declared journey setup/oracle steps:');
  declared.setups.forEach((step) => console.log(`  setup  [${step.journey}]: ${step.command}`));
  declared.oracles.forEach((step) => console.log(`  oracle [${step.journey}]: ${step.command}`));
  console.log('');
}

/**
 * Invoke declared `setup:` (pre-run) or `oracle:` (post-run) commands. A
 * runnable step that exits non-zero aborts the run (fail loud), while a
 * parametric step (unresolved `<id>`) is printed for the operator.
 */
function runDeclaredSteps(steps, phase) {
  steps.forEach((step) => {
    if (isParametricCommand(step.command)) {
      console.log(`  (manual ${phase}) [${step.journey}]: ${step.command}`);
      return;
    }
    console.log(`Running ${phase} [${step.journey}]: ${step.command}`);
    const result = spawnSync(step.command, { stdio: 'inherit', shell: true });
    if (result.status !== 0) {
      console.error(`FAIL — ${phase} step for journey "${step.journey}" exited ${result.status}.`);
      console.error(`  ${step.command}`);
      process.exit(result.status === null ? 1 : result.status);
    }
  });
}

function maestroOnPath() {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, ['maestro'], { stdio: 'ignore', shell: false });
  return result.status === 0;
}

/** Resolve the project's adb: `ANDROID_HOME`/`ANDROID_SDK_ROOT`, else PATH. */
function resolveAdb() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
  if (sdk) {
    const candidate = path.join(sdk, 'platform-tools', exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return exe;
}

/**
 * Bounded adb readiness preflight. A wedged/absent adb server makes `adb`
 * hang forever (the reason a device run looks frozen before it starts), so this
 * probes with a hard timeout and fails fast with the exact recovery step rather
 * than blocking. `boot-emulator.sh` owns starting the server; this only checks.
 */
function preflightAdb() {
  const adb = resolveAdb();
  const probe = spawnSync(adb, ['devices'], { encoding: 'utf8', timeout: 10000 });
  const output = `${probe.stdout || ''}\n${probe.stderr || ''}`;
  const devices = (output.match(/^\S+\s+device\b/gm) || []).length;
  if (!probe.error && probe.status === 0 && devices > 0) {
    console.log(`adb: ${devices} device(s) online`);
    return;
  }
  console.error('FAIL — adb has no ready device (probed with a 10s timeout, so this never hangs).');
  console.error('  Bring up the device tier first:');
  console.error('    node scripts/qa/mobile-e2e/boot-emulator.sh');
  console.error('  If the adb server itself is wedged, boot-emulator.sh restarts it detached;');
  console.error('  the equivalent is:');
  console.error(`    node scripts/serve.js start --cmd "${adb} -a nodaemon server" --name adb-server --port 5037 --timeout 30000`);
  process.exit(1);
}

/** Strip ANSI SGR escape sequences so a captured reason is stable text. */
function stripAnsi(text) {
  return String(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Extract the failure reason from a single flow's captured output. Maestro ends
 * with a per-flow summary line shaped:
 *   [Failed] approve-handoff (2m 31s) (Element not found: Id matching regex: tx-approve-{id})
 * where the final parenthesised group is the reason. When no summary is present,
 * fall back to the last non-empty output line.
 */
function extractFailureReason(output, flowName) {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const summary = /^\[Failed\]\s+\S+\s+.*\((.*)\)\s*$/;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = lines[i].match(summary);
    if (match) return match[1].trim();
  }
  // Maestro's single-flow output ends with a human failure block whose last line
  // is the debug-artifacts path — meaningless as a "reason" and identical across
  // unrelated failures, which would make the fail-fast collapse them. Prefer the
  // first meaningful failure line (scanning the preferred categories in order,
  // each from the end), and never return the artifact path.
  const preferred = [
    /^Assertion .* failed/i,
    /^Assertion is false:/i,
    /^No visible element found/i,
    /^Could not find a visible element/i,
    /^Element not found/i,
    /failed to (connect|launch)/i,
  ];
  for (const pattern of preferred) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (pattern.test(lines[i])) return lines[i].replace(/\s+/g, ' ');
    }
  }
  const isNoise = (line) =>
    line === '' ||
    /^=+\s*Debug output/i.test(line) ||
    /^Possible causes:/i.test(line) ||
    /^[-·*]\s/.test(line) ||
    /debug artifacts/i.test(line) ||
    /\.maestro[/\\]tests[/\\]/.test(line) ||
    /^cacheException/i.test(line);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isNoise(lines[i])) return lines[i];
  }
  return `flow ${flowName} failed`;
}

/**
 * Parse every `[Failed] <flow> (<duration>) (<reason>)` summary line out of a
 * (possibly multi-flow) `maestro test` output. Returns a Map of flow name ->
 * reason. Flows absent from the map ran clean. This is what lets a batched
 * invocation still report per-journey results.
 */
function parseFailedFlows(output) {
  const failed = new Map();
  const pattern = /^\[Failed\]\s+(\S+)\s+\([^)]*\)\s*\(([\s\S]*)\)\s*$/;
  stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line) => {
      const match = line.match(pattern);
      if (match) failed.set(match[1], match[2].trim());
    });
  return failed;
}

/**
 * Reduce a failure reason to a signature so two flows that fail for the same
 * root cause collapse to one signature: strip ANSI, drop volatile values (UUIDs,
 * any digit run), and remove a leading `[Failed] <flow> (<duration>)` prefix.
 */
function normaliseFailureReason(reason, flowName) {
  let signature = stripAnsi(reason).trim();
  signature = signature.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}/g, '<uuid>');
  signature = signature.replace(/\d+/g, '#');
  signature = signature.replace(/^\[Failed\]\s+\S+\s+\((.*?)\)\s*/, '');
  signature = signature.replace(/\s+/g, ' ').trim();
  return signature || `flow ${flowName} failed`;
}

/** Choose a suggested fix for a repeated failure signature (heuristic). */
function suggestFix(reason) {
  const signature = String(reason);
  if (/Id matching regex/.test(signature) && /[{]|\\\{/.test(signature)) {
    return 'the selector still uses a literal placeholder / unresolved regex; convert it to `foo-.*` or check the testID registry in mobile/.';
  }
  if (/first launch/i.test(signature) || /entry state|login screen/i.test(signature)) {
    return 'flows cannot reach the entry state after `clearState`; use an embedded-bundle build (release), not a Metro dev-client (clearState wipes the dev-server URL); also check the device blocker.';
  }
  if (/Multiple elements/.test(signature)) {
    return 'the `-.*` regex is ambiguous; narrow it / add an index.';
  }
  return 'inspect the shared error; it is the common root cause for these flows.';
}

/** Build the ordered per-flow records the planner consumes. */
function buildFlowRecords(flowFiles, stepsByFlow) {
  return flowFiles.map((file) => {
    const name = path.basename(file);
    const journey = stepsByFlow.get(name) || {};
    return {
      file,
      name,
      actor: journey.actor || DEFAULT_ACTOR,
      endsAs: journey.endsAs || journey.actor || DEFAULT_ACTOR,
      setup: journey.setup || null,
      oracle: journey.oracle || null,
      hasSetup: Boolean(journey.setup),
      hasOracle: Boolean(journey.oracle),
      firstLogin: Boolean(journey.firstLogin),
    };
  });
}

/**
 * Move journeys that declare `firstLogin: true` to the front (stable). A
 * first-login scenario `clearState`s the app to prove the fresh onboarding, and
 * `pm clear` wipes the whole app data dir — including every actor's persisted
 * "walkthrough seen" flag. Running it first means that wipe happens before the
 * other journeys reuse a mixed set of sessions; running it mid-run would reset
 * the flag and re-onboard the actors the rest of the run depends on.
 */
function orderFirstLoginFirst(flowFiles, stepsByFlow) {
  const first = [];
  const rest = [];
  flowFiles.forEach((file) => {
    const journey = stepsByFlow.get(path.basename(file));
    (journey && journey.firstLogin ? first : rest).push(file);
  });
  return [...first, ...rest];
}

/**
 * Order the selected flows to maximise warm-session batching (`--reuse-session`).
 *
 * The planner only batches *consecutive* same-actor, setup/oracle-free journeys,
 * so the alphabetical order a cold run uses scatters an actor's batchable flows
 * among standalone ones — the F-296 run batched just 2 of 26 journeys (24
 * invocations). Regroup: the `firstLogin` scenario first (unchanged), then each
 * actor's flows together with the standalone (setup/oracle/`endsAs`) ones before
 * its batchable run so the batch is never interrupted. Deterministic: actors and
 * flows keep their incoming order.
 */
function orderForSessionReuse(flowFiles, stepsByFlow) {
  const first = [];
  const groups = new Map();
  flowFiles.forEach((file) => {
    const journey = stepsByFlow.get(path.basename(file)) || {};
    if (journey.firstLogin) {
      first.push(file);
      return;
    }
    const actor = journey.actor || DEFAULT_ACTOR;
    const standalone = Boolean(journey.setup || journey.oracle || (journey.endsAs && journey.endsAs !== actor));
    if (!groups.has(actor)) groups.set(actor, { standalone: [], batchable: [] });
    groups.get(actor)[standalone ? 'standalone' : 'batchable'].push(file);
  });
  const ordered = [...first];
  [...groups.keys()].sort().forEach((actor) => {
    const group = groups.get(actor);
    ordered.push(...group.standalone, ...group.batchable);
  });
  return ordered;
}

/**
 * Turn the ordered flow records into `maestro test` invocations.
 *
 * Default: one invocation per flow (preserves per-flow fail-fast granularity).
 * With `reuseSession`: a run of consecutive same-actor, setup/oracle-free,
 * non-first-login journeys becomes one warm invocation (shared session, one
 * JVM). A journey whose actor changes — or that declares a `setup:`/`oracle:`
 * step or `firstLogin:` — is always its own invocation. `switchUser` maps to
 * `MOBILE_E2E_SWITCH` in `_shared/session.yaml`: it means "sign the current
 * actor out first, then sign in as this journey's actor" (never `clearState`,
 * so the device's per-actor onboarding state survives the run).
 */
function planInvocations(records, reuseSession) {
  const invocations = [];
  let currentActor = null;
  let batch = null;
  const flush = () => {
    if (batch && batch.length > 0) {
      invocations.push({ records: batch.slice(), actor: batch[0].actor, switchUser: false });
    }
    batch = null;
  };
  records.forEach((record) => {
    const actorChanged = record.actor !== currentActor;
    // A flow that leaves a different actor signed in (`endsAs`) changes the
    // device session, so it must run alone and the next flow must switch.
    const standalone = record.hasSetup || record.hasOracle || record.firstLogin || record.endsAs !== record.actor;
    if (reuseSession && !actorChanged && !standalone) {
      if (!batch) batch = [];
      batch.push(record);
    } else {
      flush();
      invocations.push({
        records: [record],
        actor: record.actor,
        switchUser: !reuseSession || actorChanged || record.firstLogin,
      });
    }
    currentActor = record.endsAs || record.actor;
  });
  flush();
  return invocations;
}

/** Run one or more flow files via a single `maestro test` invocation. */
function runMaestroFlows(files, options, session) {
  const args = ['test'];
  if (options.config && fs.existsSync(options.config)) {
    args.push('--config', options.config);
  }
  if (!options.reinstallDriver) args.push('--no-reinstall-driver');
  args.push('-e', `APP_ID=${options.appId}`);
  args.push('-e', `MOBILE_E2E_SWITCH=${session.switchUser ? '1' : '0'}`);
  args.push('-e', `MOBILE_E2E_PHONE=${session.actor}`);
  args.push(...files);
  const result = spawnSync('maestro', args, { encoding: 'utf8', shell: false });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return { status: result.status === null ? 1 : result.status, output };
}

function reportFailFast(signature, flowNames, skipped) {
  console.error('');
  console.error('============================================================');
  console.error(`FAIL-FAST STOP — ${flowNames.length} flow(s) failed for the same reason.`);
  console.error(`Shared reason: ${signature}`);
  console.error(`Flows (${flowNames.length}): ${flowNames.join(', ')}`);
  console.error(`Skipped (${skipped.length}): ${skipped.length > 0 ? skipped.join(', ') : '(none)'}`);
  console.error(`Suggested fix: ${suggestFix(signature)}`);
  console.error('============================================================');
}

function printSequence(options) {
  console.log('Mobile E2E (Maestro) — device run');
  console.log(`appId: ${options.appId}`);
  if (options.reuseSession) console.log('mode: reuse-session (one sign-in per actor, batched)');
  console.log('');
  console.log('Documented sequence:');
  console.log('  1. node scripts/qa/mobile-e2e/boot-emulator.sh');
  console.log('  2. node scripts/serve.js start --cmd "npm run dev" --url http://localhost:3000');
  console.log(
    options.noReset
      ? '  3. npm run mobile-e2e:reset    # skipped (--no-reset); using the current dev DB state'
      : options.noSeed
        ? '  3. node scripts/qa/mobile-e2e/reset.js --no-seed    # actor auth only'
        : '  3. npm run mobile-e2e:reset    # seed dev DB + mint the E2E actor UserAuth rows'
  );
  console.log('  4. node scripts/qa/mobile-e2e/run-maestro.js --flows all');
  console.log('');
}

/**
 * Deterministic dev-DB reset before the device run. Invokes `reset.js` (which
 * owns the uat/prod boundary guard + seed + actor UserAuth mint) unless
 * `--no-reset` was passed. `--no-seed` is forwarded so a re-verification run can
 * mint actor auth without re-seeding everything.
 *
 * Speed: for a SUBSET re-run whose seed fingerprint is unchanged, the ~90 s full
 * seed is skipped automatically (mint actor auth only). The full matrix
 * (`--flows all`) always reseeds so it lands a known baseline, and an explicit
 * `--no-seed`/`--force-reset` always wins. A matched fingerprint can still be
 * stale (the dev DB volume was recreated), so a failed `--no-seed` retries once
 * with the full seed instead of failing the run.
 */
function runReset(options, ctx = {}) {
  if (options.noReset) {
    console.log('Skipping reset (--no-reset); using the current dev DB state.');
    return;
  }
  if (!fs.existsSync(RESET_SCRIPT)) {
    console.log('No reset.js in this project — skipping the dev-DB reset.');
    return;
  }

  const dbUrl = resolveDevDatabaseUrl();
  const fingerprint = seedFingerprint();
  const state = readSeedState();
  const stateMatches = !!(state && state.fingerprint === fingerprint && state.db === dbUrl);
  const autoNoSeed = shouldAutoNoSeed({
    explicitNoSeed: options.noSeed,
    noReset: options.noReset,
    forceReset: options.forceReset,
    subset: !!ctx.subset,
    stateMatches,
  });
  const useNoSeed = options.noSeed || autoNoSeed;

  if (autoNoSeed) {
    console.log('Seed fingerprint unchanged; subset re-run — minting actor auth only (use --force-reset to reseed).');
  }

  const attempt = (noSeed) => {
    const args = [RESET_SCRIPT];
    if (noSeed) args.push('--no-seed');
    console.log(
      `Resetting the dev database + minting actor auth: ${path.relative(options.root, RESET_SCRIPT)}${noSeed ? ' --no-seed' : ''}`
    );
    return spawnSync(process.execPath, args, { stdio: 'inherit', shell: false });
  };

  let result = attempt(useNoSeed);
  // A matched fingerprint can be stale/wiped (docker volume recreated): recover
  // with a full seed rather than aborting the run. Never second-guess an
  // EXPLICIT --no-seed (the operator asked for exactly that).
  if (result.status !== 0 && useNoSeed && !options.noSeed) {
    console.log('  ! --no-seed reset failed (stale DB state?) — falling back to a full seed.');
    result = attempt(false);
  }
  if (result.status !== 0) {
    console.error(`FAIL — reset.js exited ${result.status}.`);
    console.error('  Run it manually to inspect: node scripts/qa/mobile-e2e/reset.js');
    process.exit(result.status === null ? 1 : result.status);
  }
  // Only a full seed earns the fingerprint; a --no-seed run leaves the prior
  // state untouched (and there may be none for a first-ever subset run).
  if (!useNoSeed) writeSeedState({ fingerprint, db: dbUrl, at: new Date().toISOString() });
}

/** Read the previous run report's failed journeys (for `--failed`). */
function readFailedFlowNames(reportPath) {
  try {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    return (report.flows || [])
      .filter((flow) => flow.status !== 'pass')
      .map((flow) => flow.name)
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The MAIN worktree root, or null. A feature worktree has its OWN empty
 * `.serve/`, so `--failed` run from a worktree cannot see the report the matrix
 * wrote in the MAIN checkout (the F-302 "nothing to re-run" dead end). */
function mainWorktreeRoot() {
  try {
    const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (r.status === 0 && r.stdout && r.stdout.trim()) {
      const common = r.stdout.trim();
      if (path.basename(common) === '.git') return path.dirname(common);
    }
  } catch {
    /* not a git checkout */
  }
  return null;
}

/** Resolve the last-run report `--failed` reads: an explicit `--report`, else the
 * newest report among this checkout, the MAIN checkout, and sibling worktrees.
 * `opts` (primaryReport/mainRoot) is a test seam. */
function resolveFailedReport(explicit, opts = {}) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const candidates = [opts.primaryReport || REPORT_FILE];
  const main = opts.mainRoot !== undefined ? opts.mainRoot : mainWorktreeRoot();
  if (main) {
    candidates.push(path.join(main, '.serve', 'mobile-e2e-last-run.json'));
    const wtBase = path.join(path.dirname(main), '.worktrees', path.basename(main));
    try {
      for (const id of fs.readdirSync(wtBase)) {
        candidates.push(path.join(wtBase, id, '.serve', 'mobile-e2e-last-run.json'));
      }
    } catch {
      /* no sibling worktrees */
    }
  }
  let best = null;
  for (const c of candidates) {
    let stat;
    try {
      stat = fs.statSync(c);
    } catch {
      continue;
    }
    if (stat.isFile() && (!best || stat.mtimeMs > best.mtimeMs)) best = { file: c, mtimeMs: stat.mtimeMs };
  }
  return best ? best.file : null;
}

/**
 * Persist a compact machine report so `--failed` (and post-hoc analysis) can
 * re-run exactly the journeys that were red. Best-effort: a write failure must
 * never fail an otherwise valid run.
 */
function writeReport(reportPath, report) {
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  } catch (error) {
    console.warn(`  ! could not write run report (${reportPath}): ${error.message}`);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(usage());
    process.exit(0);
  }

  if (options.unknown) {
    console.error(`Unknown argument: ${options.unknown}`);
    console.error(usage());
    process.exit(2);
  }

  if (!options.flows && !options.failed) {
    console.log(usage());
    process.exit(0);
  }

  assertDevDatabase();

  const stepsByFlow = parseJourneySteps(MATRIX_FILE);

  let flowFiles;
  if (options.failed) {
    const reportFile = resolveFailedReport(options.report);
    if (!reportFile) {
      console.log(
        'No previous run report found (checked this checkout, the main checkout, and sibling worktrees) — nothing to re-run.'
      );
      process.exit(0);
    }
    const failedNames = readFailedFlowNames(reportFile);
    if (failedNames.length === 0) {
      console.log(`No failed journeys recorded in ${reportFile} — nothing to re-run.`);
      process.exit(0);
    }
    flowFiles = failedNames.map((name) => path.join(FLOWS_DIR, name.endsWith('.yaml') ? name : `${name}.yaml`));
    console.log(`Re-running ${flowFiles.length} failed journey(s) from ${reportFile}.`);
  } else {
    flowFiles = resolveFlowFiles(options.flows) || [];
  }

  const missing = flowFiles.filter((file) => !fs.existsSync(file));
  if (flowFiles.length === 0 || missing.length > 0) {
    missing.forEach((file) => console.error(`FAIL — flow file not found: ${path.relative(options.root, file)}`));
    if (flowFiles.length === 0) console.error('FAIL — no flows selected (use --flows <a,b,...|all>).');
    process.exit(2);
  }
  // A `firstLogin` journey `clearState`s the app (wiping every actor's on-device
  // onboarding flag); run it first so the rest of the run reuses intact sessions.
  // With `--reuse-session`, additionally regroup by actor so a warm run batches
  // an actor's setup-free journeys into one invocation instead of interleaving
  // them with standalone flows (the F-296 run batched 2 of 26).
  flowFiles = options.reuseSession
    ? orderForSessionReuse(flowFiles, stepsByFlow)
    : orderFirstLoginFirst(flowFiles, stepsByFlow);

  printSequence(options);
  printDeclaredSteps(resolveDeclaredSteps(flowFiles, stepsByFlow));

  if (!maestroOnPath()) {
    console.error('FAIL — Maestro CLI is not on PATH.');
    console.error('  Install it with:  curl -Ls "https://get.maestro.mobile.dev" | bash');
    console.error('  (requires JDK 17+). Then re-run this command.');
    process.exit(1);
  }

  preflightAdb();

  // A subset selection (--failed, or an explicit list rather than `all`) may skip
  // the full seed when the seed fingerprint is unchanged; a full matrix run
  // always reseeds. See runReset.
  const subset = options.failed || (typeof options.flows === 'string' && options.flows.trim() !== 'all');
  runReset(options, { subset });

  const records = buildFlowRecords(flowFiles, stepsByFlow);
  // Actor is only needed to decide session reuse/batching; a cold per-flow run
  // does not use it, so a project that has not adopted `actor:` yet still runs.
  if (options.reuseSession) {
    const missingActor = records.filter((record) => !record.actor);
    if (missingActor.length > 0) {
      console.error(`FAIL — --reuse-session needs an actor for: ${missingActor.map((record) => record.name).join(', ')}`);
      console.error('  Add `actor: "<phone>"` to the journey in flows/matrix.yaml, or set local.json `defaultActor`.');
      process.exit(2);
    }
  }
  const invocations = planInvocations(records, options.reuseSession);
  const startedAt = new Date().toISOString();
  const results = [];

  // Machine-readable progress bus (see job-events.js): the notifier plugin and
  // `--wait` consume it so the agent never has to poll/guess.
  const eventsPath = process.env.MOBILE_E2E_EVENTS || null;
  let flowIndex = 0;
  jobEvents.appendEvent(eventsPath, {
    type: 'matrix_start',
    at: startedAt,
    mode: options.reuseSession ? 'reuse-session' : 'per-flow',
    total: records.length,
  });

  const signatureCounts = new Map();
  const signatureFlows = new Map();
  let anyFailed = false;
  let stopped = false;

  for (let index = 0; index < invocations.length && !stopped; index += 1) {
    const invocation = invocations[index];
    const names = invocation.records.map((record) => record.name);
    const label = names.join(', ');

    // The manifest's declared steps are scoped to a single journey; a batch is
    // always setup-free, so setup/oracle only apply to single-flow invocations.
    const scoped = invocation.records.length === 1 ? resolveDeclaredSteps([invocation.records[0].file], stepsByFlow) : { setups: [], oracles: [] };
    runDeclaredSteps(scoped.setups, 'setup');

    console.log(`\nRunning ${invocation.records.length > 1 ? 'flows' : 'flow'} (${index + 1}/${invocations.length}): ${label} [actor=${invocation.actor}${invocation.switchUser ? ', switch' : ', reuse'}]`);
    for (const record of invocation.records) {
      jobEvents.appendEvent(eventsPath, {
        type: 'flow_start',
        at: new Date().toISOString(),
        name: record.name,
        actor: record.actor,
        index: ++flowIndex,
        total: records.length,
      });
    }
    const { status, output } = runMaestroFlows(
      invocation.records.map((record) => record.file),
      options,
      { switchUser: invocation.switchUser, actor: invocation.actor },
    );
    const failedFlows = parseFailedFlows(output);

    // Oracles run only for a passing single-flow invocation.
    if (invocation.records.length === 1 && status === 0) {
      runDeclaredSteps(scoped.oracles, 'oracle');
    }

    // A flow passes when Maestro did not name it as failed; when the invocation
    // failed but produced no `[Failed]` summary (crash/parse error), fall back to
    // the single-flow reason extractor so the failure is still attributed.
    const failedRecords = invocation.records.filter((record) => {
      const pass = failedFlows.size > 0 ? !failedFlows.has(record.name) : status === 0;
      const reason = pass ? null : failedFlows.get(record.name) || extractFailureReason(output, record.name);
      results.push({ name: record.name, actor: record.actor, status: pass ? 'pass' : 'fail', reason });
      jobEvents.appendEvent(eventsPath, {
        type: 'flow_result',
        at: new Date().toISOString(),
        name: record.name,
        actor: record.actor,
        status: pass ? 'pass' : 'fail',
        reason,
      });
      return !pass;
    });

    if (failedRecords.length > 0) {
      anyFailed = true;
      failedRecords.forEach((record) => {
        const result = results.find((entry) => entry.name === record.name);
        const reason = (result && result.reason) || `flow ${record.name} failed`;
        const signature = normaliseFailureReason(reason, record.name);
        const count = (signatureCounts.get(signature) || 0) + 1;
        signatureCounts.set(signature, count);
        if (!signatureFlows.has(signature)) signatureFlows.set(signature, []);
        signatureFlows.get(signature).push(record.name);
        console.error(`\nFAIL — ${record.name} exited ${status}: ${signature}`);
        if (options.maxSameReason > 0 && count >= options.maxSameReason) {
          const executed = new Set(results.map((result) => result.name));
          const skipped = records.map((record) => record.name).filter((name) => !executed.has(name));
          reportFailFast(signature, signatureFlows.get(signature), skipped);
          jobEvents.appendEvent(eventsPath, {
            type: 'fail_fast',
            at: new Date().toISOString(),
            count,
            signature,
            flows: signatureFlows.get(signature),
            skipped,
          });
          stopped = true;
        }
      });
    }
    if (stopped) break;
  }

  const finishedAt = new Date().toISOString();
  writeReport(REPORT_FILE, {
    startedAt,
    finishedAt,
    mode: options.reuseSession ? 'reuse-session' : 'per-flow',
    flows: results,
  });

  jobEvents.appendEvent(eventsPath, {
    type: 'matrix_done',
    at: finishedAt,
    total: records.length,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status !== 'pass').length,
    stopped,
    report: REPORT_FILE,
  });

  if (anyFailed) process.exit(1);
  process.exit(0);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  resolveFlowFiles,
  resolveFailedReport,
  readFailedFlowNames,
  runReset,
  resolveDevDatabaseUrl,
  seedFingerprint,
  shouldAutoNoSeed,
  normaliseFailureReason,
  extractFailureReason,
  suggestFix,
  parseFailedFlows,
  parseJourneySteps,
  buildFlowRecords,
  orderFirstLoginFirst,
  orderForSessionReuse,
  planInvocations,
};
