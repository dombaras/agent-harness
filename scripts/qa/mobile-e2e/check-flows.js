#!/usr/bin/env node
'use strict';

/**
 * F-285 slice 1 — mobile E2E flow-coverage validator (dependency-free).
 *
 * Proves, without a device, adb, Java, Maestro, or any npm dependency, that the
 * journey manifest and its Maestro flows are wired and self-consistent:
 *
 *   a. `flows/matrix.yaml` parses (bounded line parser, no YAML dep);
 *   b. every journey's flow file exists and is non-empty; every `flows/*.yaml`
 *      (excluding `matrix.yaml`) is referenced by some journey (no orphan);
 *   c. every flow is structurally well-formed: starts with `appId:`, contains at
 *      least one `tapOn`/`assertVisible` command, and uses only known Maestro
 *      command verbs at the top level; every `runFlow: file:` include resolves
 *      (relative to the including file, recursively) with no missing path, no
 *      escape outside `flows/`, and no cycle;
 *   d. every referenced screen resolves to a file under `mobile/`, and every
 *      referenced testID resolves to a static `testID=` occurrence, an allowed
 *      dynamic template literal (`testID={`prefix-${expr}`}`) in `mobile/`, or a
 *      `prefix-{id}` placeholder selector matching such a template;
 *   e. exits 0 with a per-check report, or 1 with the exact violation(s).
 *
 * Usage:
 *   node scripts/qa/mobile-e2e/check-flows.js [--root <dir>]
 *
 * `--root` defaults to the repository root and exists so the validator can be
 * pointed at temporary fixture trees by its own negative-case test.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FLOWS_SUBPATH = path.join('scripts', 'qa', 'mobile-e2e', 'flows');

// Maestro command verbs accepted at the top level of a flow. Keeping this list
// explicit is the point: an unknown verb is a typo/drift the validator must fail
// on rather than silently ignore.
const ALLOWED_VERBS = new Set([
  'addMedia',
  'assertNoDefectsWithAI',
  'assertNotVisible',
  'assertTrue',
  'assertVisible',
  'assertWithAI',
  'back',
  'clearKeychain',
  'clearState',
  'copyTextFrom',
  'eraseText',
  'evalScript',
  'extendedWaitUntil',
  'hideKeyboard',
  'inputText',
  'killApp',
  'launchApp',
  'openLink',
  'pasteText',
  'pressKey',
  'repeat',
  'runFlow',
  'scroll',
  'scrollUntilVisible',
  'setLocation',
  'setOrientation',
  'stopApp',
  'swipe',
  'takeScreenshot',
  'tapOn',
  'toggleAirplaneMode',
  'travel',
  'waitForAnimationToEnd',
]);

function parseRootArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root' && argv[i + 1]) return path.resolve(argv[i + 1]);
    if (arg.startsWith('--root=')) return path.resolve(arg.slice('--root='.length));
  }
  return REPO_ROOT;
}

/** Split an inline YAML sequence `[a, b, c]` without a YAML dependency. */
function parseInlineList(raw) {
  const text = String(raw).trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  return text
    .slice(start + 1, end)
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry.length > 0);
}

/**
 * Bounded, line-oriented parser for the manifest schema documented in
 * `flows/matrix.yaml`. It deliberately understands only the handful of keys the
 * contract defines; anything else is a violation, not a silent skip.
 */
function parseMatrix(content) {
  const violations = [];
  const journeys = [];
  let seenHeader = false;
  let current = null;

  const lines = content.split(/\r?\n/);
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    if (!seenHeader) {
      if (trimmed !== 'journeys:') {
        violations.push(`matrix.yaml:${lineNo}: expected top-level "journeys:" but found "${trimmed}"`);
        return;
      }
      seenHeader = true;
      return;
    }

    const itemMatch = trimmed.match(/^-\s+id:\s*(.+)$/);
    if (itemMatch) {
      current = {
        id: itemMatch[1].trim(),
        flow: '',
        entry: '',
        actor: null,
        endsAs: null,
        screens: [],
        testids: [],
        states: [],
        setup: null,
        oracle: null,
        firstLogin: null,
        batchSetup: null,
        line: lineNo,
      };
      journeys.push(current);
      return;
    }

    const kvMatch = trimmed.match(/^([A-Za-z]+):\s*(.*)$/);
    if (kvMatch) {
      if (!current) {
        violations.push(`matrix.yaml:${lineNo}: "${kvMatch[1]}" appears before any "- id:"`);
        return;
      }
      const [, key, rawValue] = kvMatch;
      if (key === 'flow') current.flow = rawValue.trim();
      else if (key === 'entry') current.entry = rawValue.trim();
      else if (key === 'actor') current.actor = rawValue.trim().replace(/^["']|["']$/g, '');
      else if (key === 'endsAs') current.endsAs = rawValue.trim().replace(/^["']|["']$/g, '');
      else if (key === 'screens') current.screens = parseInlineList(rawValue);
      else if (key === 'testids') current.testids = parseInlineList(rawValue);
      else if (key === 'states') current.states = parseInlineList(rawValue);
      else if (key === 'setup') current.setup = rawValue.trim();
      else if (key === 'oracle') current.oracle = rawValue.trim();
      else if (key === 'firstLogin') current.firstLogin = rawValue.trim();
      else if (key === 'batchSetup') current.batchSetup = rawValue.trim();
      else violations.push(`matrix.yaml:${lineNo}: unknown journey key "${key}"`);
      return;
    }

    violations.push(`matrix.yaml:${lineNo}: unparseable line "${trimmed}"`);
  });

  if (!seenHeader) violations.push('matrix.yaml: missing top-level "journeys:" header');
  if (journeys.length === 0) violations.push('matrix.yaml: no journeys declared');

  journeys.forEach((journey) => {
    if (!journey.id) violations.push(`matrix.yaml:${journey.line}: journey is missing an id`);
    if (!journey.flow) violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" is missing "flow"`);
    if (!journey.entry) violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" is missing "entry"`);
    if (journey.screens.length === 0) violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" declares no screens`);
    if (journey.states.length === 0) violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" declares no states`);
    // `actor:` is optional (run-maestro defaults to 0502000001); when declared
    // it must be non-empty — it is the phone the shared session signs in as.
    if (journey.actor === '') {
      violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" declares an empty "actor"`);
    }
    // `endsAs:` is optional; when declared it must name the actor the flow
    // leaves signed in (an empty declaration is meaningless).
    if (journey.endsAs === '') {
      violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" declares an empty "endsAs"`);
    }
    // `setup:`/`oracle:` are optional; when a journey declares one it must carry
    // the invocation (an empty declaration is a declaration without a step).
    if (journey.setup === '') {
      violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" declares an empty "setup"`);
    }
    if (journey.oracle === '') {
      violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" declares an empty "oracle"`);
    }
    // `firstLogin:` is optional; when declared it must be the literal boolean
    // `true`/`false` (the runner only recognises `true`).
    if (journey.firstLogin != null && journey.firstLogin !== '' && !/^(true|false)$/.test(journey.firstLogin)) {
      violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" has a non-boolean "firstLogin" ("${journey.firstLogin}")`);
    }
    if (journey.firstLogin === '') {
      violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" declares an empty "firstLogin"`);
    }
    // `batchSetup:` is optional; when declared it must be the literal boolean
    // `true`/`false`. It opts a setup-bearing journey into the setup-batching
    // group (the runner runs its setup before a shared warm invocation).
    if (journey.batchSetup != null && journey.batchSetup !== '' && !/^(true|false)$/.test(journey.batchSetup)) {
      violations.push(
        `matrix.yaml:${journey.line}: journey "${journey.id}" has a non-boolean "batchSetup" ("${journey.batchSetup}")`
      );
    }
    if (journey.batchSetup === '') {
      violations.push(`matrix.yaml:${journey.line}: journey "${journey.id}" declares an empty "batchSetup"`);
    }
  });

  return { journeys, violations };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function walkFiles(dir, predicate, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) return;
      walkFiles(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  });
}

/**
 * Collect the testIDs declared in `mobile/` source:
 *
 *   - static: `testID="x"`, `testID={'x'}`, `testID={`x`}` → exact ids;
 *   - forwarded props: `phoneTestID="x"` / `submitTestID="x"` — this codebase
 *     passes the id into a shared field/button component as a `*TestID` prop,
 *     which lands on the element as `testID` at runtime (F-348; the shared
 *     session/subflow selectors live on these);
 *   - dynamic: `testID={`prefix-${expr}`}` → the static prefix up to the first
 *     interpolation (`prefix-`), so a flow may reference it either literally
 *     (`prefix-…`) or with an `{id}` placeholder (`prefix-{id}`).
 *
 * Dynamic templates that begin with an interpolation (`testID={`${x}-tail`}`)
 * contribute no stable prefix and are ignored — a selector for them cannot be
 * resolved and must be treated as dangling.
 */
function collectMobileTestIds(mobileDir) {
  const ids = new Set();
  const dynamicPrefixes = new Set();
  const sources = [];
  walkFiles(mobileDir, (file) => /\.(ts|tsx)$/.test(file), sources);
  const staticPattern = /(?:testID|[A-Za-z]+TestID)=\{?["'`]([^"'`${}]+)["'`]/g;
  const dynamicPattern = /testID=\{\s*`([^`]*?)\$\{/g;
  sources.forEach((file) => {
    const content = readText(file);
    if (content === null) return;
    let match;
    while ((match = staticPattern.exec(content)) !== null) ids.add(match[1]);
    while ((match = dynamicPattern.exec(content)) !== null) {
      const prefix = match[1];
      if (prefix.length > 0) dynamicPrefixes.add(prefix);
    }
  });
  return { ids, dynamicPrefixes };
}

/**
 * Resolve a flow `id:` selector against the declared mobile testIDs.
 *
 * A selector resolves when it is a static id, when it starts with a dynamic
 * template's static prefix (`home-carousel-book-123`), or when it uses the
 * `{id}` placeholder form whose stripped prefix is a dynamic prefix
 * (`home-carousel-book-{id}` → `home-carousel-book-`).
 */
function resolveMobileTestId(selector, declared) {
  if (declared.ids.has(selector)) return true;
  if (selector.endsWith('{id}')) {
    const stripped = selector.slice(0, -'{id}'.length);
    if (declared.dynamicPrefixes.has(stripped)) return true;
  }
  // Maestro treats an `id:` value as a regex, so a device flow uses `prefix-.*`
  // rather than the literal `prefix-{id}` placeholder. Resolve it the same way:
  // strip the trailing `.*` and require the remaining prefix to be a declared
  // dynamic template prefix.
  if (selector.endsWith('.*')) {
    const stripped = selector.slice(0, -'.*'.length);
    if (declared.dynamicPrefixes.has(stripped)) return true;
  }
  for (const prefix of declared.dynamicPrefixes) {
    if (selector.startsWith(prefix)) return true;
  }
  return false;
}

function validateFlowStructure(flowName, content) {
  const violations = [];
  const lines = content.split(/\r?\n/);
  const significant = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    significant.push({ raw: line, trimmed, lineNo: index + 1 });
  });

  if (significant.length === 0) {
    violations.push(`${flowName}: flow is empty`);
    return violations;
  }

  if (!/^appId:\s*\S+/.test(significant[0].trimmed)) {
    violations.push(`${flowName}: first non-comment line must be "appId: <id>" but was "${significant[0].trimmed}"`);
  }

  const commandLines = significant.filter((entry) => /^(\s*)-\s+([A-Za-z][A-Za-z0-9_]*)/.test(entry.raw));
  if (commandLines.length === 0) {
    violations.push(`${flowName}: no top-level commands found`);
    return violations;
  }

  const baseIndent = commandLines[0].raw.match(/^(\s*)/)[1].length;
  const verbs = new Set();
  commandLines.forEach((entry) => {
    const indent = entry.raw.match(/^(\s*)/)[1].length;
    if (indent !== baseIndent) return;
    const verb = entry.raw.match(/^\s*-\s+([A-Za-z][A-Za-z0-9_]*)/)[1];
    if (!ALLOWED_VERBS.has(verb)) {
      violations.push(`${flowName}:${entry.lineNo}: unknown top-level command "${verb}"`);
    }
    verbs.add(verb);
  });

  if (!verbs.has('tapOn') && !verbs.has('assertVisible')) {
    violations.push(`${flowName}: must contain at least one "- tapOn:" or "- assertVisible:" command`);
  }

  return violations;
}

/**
 * Test-ID references inside a flow (Maestro `id:` selectors). Captures static
 * ids, `{id}` placeholders, and Maestro regex selectors ending in `.*`
 * (`prefix-.*`), which is how a dynamic template id is matched on device.
 */
function extractFlowTestIds(content) {
  const ids = new Set();
  const pattern = /^\s*id:\s*["']?([A-Za-z0-9_{}.*-]+)["']?\s*$/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) ids.add(match[1]);
  return ids;
}

function stripInlineComment(value) {
  const text = String(value).trim();
  const commentAt = text.search(/\s+#/);
  return (commentAt === -1 ? text : text.slice(0, commentAt)).trim();
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, '');
}

/**
 * Extract every `runFlow: file:` reference from a flow (F-348).
 *
 * Supports both Maestro shapes:
 *
 *   - runFlow: _shared/session.yaml
 *   - runFlow:
 *       file: _shared/session.yaml
 *
 * Only the `file:` key that is a DIRECT child of `runFlow:` counts; a `file:`
 * inside a `when:`/inline `commands:` block is a different command property and
 * is ignored. A `runFlow:` with inline `commands:` (no `file:`) is not an
 * include and yields nothing.
 */
function extractRunFlowIncludes(content) {
  const lines = content.split(/\r?\n/);
  const includes = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const match = line.match(/^(\s*)-\s+runFlow:\s*(.*)$/);
    if (!match) return;
    const baseIndent = match[1].length;
    const inlineValue = stripInlineComment(match[2]);
    if (inlineValue && !inlineValue.startsWith('{') && !inlineValue.startsWith('|')) {
      includes.push({ file: unquote(inlineValue), line: index + 1 });
      return;
    }

    // Block form: the `file:` key is a direct child (first indentation level
    // below the command), never a property of a nested `when:`/`commands:` map.
    let childIndent = null;
    for (let i = index + 1; i < lines.length; i += 1) {
      const candidate = lines[i];
      const candidateTrimmed = candidate.trim();
      if (candidateTrimmed === '' || candidateTrimmed.startsWith('#')) continue;
      const indent = candidate.match(/^(\s*)/)[1].length;
      if (indent <= baseIndent) return;
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue;
      const fileMatch = candidate.match(/^\s*file:\s*(.*)$/);
      if (fileMatch) {
        const value = unquote(stripInlineComment(fileMatch[1]));
        if (value) includes.push({ file: value, line: i + 1 });
        return;
      }
    }
  });
  return includes;
}

function validate() {
  const root = parseRootArg(process.argv.slice(2));
  const flowsDir = path.join(root, FLOWS_SUBPATH);
  const mobileDir = path.join(root, 'mobile');
  const matrixFile = path.join(flowsDir, 'matrix.yaml');
  const violations = [];
  const report = [];

  if (!fs.existsSync(flowsDir)) {
    return { violations: [`flows directory not found: ${path.relative(root, flowsDir) || flowsDir}`], report };
  }
  if (!fs.existsSync(mobileDir)) {
    return { violations: [`mobile directory not found: ${path.relative(root, mobileDir) || mobileDir}`], report };
  }

  const matrixContent = readText(matrixFile);
  if (matrixContent === null) {
    return { violations: ['flows/matrix.yaml is missing'], report };
  }
  const parsed = parseMatrix(matrixContent);
  violations.push(...parsed.violations);
  report.push(`matrix: ${parsed.journeys.length} journey(s) declared`);

  const referencedFlows = new Set();
  const mobileTestIds = collectMobileTestIds(mobileDir);

  // F-348 — `runFlow: file:` includes are part of the flow graph: their paths
  // must resolve (relative to the including file, as Maestro does), they may
  // nest, and their selectors are real coverage. Resolve the whole include graph
  // once; a missing path, an escape outside `flows/`, a cycle, or a dangling
  // testID inside a shared subflow is a violation, never a silent skip.
  const flowTestIdsCache = new Map();
  const includeStack = [];

  function resolveFlowTestIds(flowAbs, displayName) {
    if (flowTestIdsCache.has(flowAbs)) return flowTestIdsCache.get(flowAbs);
    if (includeStack.includes(flowAbs)) {
      const cycle = [...includeStack.slice(includeStack.indexOf(flowAbs)), flowAbs]
        .map((entry) => path.relative(flowsDir, entry))
        .join(' -> ');
      violations.push(`flow "${displayName}": runFlow include cycle ${cycle}`);
      return new Set();
    }
    const content = readText(flowAbs);
    if (content === null) return new Set();

    includeStack.push(flowAbs);
    const ids = extractFlowTestIds(content);
    extractRunFlowIncludes(content).forEach((include) => {
      const label = `flow "${displayName}":${include.line}`;
      const includeAbs = path.resolve(path.dirname(flowAbs), include.file);
      if (includeAbs !== flowsDir && !includeAbs.startsWith(`${flowsDir}${path.sep}`)) {
        violations.push(`${label}: runFlow file "${include.file}" escapes the flows directory`);
        return;
      }
      if (!fs.existsSync(includeAbs)) {
        violations.push(
          `${label}: runFlow file "${include.file}" is missing (resolved to ${path.relative(root, includeAbs)})`
        );
        return;
      }
      const nested = readText(includeAbs);
      if (nested === null || nested.trim() === '') {
        violations.push(`${label}: runFlow file "${include.file}" is empty`);
        return;
      }
      resolveFlowTestIds(includeAbs, path.relative(flowsDir, includeAbs)).forEach((id) => ids.add(id));
    });
    includeStack.pop();

    flowTestIdsCache.set(flowAbs, ids);
    return ids;
  }

  parsed.journeys.forEach((journey) => {
    if (!journey.flow) return;
    referencedFlows.add(journey.flow);
    const flowFile = path.join(flowsDir, journey.flow);
    if (!fs.existsSync(flowFile)) {
      violations.push(`journey "${journey.id}": flow file "${journey.flow}" is missing`);
      return;
    }
    const content = readText(flowFile) || '';
    if (content.trim() === '') {
      violations.push(`journey "${journey.id}": flow file "${journey.flow}" is empty`);
      return;
    }

    violations.push(...validateFlowStructure(journey.flow, content));

    const flowTestIds = resolveFlowTestIds(flowFile, journey.flow);
    const declaredTestIds = new Set([...journey.testids, ...flowTestIds]);
    declaredTestIds.forEach((testId) => {
      if (!resolveMobileTestId(testId, mobileTestIds)) {
        violations.push(`journey "${journey.id}": testID "${testId}" has no static or dynamic testID= in mobile/`);
      }
    });

    journey.screens.forEach((screen) => {
      const screenFile = path.join(root, screen);
      if (!fs.existsSync(screenFile)) {
        violations.push(`journey "${journey.id}": screen "${screen}" does not resolve under mobile/`);
      }
    });

    report.push(`journey "${journey.id}": flow ${journey.flow}, ${journey.screens.length} screen(s), ${declaredTestIds.size} testID(s)`);
  });

  // Orphan check: every flow on disk (except the manifest) must be referenced.
  let flowFiles = [];
  try {
    flowFiles = fs.readdirSync(flowsDir).filter((name) => name.endsWith('.yaml') && name !== 'matrix.yaml');
  } catch {
    flowFiles = [];
  }
  flowFiles.forEach((name) => {
    if (!referencedFlows.has(name)) {
      violations.push(`orphan flow: "${name}" is not referenced by any journey in matrix.yaml`);
    }
  });
  report.push(`flows on disk: ${flowFiles.length}, referenced: ${referencedFlows.size}`);

  return { violations, report };
}

function main() {
  const { violations, report } = validate();
  report.forEach((line) => console.log(`  · ${line}`));
  if (violations.length > 0) {
    console.error(`\nFAIL — ${violations.length} flow-coverage violation(s):`);
    violations.forEach((violation) => console.error(`  ✗ ${violation}`));
    process.exit(1);
  }
  console.log('\nPASS — mobile E2E flow coverage is structurally valid.');
  process.exit(0);
}

if (require.main === module) main();

module.exports = { parseInlineList, parseMatrix, extractRunFlowIncludes, validate };
