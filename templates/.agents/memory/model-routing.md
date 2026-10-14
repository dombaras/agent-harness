# Model routing

This project's subagent personas run on their own models via the `model:`
frontmatter in `.opencode/agents/<name>.md`. This file documents the tiering
policy — the concrete model IDs are the source of truth in the agent files
(and `opencode.json` for the main conversation).

## Tiers (recommended — override per-project)

| Tier | Purpose | Default lane |
|---|---|---|
| reasoning (hard) | System architecture, security review | strongest reasoning |
| reasoning (plan/review) | Planning, QA architecture — an unrecoverable logic error here poisons everything downstream | strongest reasoning |
| reasoning (debug) | Error / performance / API debugging | fast frontier |
| engineering (general) | Everyday coding, mobile native, infra/devops, data, QA execution | cheap fast coder |
| content (general) | UI design, product journeys, feature registrar, docs | strong generalist |
| mechanical | Handoffs | cheap fast |
| opportunistic (free/low-cost) | Bulk exploration, repo-wide search/summarize, mechanical repetition — best-effort only, never authoritative | free/low-cost |

The reasoning tier is split by persona. Hard reasoning (architecture, security)
and plan/review (planner, qa-architect) run on the strongest reasoning model —
a planner/QA architect that makes a logic error invalidates the whole dispatch
plan, so they are priced as architects, not as coders. Debugging and general
engineering run on a fast frontier coder (cheap, strong on coding benchmarks,
better cache pricing); UI/docs/features/product content keeps the strong
generalist. The harness ships a recommended concrete mapping for each lane
(strongest reasoning → `deepseek/deepseek-v4-pro` on the **direct DeepSeek API
key**, fast frontier + engineering → `opencode-go/deepseek-v4.1-flash`, content
→ `opencode-go/gpt-5.6-luna`, mechanical → `opencode-go/glm-5.3-flash`). Change
it only by editing `.opencode/agents/<name>.md` `model:` — the `model:` label in
`.agents/skills/*/SKILL.md` is informational only and does NOT route models.

## Provider priority & fallback (Go for flash/default, direct for V4 Pro)

Flash/default tiers run through the **OpenCode Go subscription first**
(`opencode-go/*`), then the same family **direct** (`deepseek/*`) as the
pay-per-token fallback. The **V4 Pro architect tier** (`planner`,
`qa-architect`, `system-architect`, `security-engineer`) is excluded from Go
routing: it is pinned to the **direct DeepSeek API key**
(`deepseek/deepseek-v4-pro`).

| Priority | Provider | Main-tier example | Role |
|---|---|---|---|
| 1 | OpenCode Go (`opencode-go/<model-id>`) | `opencode-go/deepseek-v4.1-flash` | default for the flash/content/mechanical tiers — the $10/mo subscription quota pays for it |
| 2 | DeepSeek direct (`deepseek/<model-id>`) | `deepseek/deepseek-flash` | fallback when Go is unavailable or its usage limit is hit |

**Zen pay-as-you-go (`opencode/*`) is not part of the policy.** The only two
providers are the Go subscription and the direct DeepSeek API key — no agent,
`opencode.json` override, switch alias, or machine-read target may pin a Zen
model (`explore` included: default `opencode-go/glm-5.3-flash`).

- **V4 Pro always runs direct.** The architect tier uses
  `deepseek/deepseek-v4-pro` (direct DeepSeek API key); never re-point it at
  the Go-served Pro model.
- **Announce every fallback immediately.** Name the failed provider/model, the
  observed reason, and the provider you are switching to — in chat, before
  continuing. A fallback the user cannot see is a silent process change and is
  forbidden. Record it in the session handoff dispatch log too.
- Fall back to direct only for **availability / usage-limit** errors. A
  **funds/credit** error is a stop (below), never a fallback trigger.
- opencode reads model config once at startup and does not hot-reload it: switch
  the main conversation with the `/switch-model` command (alias `go` → Go
  default, `direct`/`deepseek` → direct fallback), and switch a persona by
  editing its `.opencode/agents/<name>.md` `model:` then restarting/re-dispatching.
  The `switch-reasoning-model.ps1` replace list is derived from its alias map, so
  any alias it can switch TO it can also switch FROM.

## Provider funds stop (hard rule — pause, announce, wait)

A provider error reporting **insufficient funds / balance / credits / quota**
(`insufficient balance`, `insufficient funds`, `out of credits`, `usage limit
reached`, HTTP 402, ...) is NOT a retry, NOT a degraded-inline condition, and NOT
a reason to silently leave the designed multi-agent process.

1. **Stop starting work** — no inline substitute for the failed persona, no
   silent re-scope, no repeated dispatch/retry of the same call.
2. **Announce immediately** in chat: which provider/model failed, the exact
   error, and the exact step left unfinished — never a vague "dispatch failed".
3. **Checkpoint** the session state into `.agents/handoffs/<feature-id>.md` so the
   work resumes exactly where it stopped.
4. **Wait** — end the turn and wait for the user's explicit *top-up done /
   continue* message. Never assume a top-up happened.
5. On the user's go-ahead, **resume from the checkpoint** (never by replaying the
   transcript) and record the pause honestly (`termination_reason` in the
   handoff).

This overrides the dispatch-failure ladder below for funds/quota errors. The
`context-guard` plugin mechanically detects such an error from **structured
failure evidence only** — a failed dispatch (the task error text), a command
that exited non-zero, or a subagent session error — attributes it with the
observed provider/model (the task result's `metadata.model` or the child
assistant message's `providerID/modelID`) and injects the stop naming that
provider/model into the next request — the top-up target is evidence, never a
guess. Reading a document that merely quotes this rule (the mandated
session-start `model-routing.md` itself, a handoff, a QA plan) is **not**
failure evidence and never trips the stop. Each detection is recorded in
`.agents/guard-events.jsonl` with `provider`/`model`.

### Opportunistic tier (free / low-cost models)

Free or near-free models are a **best-effort** lane, never an authority. Use
them for genuinely disposable work: broad exploration/searches, chunk
summarization, mechanical repetition, first-pass drafts. The built-in `explore`
subagent is the reference pin — the harness ships it as
`opencode.json` → `agents.explore.model` (default `opencode-go/glm-5.3-flash` —
the Go subscription's cheap flash model; Zen pay-as-you-go `opencode/*` is not
in the policy) and a project may repoint it, on its main persona set or not at
all.

- **Mandatory fallback.** When an opportunistic model fails, returns empty, or
  is unavailable, fall back to the persona's normal tier (retry once per the
  dispatch-failure ladder, then degrade inline and log
  `degraded: <persona> model: <reason>`). Never block a deliverable on a free
  model. **Exception:** a funds/quota error follows the provider funds stop
  above — pause and announce, never silently degrade.
- **Not for authoritative output.** Explore→summaries and mechanical edits must
  be verified by the normal tier before they count as evidence; never route a
  thinker (planner/product-manager/system-architect/qa-architect) or a persona
  whose output gates work to the opportunistic tier.
- **Privacy caveat.** Free models may be training-enabled. Never send
  confidential data, secrets, credentials, personal/customer data, or unpublishable
  source to an opportunistic model.
- **Machine-readable list** (reports classify model mix with it):
  `opportunistic_models:` in the section below.

## Per-persona enforcement

In addition to `model:`, agent files carry mechanical guardrails in their
frontmatter:

- **Thinkers** (`planner`, `product-manager`) have edit **deny-by-default** with a
  **narrow artifact write grant**: `planner` may write only
  `.agents/features/<feature>/plan.md`, `product-manager` only
  `.agents/features/<feature>/intent.md` — each writable in the main tree **or the
  feature's git worktree sibling** (`../.worktrees/**`, where every feature's doc
  chain lives) — so a thinker authors its own doc instead of forcing a
  dispatch → blocked → orchestrator-write cycle — and `bash: deny`.
  Every other path stays read-only.
- **`qa-architect`** has `permissions` deny the `shell` action (authors tests, never runs).
- **`handoff`** has `permissions` deny the `shell` action.
- **`features`** (Feature Registrar) has `permissions` deny the `shell` action — owns `BACKLOG.md` (repo root) + `.agents/features/*` **tree structure only** (scaffolding, never doc content). It does NOT author `intent`/`scope`/`plan`/`tests` and does NOT dispatch author personas — those are dispatched by the orchestrator directly.
- **`docs`** (Documentation Keeper) has `permissions` deny the `shell` action and `edit` allowing everything except harness/governance paths — owns `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `docs/**` (human-facing docs); never edits code or `.agents/**` memory.
- **Code personas** (`frontend-engineer`, `mobile-engineer`, `ui-designer`,
  `data-engineer`, `devops-engineer`, `security-engineer`, `system-architect`,
  `diagnostics-expert`) allow `edit` everywhere except governance/harness paths
  — `opencode.json`, `.harness.json`, `.opencode/**`, `.agents/**` are denied —
  so out-of-scope edits are blocked mechanically, not just by prose.
- **Deterministic personas** (`planner`, `qa-architect`, `qa-runner`, `handoff`,
  `diagnostics-expert`) pin `temperature: 0.1`.
- **`steps:`** caps iterations per persona (cost ceiling).
- **`planner` / `handoff`** are `hidden: true` (orchestration-only, not in the
  `@` menu).

## Subagent output contract

Every subagent must return a single final message with, in order:

1. **Result** — what was shipped / decided.
2. **Evidence** — commands run or files changed with observed output.
3. **Deferred & risks** — what remains and follow-ups the orchestrator must handle.

## Dispatch failure ladder (never silent)

0. **Funds/quota error** — the provider funds stop above: pause, announce, wait
   for the user's top-up-complete message. Never retry, never degrade inline,
   never silently skip.
1. Retry once (resume the same `task_id`).
2. Degrade inline on the main model and log `degraded: <persona> model: <reason>`.
3. Never silently skip or re-scope — only waive via the explicit waiver path.

## Escalation ladder (evidence-based, never by default)

Cheap/default models are the normal execution tier. Escalate a persona to a
stronger reasoning tier only on concrete evidence, in this order:

1. **Attempt** the task on its pinned (cheap) model.
2. On failure, **one targeted retry** with corrected evidence/context (see
   §Dispatch failure ladder).
3. On repeated failure, **escalate to the next tier** only when the blocker is
   one of: repeated test failures after materially different fixes, contradictory
   evidence, cross-module reasoning failure, security-sensitive ambiguity,
   unresolved concurrency/state issues, or a genuinely-blocking workaround risk.
4. **Record it** — log the escalation as `escalated: <persona> -> <tier> reason: <...>`
   in the session's dispatch log, and set the handoff's
   `- model_escalation_evidence: <persona -> tier: reason>` metadata line (or
   `none` when no escalation happened), so the cost is visible and auditable.
   `npm run report -- --cost` flags a primary session observed on an
   `escalation_models:` model with no recorded evidence.

Do NOT escalate merely because a first attempt was imperfect, the answer was
long, the task is technically complex, the agent asked for more context, or the
agent expressed uncertainty without evidence. A strong model is a scarce
resource, not a preference.

## Machine-read tier targets (gates + report)

Concrete model IDs here are **declared targets, not pins** — `test:dispatch`
accepts a model named on these lines without requiring an agent/config pin, and
`npm run report -- --cost` uses them to classify observed sessions by tier.
Everything not listed is the standard execution tier.

```
opportunistic_models: opencode-go/glm-5.3-flash
escalation_models: opencode-go/deepseek-v4-pro, deepseek/deepseek-v4-pro
fallback_models: deepseek/deepseek-flash, deepseek/deepseek-v4-flash
```

## Role-aware context (inject the minimum sufficient context)

A persona must consume only the context its role actually needs — never every
memory artifact "because it exists". The dispatch prompt carries the persona's
required reads plus the bounded task spec; the persona's `SKILL.md` lists its
own mandatory inputs. Reference map (project may override):

| Persona (class) | Required context |
|---|---|
| planner | product-principles, feature `intent.md`, flow-map, model-routing |
| product-manager | product-principles, feature `intent.md` |
| system-architect / security-engineer | stack-versions, environments, relevant flow-map |
| frontend-engineer / mobile-engineer / ui-designer | relevant product-principles, relevant flow-map, assigned feature context |
| diagnostics-expert | locations, stack-versions, relevant flow-map |
| devops-engineer / data-engineer | environments, stack-versions, assigned task context |
| qa-architect / qa-runner | flow-map, changed-surface info, QA memory |
| docs | only the product/feature info needed to produce the requested docs |
| features / handoff | BACKLOG.md + `.agents/features/*` (features); locations (handoff) |

The rule is **minimum sufficient context, not minimum possible context** — never
drop context that is required for correctness.

## Gates

- `npm run test:dispatch` — `scripts/qa/check-dispatch-config.js` verifies model
  pins, persona↔skill parity, the output-contract marker, and that this doc does
  not name a concrete model no longer pinned anywhere (doc↔config drift).
- `npm run test:governance` — `scripts/qa/governance.js` enforces the wrap-up
  dispatch log.
- `npm run test:qa-plan` — `scripts/qa/check-qa-plan.js` enforces diff coverage:
  every changed CODE path must have a covering assertion (or a waivered reason)
  in `.agents/memory/qa-plan.md` before the change is verified.
- `scripts/qa/check-qa-scripts.js` — verifies the DoD-referenced QA tier scripts
  (project-provided) are wired into `package.json`.

Run `test:dispatch` after editing any agent/skill path, and `test:qa-plan` on any
change that touches code paths.

## Gotchas

- Restart the agent CLI after editing `opencode.json` or agent files (read once at startup).
