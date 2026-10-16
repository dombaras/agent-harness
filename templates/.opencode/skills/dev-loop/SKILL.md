---
name: dev-loop
description: Use when running or choosing a test tier, running a single test, seeding or resetting the dev database, booting the emulator, starting/stopping the dev server, or picking the cheapest scoped gate for a change.
---

# Dev loop — run, verify, debug

The universal run/verify loop for {{PROJECT_NAME}}. Load this before
hand-deriving how to run, seed, boot, or check something; the *how-to-run-things*
knowledge is re-derived every session otherwise. The **project-specific**
commands (tiers, single-test invocation, seed/reset, emulator/Metro, ports) live
in `.agents/memory/dev-loop.md` — read that file for the concrete commands, then
run.

## The loop

1. **Orient first, don't guess.** `node scripts/orient.js` (the `orient` tool)
   returns the tree/branch/HEAD/dirty, the active feature + checkpoint, board
   rows, owned files, the live serve jobs + capacity verdict, and a bounded
   digest of the session-start memory files (including `dev-loop.md`). Use it
   instead of re-reading memory files whole. Find a symbol with the `where` tool
   (`where <term>`), not a shell `grep`/`find` — it is tree-aware and bounded.
2. **Pick the cheapest gate that actually exercises your change** — coverage,
   not the path label. The `gates` tool (`gates --phase=quick`) runs the scoped
   harness gates and bounds the output for you (never `npm run test:quick | tail`);
   the project test tiers are in
   `.agents/memory/dev-loop.md`. A one-file change gets a single test, not the
   full regression.
3. **Run one test, not a suite, while iterating.** Use the project's single-test
   invocation (`... --test-name-pattern`, or a direct file run) until the batch
   is coherent, then run the tier once.
4. **Read the failing gate; don't re-run it blind.** Every harness gate's
   purpose and how to satisfy/waive it is in `docs/gates.md`
   (`agent-harness explain <gate>`). Re-running an unchanged gate with no state
   change is a retry loop, not a retry — change something material or report.
5. **A live tier needs a server.** Start it detached through `serve.js`
   (`node scripts/serve.js start --cmd "<dev command>" --url <health url>`),
   never backgrounded in your own shell; stop it when the tier passes
   (`node scripts/serve.js stop --name <label>`). Wait with the bounded waiter,
   never `sleep`-and-pray.
6. **Clean up after every live-data run** — reset/clean test data every time,
   not on request (project command in `dev-loop.md`; boundaries in
   `.agents/memory/environments.md`).

## serve.js lifecycle

- `node scripts/serve.js list` — what is up, per-process age, and the machine
  capacity verdict.
- `node scripts/serve.js start --cmd "<command>" [--url <health url> | --port <n>] [--name <label>]`
  — detached (returns immediately); checks the capacity envelope + machine-wide
  heavy lock and **refuses** an over-budget heavy start, naming what is already
  up (`--force` overrides).
- `node scripts/serve.js run --cmd "<heavy one-shot>" [--mem-max 3G]` — a capped
  synchronous heavy build/tier; never run a heavy build inline uncapped.
- `node scripts/serve.js stop --name <label>` / `stop-all`; `prune [--worktrees]`
  clears dead records.
- Wait, don't poll: `node scripts/wait-for.js --health <url> | --port <n> | --file <log> --grep <re>`
  (or the `wait` tool) blocks until ready and returns a terminal status on
  timeout.

## Guardrails

- Live/QA tiers target the **development** database only
  (`.agents/memory/environments.md`); never uat/prod.
- One heavy tier at a time, machine-wide — `serve.js` enforces it. Do not bypass
  it by backgrounding a process by hand.
- If a launch or a live-tier call is interrupted, verify state
  (`serve.js list`, `.serve/<name>.out.log`, the health URL) — never infer it
  from the abort. Never kill a process on a port you didn't start.
- **Never `pkill -f <pattern>`** from a shell tool: `-f` matches the FULL command
  line of every process, *including the `bash -c` shell running the `pkill`*, so
  the pattern matches its own command and SIGTERMs your shell (the turn dies
  mid-step). Kill by the recorded PID (`kill <pid>`), or write the pattern so it
  cannot match its own line (e.g. `port 4[7]44`). `pkill <name>` (no `-f`) is
  unaffected. The `context-guard` blocks the self-matching form.
- **A `Grep` that fails on a very long line** ("Ripgrep JSON record exceeded
  65536 bytes" / "Invalid ripgrep match output" — generated bundles and i18n
  dicts) is the tool hitting one enormous line, not a missing match. Don't retry
  it or fall back to a shell `grep`: `Read` the file with `offset`/`limit`, or
  narrow the pattern/file set.

## Where the concrete commands live

`.agents/memory/dev-loop.md` is the project-owned half of this skill (test
tiers, single-test invocation, seed/reset, emulator/Metro, ports, log paths).
`orient` digests it at session start. If a command there is wrong or stale, fix
it in the same session — a stale run command is worse than none.
