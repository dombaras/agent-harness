# Deferred backlog — Skills (C) and MCP (D)

**Status:** **shipped in harness `0.1.121`** (2026-10-01). C1 `dev-loop` skill,
C2 bounded `explore`, the `mergeOpencodeJson` `mcp` deep-merge, and the D1/D2
per-agent/dev-only MCP guidance all landed; D3 (GitHub MCP) was deliberately not
enabled per its own recommendation below. The original recon design is kept here
as the record. Captured 2026-10-01 from the LibraryOS recon whose
scope A/B/E shipped in harness `0.1.120`. This file is self-contained: a clean
context should be able to implement any item without re-running the recon.

**Provenance / data.** Recon of LibraryOS WSL sessions 2026-09-17 → 10-01 (297
sessions, 116 primary, $14.79); live `.agents/guard-events.jsonl`; transcripts
via `opencode export`. Full write-up: `docs/optimization-implementation-status.md`
§`0.1.120`. Re-measure with `npm run report:recon -- --since=14d` and
`npm run report:cost`.

**What already shipped (do not re-do):** orient injection + memory digest,
structural tool blocks, `gates`, `where`, `feature:scaffold`, prefix size budget
(scope A/B/E). Skills (C) and MCP (D) were deferred deliberately.

**Read first if unfamiliar:** `AGENTS.md` (harness workflow), `docs/gates.md`,
`docs/wsl-optimizations.md` §5, `.agents/rules/00-operating.md` §5 (token
discipline) + §6 (tiers), and opencode docs for MCP/skills (links inline below).

---

## C — Skills

### Why (evidence)

The recon shows the *how-to-run-things* knowledge is re-derived every session
instead of being a loadable skill:

- `serve.js list` ran **91×**, `test:capacity` / env reads abound; the four
  session-start memory files were read ~219× (now partly replaced by the orient
  digest).
- Gate churn: ~700 individual gate invocations (`tsc` 125, `test:quick` 120,
  `test:qa-plan` 50 …) — mostly the agent not knowing the cheapest scoped check.
- Persona skills are adopted (`docs` 21, `qa-architect` 24, `product-manager` 18,
  `planner` 14, `mobile-engineer` 13 …) — skills *do* get loaded, so a dev-loop
  skill would be used.

### C1 — `dev-loop` skill (recommended)

**Goal:** one loadable skill that answers "how do I run/verify/debug something in
this project" so the agent stops re-deriving it.

**Design decision already forced by the harness:** `.agents/skills/**` and
`.opencode/skills/**` are **harness-owned** (deployed from `templates/`), so a
*project-specific* skill cannot live there without being clobbered on `update`.
Two safe shapes:

1. **Harness generic skill + project-owned data (recommended).**
   - Ship `templates/.agents/skills/dev-loop/SKILL.md` (harness-owned): the
     universal loop — scoped check via `npm run gates -- --phase=quick` (or the
     `gates` tool), single test `npm run <tier> -- --test-name-pattern` / direct
     file invocation, `serve.js start|list|stop` lifecycle + capacity refusal,
     `orient`/`where`/`gates` usage, "read the failing gate, don't re-run it
     blind". Ends with: "project-specific commands live in
     `.agents/memory/dev-loop.md`".
   - Ship `templates/.agents/memory/dev-loop.md` (**create-if-missing**, so it is
     project-owned after first deploy) with the generic shape (test tiers, seed,
     reset, emulator/Metro, ports). LibraryOS fills the concrete commands.
   - Frontmatter: `name: dev-loop` (must match dir, `^[a-z0-9]+(-[a-z0-9]+)*$`),
     `description:` specific enough for auto-selection ("Use when running a test
     tier, seeding/resetting the dev DB, booting the emulator, or choosing the
     cheapest scoped gate for a change").
   - Verify discovery: project skills load from `.agents/skills/<name>/SKILL.md`
     (opencode walks up to the git worktree) — see
     https://opencode.ai/docs/skills/.
2. **Machine-level skill** at `~/.config/opencode/skills/libraryos-dev/SKILL.md`
   (not harness-managed) — viable but machine-specific and not deployed; only if
   a project must own the exact commands with no harness indirection.

**Files:** `templates/.agents/skills/dev-loop/SKILL.md`,
`templates/.agents/memory/dev-loop.md`, a `HARNESS_SCRIPTS`/rule pointer if
useful, drift-guard test in `tests/agent-harness.test.js`, doc note in
`docs/gates.md` / `AGENTS.md`.

**Acceptance:**
- Skill appears in `<available_skills>` and is loadable via the `skill` tool in a
  deployed project.
- A fresh session runs the loop from the skill + `dev-loop.md` without reading
  `environments.md`/`locations.md` whole.
- `npm test` + `npm run lint` green; deploy to LibraryOS and fill
  `.agents/memory/dev-loop.md` with the real commands (test unset; single tsx/ts
  test invocation; `npm run mobile-e2e:reset`; emulator boot via
  `scripts/qa/mobile-e2e/device-up.sh`; dev via `serve.js`).

**Open questions:** whether `.agents/memory/dev-loop.md` should be folded into
the orient memory digest (`scripts/orient.js` `MEMORY_FILES`) so it is surfaced
at session start.

### C2 — `explore` contract (optional, pairs with H-25)

The `explore` subagent is the most expensive dispatch (~465K input
tokens/dispatch, 4 dispatches, $0.55 — recon 14 d). Ship a bounded `explore`
skill/contract: input = paths + exact question + result budget; output =
`file:line` pointers + short summary, no whole-file dumps. Only if H-25's
measurement shows explore stays heavy.

---

## D — MCP

### Cross-cutting facts (verified 2026-10-01, opencode docs)

- Config lives under `mcp` in `opencode.json`; each server is `type: "local"`
  (`command: [...]`, `environment: {}`, `cwd`, `enabled`, `timeout`) or
  `type: "remote"` (`url`, `headers`, `oauth`).
- MCP tools are registered **prefixed by server name** and are **available to
  every agent by default**; disable via top-level `"tools": { "<server>*": false }`
  and re-enable per agent via `"agent": { "<agent>": { "tools": { "<server>*": true } } }`.
- CLI: `opencode mcp list` / `opencode mcp auth <name>` / `opencode mcp debug <name>`.
- **Context cost is the dominant risk:** the docs warn MCP servers add to the
  prompt and that GitHub MCP in particular "tends to add a lot of tokens". Every
  MCP tool schema is billed on every request — which fights the `0.1.120`
  prefix-cost work. **Enable MCP per agent, not globally, and only for a persona
  that genuinely needs live external state.**
- **Capacity:** MCP servers are spawned by opencode, not by `serve.js`, so they
  bypass the machine-capacity envelope. On this 10 GB WSL2 box that is a real
  risk (`docs/wsl-optimizations.md` §3); a heavy MCP server per parallel session
  can tip the VM. Prefer remote servers (no local RSS) or one local server
  enabled for a single agent.
- **Merge handling:** `mergeOpencodeJson` (`bin/agent-harness.js`) currently
  spreads `{ ...existing, ...harness }` and only deep-merges `instructions`,
  `agent`, `permission`. If the harness ever ships a default `mcp` block it will
  **override a project's `mcp`** — add deep-merge handling (like `agent`) first,
  or ship MCP config project-side only (recommended for the first cut).

### D1 — Prisma/Postgres MCP (highest value)

**Why:** detectives and QA reach the dev DB through ad-hoc `node -e`, prisma
scripts, and `docker compose exec psql`; a schema-aware MCP removes the
guess-and-check. The project is **Prisma 7 + WSL-native Postgres (`pvl_postgres`,
`DATABASE_URL` dev only)**.

**Candidates (verify current package + maintenance before wiring):**
- Prisma's own MCP server (`prisma mcp` / `@prisma/mcp`) — schema/migration aware,
  matches the stack; **primary candidate**.
- A read-only Postgres MCP (`@modelcontextprotocol/server-postgres` /
  `postgres-mcp`) — fallback.

**Config sketch (project-side `opencode.json`, dev DB only):**
```jsonc
"mcp": {
  "pg": { "type": "local", "command": ["npx", "-y", "<server pkg>"],
          "environment": { "DATABASE_URL": "postgresql://...dev..." },
          "enabled": true }
}
```
**Guardrails:** dev `DATABASE_URL` only (never uat/prod — the forward boundary in
`AGENTS.md` §2); read-only where the server allows; deny a write mode; keep it out
of the git-tracked config if it embeds a URL (use `{env:...}` or a local
untracked override).

**Acceptance:** an agent answers "which rows/columns does table X have and why is
this query failing" without `node -e`/`psql`; no secrets in tracked config;
`opencode mcp list` shows it healthy; capacity unchanged on a single session.

### D2 — Playwright MCP

**Why:** web E2E is Playwright (`playwright.config.ts`), but debugging a red run
is read-the-report-only; interactive navigate/click/snapshot on the dev server
would shorten the loop. Candidate: `@playwright/mcp` (Microsoft).

**Guardrails:** run against the dev server started via `serve.js` with caps;
enable for `qa-runner`/`diagnostics-expert` only; watch RSS.

**Acceptance:** an agent drives a failing flow interactively and reports the DOM
state / console error without a bespoke script.

### D3 — GitHub MCP (lowest priority)

**Why:** CI/PR inspection. **Mostly obviated** by the `0.1.88` direct-land flow
(recon: `gh run watch` polling ~0 after `ship`). The docs explicitly warn this
server is token-heavy.

**Recommendation:** do **not** add it globally. If added, per-agent only and for
`devops-engineer`; confirm it beats the deterministic `wait --ci` + `gh` already
in use. Skip unless a concrete need appears.

### Suggested order & validation

1. **C1 dev-loop skill** — no context/capacity risk; highest adoption odds.
2. **D1 Prisma/Postgres MCP** — highest MCP value; per-agent, dev-only.
3. **D2 Playwright MCP** — per-agent, capacity-watched.
4. **D3 GitHub MCP** — only on demonstrated need.
5. Re-measure: `report:recon` (`inspectShare`, `orient`/`wait` adoption, prologue)
   and `report:cost` (input tokens, per-agent cost) 1–2 weeks after each MCP
   change; drop any MCP whose tool-schema cost outweighs its use.

### Explicit do-nots

- Do not enable MCP servers globally (context + RSS); scope per agent.
- Do not let an MCP server reach uat/prod data.
- Do not ship a default `mcp` block in `templates/opencode.json` until
  `mergeOpencodeJson` deep-merges `mcp` (else it clobbers project config).
