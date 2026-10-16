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
 *   * A journey may opt into setup batching with `batchSetup: true` in
 *     `matrix.yaml`: its additive `setup:` runs before a shared warm invocation
 *     instead of forcing a standalone one. Refused for a clearing setup, an
 *     oracle, a firstLogin, or an `endsAs` change.
 *   * The run report carries per-journey `durationMs` (from Maestro's summary in
 *     a batch, else the invocation wall clock) plus the invocation count and
 *     total wall time, so the slowest journeys are visible without parsing the
 *     Maestro logs. Batched failures match on the extension-free flow key, so a
 *     `[Failed] manager-approvals` summary is not mistaken for a pass.
 *
 * Usage:
 *   node scripts/qa/mobile-e2e/run-maestro.js --help
 *   node scripts/qa/mobile-e2e/run-maestro.js --flows auth-join,discovery-borrow
 *
 * Options:
 *   --flows <a,b,...>   journey ids (flow basenames) or `all` (required to run)
 *   --api-url <url>     EXPO_PUBLIC_API_URL for the dev backend (default http://localhost:3000)
 *   --app-id <id>       app under test (default local.json `appId`, then com.example.app)
 *   --platform <p>      target platform android (default) or ios
 *   --udid <id>         iOS Simulator UDID (default MOBILE_E2E_IOS_UDID or a booted sim)
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
const os = require('os');
const { spawnSync, spawn } = require('node:child_process');
const jobEvents = require('./job-events.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FLOWS_DIR = path.join(__dirname, 'flows');
const RESET_SCRIPT = path.join(__dirname, 'reset.js');
const MATRIX_FILE = path.join(FLOWS_DIR, 'matrix.yaml');
const CONFIG_FILE = path.join(__dirname, 'config.yaml');
const LOCAL_CONFIG_FILE = path.join(__dirname, 'local.json');
const REPORT_FILE = path.join(REPO_ROOT, '.serve', 'mobile-e2e-last-run.json');

/**
 * Liveness cadence for a running invocation. While `maestro test` runs, the
 * runner appends an `invocation_heartbeat` to the job-events stream every
 * HEARTBEAT_MS, and a one-shot `invocation_stalled` once the child has produced
 * NO output for STALL_MS — so a long-but-healthy batch no longer looks identical
 * to a hang, and a real hang is named automatically. Both env-tunable.
 */
const HEARTBEAT_MS = Math.max(1000, Number(process.env.MOBILE_E2E_HEARTBEAT_MS) || 15000);
const STALL_MS = Math.max(0, Number(process.env.MOBILE_E2E_STALL_MS) || 120000);

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
/**
 * Target platform: env MOBILE_E2E_PLATFORM > local.json `platform` > android.
 * `android` is the historical behavior (byte-identical); `ios` switches the
 * preflight off adb and onto an iOS Simulator UDID passed to `maestro test`.
 */
const DEFAULT_PLATFORM =
  String(process.env.MOBILE_E2E_PLATFORM || LOCAL_CONFIG.platform || 'android').toLowerCase() === 'ios'
    ? 'ios'
    : 'android';
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
    '  --platform <p>       target platform: android (default) or ios',
    '  --udid <id>          iOS Simulator UDID to target (default: MOBILE_E2E_IOS_UDID or a booted sim)',
    '  --no-reset           skip reset.js (use the current dev DB state)',
    '  --no-seed            run reset.js --no-seed (mint actor auth only)',
    '  --force-reset        always run the full seed (disable the automatic subset skip)',
    '  --reuse-session      reuse the device session; batch same-actor setup-free flows (no clearState)',
    '  --failed             re-run only the journeys that failed in the last run',
    '  --report <file>      last-run report for --failed (default: this checkout, then the main checkout)',
    '  --config <file>      Maestro workspace config (default config.yaml — disables animations)',
    '  --reinstall-driver   force Maestro to reinstall its device driver (default: skip)',
    '  --max-same-reason <n> stop after n flows fail for the same reason (default 3; 0 disables)',
    '  --preflight          assert adb/maestro/SDK prerequisites and exit (no run, no DB)',
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

/** Coerce a `--platform` value to one of `android` / `ios` (default android). */
function normalizePlatform(raw) {
  return String(raw || '').trim().toLowerCase() === 'ios' ? 'ios' : 'android';
}

function parseArgs(argv) {
  const options = {
    help: false,
    flows: null,
    apiUrl: 'http://localhost:3000',
    appId: DEFAULT_APP_ID,
    platform: DEFAULT_PLATFORM,
    udid: null,
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
    preflight: false,
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
    else if (arg === '--platform' && argv[i + 1]) options.platform = normalizePlatform(argv[++i]);
    else if (arg.startsWith('--platform=')) options.platform = normalizePlatform(arg.slice('--platform='.length));
    else if (arg === '--udid' && argv[i + 1]) options.udid = argv[++i];
    else if (arg.startsWith('--udid=')) options.udid = arg.slice('--udid='.length);
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
    else if (arg === '--preflight') options.preflight = true;
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
      current = {
        id: idMatch[1].trim(),
        actor: null,
        endsAs: null,
        setup: null,
        oracle: null,
        firstLogin: false,
        batchSetup: false,
      };
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
    } else if (key === 'batchSetup') {
      current.batchSetup = rawValue.trim() === 'true';
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

/** Directories the device tooling lives in but which a headless (systemd timer,
 * CI) PATH usually omits: the resolved adb's dir, the Maestro bin dir, and the
 * SDK platform-tools/emulator. Prepended to the step environment so a journey's
 * own `adb …` setup/teardown resolves. */
function toolPathDirs() {
  const dirs = [];
  const adb = resolveAdb();
  if (adb && adb !== 'adb' && adb !== 'adb.exe') dirs.push(path.dirname(adb));
  const maestro = resolveMaestro();
  if (maestro && maestro !== 'maestro' && maestro !== 'maestro.bat') dirs.push(path.dirname(maestro));
  for (const sdk of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (sdk) dirs.push(path.join(sdk, 'platform-tools'), path.join(sdk, 'emulator'), path.join(sdk, 'cmdline-tools', 'latest', 'bin'));
  }
  return [...new Set(dirs.filter((dir) => dir && fs.existsSync(dir)))];
}

/** The environment declared steps run under: the tool dirs prepended to PATH. */
function toolEnv() {
  const dirs = toolPathDirs();
  const PATH = [...dirs, process.env.PATH || ''].filter(Boolean).join(path.delimiter);
  return { ...process.env, PATH };
}

/**
 * Invoke declared `setup:` (pre-run) or `oracle:` (post-run) commands. A runnable
 * step that exits non-zero aborts the run (fail loud), while a parametric step
 * (unresolved `<id>`) is printed for the operator.
 *
 * The step runs under `toolEnv()`: a journey's `adb …` step is shell-resolved, and
 * a headless PATH omits platform-tools — the 2026-10-16 `device-e2e code 127`
 * (`/bin/sh: 1: adb: not found`, after 23 minutes of a passing run). The harness
 * resolves the SDK itself, so it must hand that resolution to the step.
 */
function runDeclaredSteps(steps, phase) {
  steps.forEach((step) => {
    if (isParametricCommand(step.command)) {
      console.log(`  (manual ${phase}) [${step.journey}]: ${step.command}`);
      return;
    }
    console.log(`Running ${phase} [${step.journey}]: ${step.command}`);
    const result = spawnSync(step.command, { stdio: 'inherit', shell: true, env: toolEnv() });
    if (result.status !== 0) {
      console.error(`FAIL — ${phase} step for journey "${step.journey}" exited ${result.status}.`);
      console.error(`  ${step.command}`);
      process.exit(result.status === null ? 1 : result.status);
    }
  });
}

/**
 * Resolve the Maestro CLI: an explicit `MOBILE_E2E_MAESTRO` override, then the
 * conventional per-user install (`~/.maestro/bin`), then PATH. A headless
 * invocation (the nightly systemd timer, CI) has a minimal PATH that excludes
 * `~/.maestro/bin`, so PATH alone is not enough — mirroring `resolveAdb()`
 * below, which resolves the SDK from a fixed location for the same reason.
 * Returns the runnable path, or null when Maestro is genuinely absent.
 */
function resolveMaestro() {
  const override = process.env.MOBILE_E2E_MAESTRO;
  if (override && fs.existsSync(override)) return override;
  const exe = process.platform === 'win32' ? 'maestro.bat' : 'maestro';
  const installed = path.join(os.homedir(), '.maestro', 'bin', exe);
  if (fs.existsSync(installed)) return installed;
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, ['maestro'], { stdio: 'ignore', shell: false });
  return result.status === 0 ? 'maestro' : null;
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

/**
 * `--preflight`: assert the device tier's EXTERNAL prerequisites and exit without
 * touching the app, the DB or the emulator. It runs before `device-up` inside the
 * nightly so a missing tool names itself instead of burning the full run and
 * failing with a bare exit code (2026-10-16: `device-e2e code 127` after 23 min,
 * the real cause a journey `adb …` step with platform-tools off the headless
 * PATH). Returns an exit code: 0 when every FATAL check passes, 1 otherwise.
 * Advisories (a non-WSL box, no booted device yet) are printed but never fatal.
 */
function runPreflight(options) {
  const checks = [];
  const add = (name, ok, { detail = '', hint = '', fatal = true } = {}) => {
    checks.push({ name, ok, detail, hint, fatal });
  };

  const adb = resolveAdb();
  const adbProbe = adb ? spawnSync(adb, ['devices'], { encoding: 'utf8', timeout: 10000, env: toolEnv() }) : { status: 1, error: new Error('adb not resolved') };
  const adbRuns = !adbProbe.error && adbProbe.status === 0;
  add('adb', adbRuns, {
    detail: adbRuns ? `${adb} runs` : `${adb || 'adb'} is not runnable${adbProbe.error ? ` (${adbProbe.error.code || adbProbe.error.message})` : ''}`,
    hint: 'Install Android platform-tools and set ANDROID_HOME/ANDROID_SDK_ROOT (or add platform-tools to PATH).',
  });

  const maestro = resolveMaestro();
  add('maestro', Boolean(maestro), {
    detail: maestro || 'not resolvable',
    hint: 'curl -Ls "https://get.maestro.mobile.dev" | bash (needs JDK 17+), or set MOBILE_E2E_MAESTRO.',
  });

  if (options.platform === 'ios') {
    let udid = '';
    try {
      udid = resolveIosUdid(options) || '';
    } catch (_) {
      udid = '';
    }
    add('ios-udid', Boolean(udid), {
      detail: udid || 'no booted simulator resolved',
      hint: 'Boot a simulator (xcrun simctl boot <udid>) or pass --udid / set MOBILE_E2E_IOS_UDID.',
    });
  } else {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
    add('android-sdk-env', Boolean(sdk), {
      detail: sdk || 'ANDROID_HOME / ANDROID_SDK_ROOT unset',
      hint: 'Set ANDROID_HOME so `adb` resolves in a headless (systemd/CI) shell.',
      fatal: false,
    });
    // A booted device is NOT required here (the nightly boots it after this
    // step); report readiness as an advisory only.
    const devices = adbRuns ? (`${adbProbe.stdout || ''}`.match(/^\S+\s+device\b/gm) || []).length : 0;
    add('device-ready', devices > 0, {
      detail: devices > 0 ? `${devices} device(s) online` : 'none online yet',
      hint: 'device-up.sh boots the emulator; a run without it will fail at the adb preflight.',
      fatal: false,
    });
  }

  const toolDirs = toolPathDirs();
  add('step-path', toolDirs.length > 0 || Boolean(adb) || Boolean(maestro), {
    detail: toolDirs.length ? `platform-tools/maestro added: ${toolDirs.join(', ')}` : 'nothing to add (tools already on PATH)',
    fatal: false,
  });

  const failed = checks.filter((c) => c.fatal && !c.ok);
  for (const c of checks) {
    const mark = c.ok ? 'ok' : c.fatal ? 'FAIL' : 'warn';
    console.log(`device-preflight: ${mark.padEnd(4)} ${c.name} — ${c.detail}`);
    if (!c.ok && c.hint) console.log(`    ${c.hint}`);
  }
  console.log(failed.length ? `device-preflight: FAILED (${failed.map((c) => c.name).join(', ')})` : 'device-preflight: OK');
  return failed.length ? 1 : 0;
}

/**
 * Resolve the iOS Simulator UDID to hand to `maestro test --device`. Priority:
 * an explicit `--udid`, then `MOBILE_E2E_IOS_UDID`, then a booted simulator
 * discovered via `xcrun simctl list devices booted -j` and matched against
 * local.json `ios.deviceName`. Fails loudly when nothing resolves — a run with
 * no target device would otherwise fail later with a cryptic Maestro error.
 */
function resolveIosUdid(options = {}) {
  const explicit = options.udid || process.env.MOBILE_E2E_IOS_UDID;
  if (explicit) return String(explicit).trim();
  const deviceName =
    process.env.MOBILE_E2E_IOS_DEVICE_NAME || (LOCAL_CONFIG.ios && LOCAL_CONFIG.ios.deviceName) || '';
  const probe = spawnSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
    encoding: 'utf8',
    timeout: 10000,
  });
  if (probe.error || probe.status !== 0) {
    console.error('FAIL — could not list booted iOS simulators (is this a macOS host with Xcode?).');
    console.error('  Bring one up first: node scripts/qa/mobile-e2e/ios-simulator-up.sh');
    process.exit(1);
  }
  let list;
  try {
    list = JSON.parse(probe.stdout || '{}');
  } catch {
    list = {};
  }
  const all = [];
  for (const devices of Object.values(list.devices || {})) {
    for (const device of devices) all.push(device);
  }
  const match = deviceName ? all.find((d) => d.name === deviceName) : null;
  const udid = (match || all[0] || {}).udid;
  if (!udid) {
    console.error('FAIL — no booted iOS Simulator found.');
    console.error('  Bring one up first: node scripts/qa/mobile-e2e/ios-simulator-up.sh');
    console.error('  Or pass --udid <id> / set MOBILE_E2E_IOS_UDID.');
    process.exit(1);
  }
  return String(udid);
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
 * Normalise a flow reference to the key both the manifest and Maestro's summary
 * agree on: the basename with any `.yaml`/`.yml` extension stripped. Maestro's
 * per-flow summary prints `manager-approvals` (no extension) while the runner
 * tracks `manager-approvals.yaml`; matching on the raw string silently treated
 * every batched failure as a pass (manager-approvals + offline-sync-recovery
 * were lost in the 2026-10-01 full matrix).
 */
function flowKey(name) {
  return String(name).replace(/\.ya?ml$/i, '');
}

/**
 * Parse every `[Failed] <flow> (<duration>) (<reason>)` summary line out of a
 * (possibly multi-flow) `maestro test` output. Returns a Map of normalised flow
 * key -> reason. Flows absent from the map ran clean. This is what lets a
 * batched invocation still report per-journey results.
 */
function parseFailedFlows(output) {
  const failed = new Map();
  const pattern = /^\[Failed\]\s+(\S+)\s+\([^)]*\)\s*\(([\s\S]*)\)\s*$/;
  stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line) => {
      const match = line.match(pattern);
      if (match) failed.set(flowKey(match[1]), match[2].trim());
    });
  return failed;
}

/**
 * Parse Maestro's per-flow duration from `[Passed|Failed] <flow> (<dur>)` summary
 * lines (e.g. `1m 23s`, `59s`) into milliseconds, keyed by the normalised flow
 * key. Absent for single-flow invocations, whose duration the caller measures
 * directly from the invocation wall clock.
 */
function parseFlowDurations(output) {
  const durations = new Map();
  const pattern = /^\[(?:Passed|Failed)\]\s+(\S+)\s+\(([^)]*)\)/;
  stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line) => {
      const match = line.match(pattern);
      if (match) durations.set(flowKey(match[1]), parseMaestroDuration(match[2]));
    });
  return durations;
}

/** Parse a Maestro duration token (`1m 23s`, `59s`, `2m`, `500ms`) to ms. */
function parseMaestroDuration(token) {
  const text = String(token).trim();
  const ms = text.match(/^(\d+)ms$/);
  if (ms) return Number(ms[1]);
  const m = text.match(/^(?:(\d+)m)?\s*(?:(\d+)s)?$/);
  if (!m || (!m[1] && !m[2])) return null;
  return (Number(m[1] || 0) * 60 + Number(m[2] || 0)) * 1000;
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

/**
 * A declared setup that wipes the app's data dir (`pm clear`/`clearState`) also
 * wipes the signed-in session, so the flow must re-establish it. The planner
 * otherwise only switches on an actor change / firstLogin — `scan-add` clears
 * the app in its setup yet was planned as a warm reuse, limping through the
 * login fallback with a 25 s wasted probe (2026-10-01 full matrix).
 */
function setupClearsAppState(setup) {
  return /(^|[^A-Za-z])pm\s+clear\b/i.test(String(setup || '')) || /clearState/i.test(String(setup || ''));
}

/**
 * A journey whose declared setup is additive and explicitly opted into batching
 * (`batchSetup: true`) may share a warm invocation with other opt-in journeys of
 * the same actor: the runner runs every setup immediately before the batch. It
 * is deliberately off by default — the project asserts its setups are
 * order-independent and non-clearing in `matrix.yaml`.
 */
function isSetupGroupable(journey) {
  return Boolean(
    journey &&
      journey.batchSetup &&
      journey.setup &&
      !journey.oracle &&
      !journey.firstLogin &&
      !setupClearsAppState(journey.setup) &&
      (!journey.endsAs || journey.endsAs === (journey.actor || DEFAULT_ACTOR))
  );
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
      clearsAppState: setupClearsAppState(journey.setup),
      batchSetup: isSetupGroupable(journey),
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
    // A setup-bearing journey is standalone unless it explicitly opted into
    // setup batching (`batchSetup: true`) and qualifies as order-independent.
    const standalone = Boolean(
      (journey.setup && !isSetupGroupable(journey)) ||
        journey.oracle ||
        (journey.endsAs && journey.endsAs !== actor)
    );
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
    // device session, so it must run alone and the next flow must switch. A
    // setup-bearing flow is standalone unless it opted into setup batching
    // (`batchSetup: true`); a setup that clears app data always stands alone.
    const standalone =
      record.hasOracle ||
      record.firstLogin ||
      record.endsAs !== record.actor ||
      record.clearsAppState ||
      (record.hasSetup && !record.batchSetup);
    if (reuseSession && !actorChanged && !standalone) {
      if (!batch) batch = [];
      batch.push(record);
    } else {
      flush();
      invocations.push({
        records: [record],
        actor: record.actor,
        switchUser: Boolean(!reuseSession || actorChanged || record.firstLogin || record.clearsAppState),
      });
    }
    currentActor = record.endsAs || record.actor;
  });
  flush();
  return invocations;
}

/**
 * Run one or more flow files via a single `maestro test` invocation, streaming
 * the child's output LIVE as it arrives.
 *
 * This used to be `spawnSync(...)`, which buffers the child's entire stdout
 * until it exits: a batched invocation (up to a dozen journeys in one JVM) then
 * wrote nothing to the log or the job-events stream for its whole duration, so a
 * healthy multi-minute batch was indistinguishable from a hang (the 2026-10-02
 * "frozen matrix" — the log sat at the batch header for 10+ minutes while a
 * 12-flow invocation ran). Streaming each chunk through (while still capturing
 * the whole text for failure parsing) fixes the observability gap; `onChunk`
 * lets the caller reset its stall watchdog.
 */
function runMaestroFlows(files, options, session, onChunk) {
  const args = ['test'];
  if (options.config && fs.existsSync(options.config)) {
    args.push('--config', options.config);
  }
  if (!options.reinstallDriver) args.push('--no-reinstall-driver');
  // iOS: every invocation targets the resolved Simulator explicitly. Android
  // leaves `udid` null, so its command line is byte-identical to before.
  if (options.udid) args.push('--device', options.udid);
  args.push('-e', `APP_ID=${options.appId}`);
  args.push('-e', `MOBILE_E2E_SWITCH=${session.switchUser ? '1' : '0'}`);
  args.push('-e', `MOBILE_E2E_PHONE=${session.actor}`);
  args.push(...files);

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const stdout = [];
    const stderr = [];
    const relay = (buf, sink, stream) => {
      const text = buf.toString();
      sink.push(text);
      stream.write(text);
      if (typeof onChunk === 'function') onChunk(text);
    };
    let child;
    try {
      child = spawn(resolveMaestro() || 'maestro', args, { shell: false });
    } catch (err) {
      const text = `\nmaestro failed to start: ${err && err.message ? err.message : err}\n`;
      stderr.push(text);
      process.stderr.write(text);
      return done({ status: 1, output: `${stdout.join('')}\n${stderr.join('')}` });
    }
    child.stdout.on('data', (buf) => relay(buf, stdout, process.stdout));
    child.stderr.on('data', (buf) => relay(buf, stderr, process.stderr));
    child.on('error', (err) => {
      const text = `\nmaestro failed to start: ${err && err.message ? err.message : err}\n`;
      stderr.push(text);
      process.stderr.write(text);
      done({ status: 1, output: `${stdout.join('')}\n${stderr.join('')}` });
    });
    child.on('close', (code) => {
      done({ status: code === null ? 1 : code, output: `${stdout.join('')}\n${stderr.join('')}` });
    });
  });
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
  if (options.platform === 'ios') console.log('platform: ios (Simulator)');
  if (options.reuseSession) console.log('mode: reuse-session (one sign-in per actor, batched)');
  console.log('');
  console.log('Documented sequence:');
  console.log(
    options.platform === 'ios'
      ? '  1. node scripts/qa/mobile-e2e/ios-simulator-up.sh'
      : '  1. node scripts/qa/mobile-e2e/boot-emulator.sh'
  );
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

async function main() {
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

  // `--preflight` is a standalone check: it needs no flows and no seeded DB, and
  // must run before any of that is required.
  if (options.preflight) {
    process.exit(runPreflight(options));
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

  if (!resolveMaestro()) {
    console.error('FAIL — Maestro CLI is not on PATH and not at ~/.maestro/bin/maestro.');
    console.error('  Install it with:  curl -Ls "https://get.maestro.mobile.dev" | bash');
    console.error('  (requires JDK 17+), or point MOBILE_E2E_MAESTRO at the binary. Then re-run this command.');
    process.exit(1);
  }

  if (options.platform === 'ios') {
    // iOS Simulator: resolve the UDID and target `maestro test --device`. adb
    // is Android-only, so the adb preflight is skipped entirely.
    options.udid = resolveIosUdid(options);
    console.log(`target: ios simulator ${options.udid}`);
  } else {
    preflightAdb();
  }

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
  let totalInvocationMs = 0;

  for (let index = 0; index < invocations.length && !stopped; index += 1) {
    const invocation = invocations[index];
    const names = invocation.records.map((record) => record.name);
    const label = names.join(', ');

    // Declared setup steps run immediately before the invocation. A batch is
    // normally setup-free (resolving to none); an explicit `batchSetup: true`
    // batch runs every member's setup here, in manifest order, before the one
    // shared `maestro test`. Oracles stay scoped to a passing single flow.
    const scoped = resolveDeclaredSteps(invocation.records.map((record) => record.file), stepsByFlow);
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
    const invocationStart = Date.now();
    // Liveness while the invocation runs: a heartbeat event every HEARTBEAT_MS
    // (so a long batch is visibly ALIVE, not frozen) and a one-shot
    // `invocation_stalled` when the child has produced no output for STALL_MS
    // (so a real hang is named instead of guessed at).
    let lastOutputAt = invocationStart;
    let stallAnnounced = false;
    const heartbeat = setInterval(() => {
      const now = Date.now();
      const msSinceOutput = now - lastOutputAt;
      jobEvents.appendEvent(eventsPath, {
        type: 'invocation_heartbeat',
        at: new Date().toISOString(),
        index: index + 1,
        total: invocations.length,
        flows: names,
        actor: invocation.actor,
        elapsedMs: now - invocationStart,
        msSinceOutput,
      });
      if (STALL_MS > 0 && msSinceOutput >= STALL_MS && !stallAnnounced) {
        stallAnnounced = true;
        jobEvents.appendEvent(eventsPath, {
          type: 'invocation_stalled',
          at: new Date().toISOString(),
          index: index + 1,
          total: invocations.length,
          flows: names,
          actor: invocation.actor,
          elapsedMs: now - invocationStart,
          msSinceOutput,
        });
        console.error(
          `\nWARNING — invocation ${index + 1}/${invocations.length} produced no output for ` +
            `${Math.round(msSinceOutput / 1000)}s (possible hang): ${label}`,
        );
      }
      if (msSinceOutput < STALL_MS) stallAnnounced = false;
    }, HEARTBEAT_MS);

    let invocationResult;
    try {
      invocationResult = await runMaestroFlows(
        invocation.records.map((record) => record.file),
        options,
        { switchUser: invocation.switchUser, actor: invocation.actor },
        () => {
          lastOutputAt = Date.now();
        },
      );
    } finally {
      clearInterval(heartbeat);
    }
    const { status, output } = invocationResult;
    const invocationMs = Date.now() - invocationStart;
    totalInvocationMs += invocationMs;
    const failedFlows = parseFailedFlows(output);
    const flowDurations = parseFlowDurations(output);

    // Oracles run only for a passing single-flow invocation.
    if (invocation.records.length === 1 && status === 0) {
      runDeclaredSteps(scoped.oracles, 'oracle');
    }

    // A flow passes when Maestro did not name it as failed; when the invocation
    // failed but produced no `[Failed]` summary (crash/parse error), fall back to
    // the single-flow reason extractor so the failure is still attributed.
    // Matching is on the normalised flow key (extension-free) so a batched
    // failure is attributed to its journey instead of silently passing.
    const failedRecords = invocation.records.filter((record) => {
      const key = flowKey(record.name);
      const pass = failedFlows.size > 0 ? !failedFlows.has(key) : status === 0;
      const reason = pass ? null : failedFlows.get(key) || extractFailureReason(output, record.name);
      // Maestro's summary carries per-flow durations in a batch; a single-flow
      // invocation has no summary line, so its wall clock is the duration.
      const durationMs = flowDurations.has(key)
        ? flowDurations.get(key)
        : invocation.records.length === 1
          ? invocationMs
          : null;
      results.push({ name: record.name, actor: record.actor, status: pass ? 'pass' : 'fail', reason, durationMs });
      jobEvents.appendEvent(eventsPath, {
        type: 'flow_result',
        at: new Date().toISOString(),
        name: record.name,
        actor: record.actor,
        status: pass ? 'pass' : 'fail',
        reason,
        durationMs,
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
  const flowsWithDurations = results.filter((result) => typeof result.durationMs === 'number');
  const slowest = [...flowsWithDurations]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)
    .map((result) => `${result.name}=${Math.round(result.durationMs / 1000)}s`);
  writeReport(REPORT_FILE, {
    startedAt,
    finishedAt,
    mode: options.reuseSession ? 'reuse-session' : 'per-flow',
    invocationCount: invocations.length,
    matrixDurationMs: Date.parse(finishedAt) - Date.parse(startedAt),
    invocationDurationMs: totalInvocationMs,
    flows: results,
  });
  if (slowest.length > 0) {
    console.log(`\nSlowest journeys: ${slowest.join(', ')}`);
  }

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

if (require.main === module) {
  main().catch((err) => {
    console.error(`FAIL — ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  resolveMaestro,
  resolveIosUdid,
  normalizePlatform,
  runMaestroFlows,
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
  flowKey,
  parseFailedFlows,
  parseFlowDurations,
  parseMaestroDuration,
  setupClearsAppState,
  isSetupGroupable,
  parseJourneySteps,
  buildFlowRecords,
  orderFirstLoginFirst,
  orderForSessionReuse,
  planInvocations,
  toolPathDirs,
  toolEnv,
  runPreflight,
};
