# OpenCode V2 event-stream remap — implementation plan

**Status:** planned, not started. Written 2026-10-14 against harness **0.1.159**
(commit `335a5c0`), OpenCode **2.0.29**.

**Purpose:** this is the *whole* plan. A fresh context should be able to execute it
top to bottom without re-deriving anything. Every V2 fact below was verified
against the running server and the published `@opencode/*@2.0.29` type
definitions; do not re-research what is written here. Line numbers are as of
commit `335a5c0`.

**Why:** the 0.1.157 port moved the plugin `event` hook to `ctx.event.subscribe()`
but carried the **V1 event contract** (event *names* and the `event.properties`
payload) across unchanged. V2's server API is one of the three documented breaking
changes, so this is in-scope for the port and it silently disables the
context-guard's session/telemetry half and the whole `harness-freshness` safety
net. The 424-test suite misses it because its fake event stream still emits the V1
shape.

---

## 1. Verified V2 facts (do not re-derive)

### 1.1 The event envelope has no `properties`

Captured from inside a plugin via its own `ctx.event.subscribe()`:

```
keys: ["id","created","type","durable","location","data"]      ← no "properties"
```

`event.properties` is always `undefined`. The payload is **`event.data`**.

### 1.2 Event names changed (only these matter to the harness)

| V1 name (used today) | V2 name | Notes |
|---|---|---|
| `session.created` | `session.created` | same name, different payload |
| `session.updated` | *(does not exist)* | child `parentID` arrives on `session.created` |
| `session.deleted` | `session.deleted` | same name, `data.sessionID` |
| `message.updated` | *(does not exist)* | use `session.step.ended` / `session.usage.updated` |
| `file.watcher.updated` | `filesystem.changed` | `data.file`, `data.event` — see §5.3 caveat |
| `session.error` | `session.execution.failed` | `data.sessionID`, `data.error` |

Verified: `grep -c '"session.updated"'` over the generated client types is **0**;
`message.updated`, `file.watcher.updated` and `session.error` likewise do not
exist. The full V2 type union is `V2Event` in
`opencode-client-2.0.29/dist/promise/generated/types.d.ts` (see §9).

### 1.3 Exact payloads (captured live, 2.0.29)

```json
// session.created — primary
{"sessionID":"ses_…","projectID":"…","location":{"directory":"/abs/path"},
 "subpath":"","slug":"calm-falcon","title":"…","model":{"id":"…","providerID":"…","variant":"…"},"version":"2.0.29"}

// session.created — subagent child (parentID is what marks a child)
{"sessionID":"ses_…","projectID":"…","location":{"directory":"/abs/path"},
 "subpath":"","parentID":"ses_PARENT","slug":"sunny-otter","title":"child","version":"2.0.29"}

// session.deleted
{"sessionID":"ses_…"}

// session.model.selected
{"sessionID":"ses_…","model":{"id":"…","providerID":"…"},"previous":{…}}

// session.step.started   (one model call)
{"sessionID":"ses_…","assistantMessageID":"msg_…","agent":"build",
 "model":{"id":"deepseek-v4.1-flash","providerID":"opencode-go","variant":"default"},"started":…}

// session.step.ended     ← the V2 analogue of V1's `message.updated`
{"sessionID":"ses_…","assistantMessageID":"msg_…","finish":"stop","rawFinish":"stop",
 "cost":0.00062,"tokens":{"input":4119,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}

// session.usage.updated   (fires at admission + per usage change)
{"sessionID":"ses_…","cost":…,"tokens":{"input":523,"output":8,"reasoning":0,"cache":{"read":0,"write":0}}}

// session.execution.failed / session.step.failed
{"sessionID":"ses_…","error":{"type":"…","message":"…","status":402,"response":{"body":"…"}}}

// session.inbox.enqueued / session.inbox.delivered
{"sessionID":"ses_…","inboxID":"msg_…","item":{"type":"user","payload":{"text":"…"},"delivery":"steer"}}
```

Key point: **`data.tokens` is exactly `TokenUsageInfo`** = `{ input, output,
reasoning, cache: { read, write } }` — i.e. the very shape
`context-guard-core.js#requestTokensOf()` already reads. The pure core needs **no
change**; only the plugin's event plumbing does.

`ModelRef` is `{ id, providerID, variant? }`, while `guard.modelLabel()` reads
`info.providerID` + (`info.modelID` || `info.model`). So a V2 `ModelRef` must be
mapped to `{ providerID, modelID: id }` before being passed to `modelLabel`.

### 1.4 V2 `context`/tool hooks — already correct, leave alone

Verified live in an isolated project:

* `ctx.tool.transform` + JSON-Schema `input` + `{ content }` execute → tool
  registered and listed (`tools=22 has=true`).
* `execute.before` mutation of `event.input` **reaches the executor** — a probe
  that rewrote `event.input.workdir` *and* `.command` changed what ran.
* `ctx.tool.hook("execute.before")` events carry `{ tool, sessionID, agent,
  messageID, id, input }`; `execute.after` carries `{ …same…, status:
  "completed", result }` or `{ status: "error", error: Tool.Error }`.
* `ctx.session.hook("context")` event is `SessionContext` =
  `{ sessionID, agent, model, system, messages, options, tools }`.
* `ctx.session.prompt({ sessionID, text })` exists (used by `job-notify`).

So the only broken surface is the `event` stream.

---

## 2. Findings (severity ordered)

### P0-1 — `context-guard.ts` `hooks.event` is dead
`templates/.opencode/plugins/context-guard.ts` lines **359–473**.

| Current code | Line | Reality |
|---|---|---|
| `const props = event?.properties \|\| {}` | 363 | no such field → `props = {}` |
| `type === "session.created" \|\| type === "session.updated"` | 365 | `session.updated` does not exist |
| `props.info?.id` / `props.info.parentID` | 366, 369 | `data.sessionID` / `data.parentID` |
| `writeLease(props.info.id)` | 370 | never runs |
| `file.watcher.updated` | 404 | renamed `filesystem.changed` |
| `message.updated` | 409 | does not exist |
| `session.error` | 461 | renamed `session.execution.failed` |

**Consequences**
1. `writeLease` is only reachable here → leases now arise opportunistically from
   `touchLease` on the first tool call, not at session start.
2. `clearLease` on `session.deleted` never runs → leases linger up to the 4 h
   heartbeat window → `test:concurrency` / the branch-switch guard can see
   **phantom live sessions**.
3. `childSessions`/`childParent` are never populated → **`isPrimary()` returns
   true for every subagent session**: children take leases, and the tool-choice
   blocks (`inspectBlockText`/`pollBlockText`) fire per *persona* instead of per
   orchestrator. `armFunds`'s `primaryRoot()` walk degenerates to the child.
4. No `syncBoard()`, no `collectOrient()` → the advertised session-start orient
   brief never appears (its test passes only because it feeds a V1 event).
5. No `noteAssistant` → turn count, context band, request-token band, no-state
   detector all dead.
6. Thresholds never reloaded when `orchestration.md` changes.
7. The funds stop survives only via the `execute.after` path; session-level
   provider failures no longer arm it.

**Live proof:** creating a session with `location.directory =
~/develop/PublicVirtualLibrary` wrote **no** `.serve/sessions/<id>.json` and **no**
`.agents/guard-events.jsonl` line (that file's mtime is still 2026-10-09, pre-port).

### P0-2 — `harness-freshness.ts` is dead
`contrib/global-plugins/harness-freshness.ts` lines **267–283**
(`(event as any)?.properties?.info?.id` / `?.info`). This is the machine-level
safety net that refreshes a stale worktree/main checkout at session start; it now
never evaluates anything. Registered ≠ working.

### P0-3 — the tests lock the V1 contract
`tests/agent-harness.test.js` `loadGuardPlugin()` (from line **5432**) and 16
`emit()` call sites assert `{ type, properties: { info: { id } } }`
(lines 5529, 5532, 5566, 5577, 5595, 5638, 5672, 5686, 5700, 5716, 5735, 5755,
5796, 5876, 5899). This is why 424/424 pass over dead code.

### P1-1 — `convertV1Permission` is incomplete
`bin/agent-harness.js` line **331**. Maps `bash → shell` but not the other
renamed actions from the migration guide: `write`/`patch → edit`,
`task → subagent`. A project that ever had those in a V1 `permission` map gets
inert rules (unknown actions never match) — a silent governance hole. The
harness's own template never emitted them, so this is defensive only.

### P1-2 — doc/prose drift
* `templates/docs/mcp-integrations.md` — leftover V1 sentence:
  *"so the glob is `"<server>*": false` / `true`"* (V1 `tools` disable),
  contradicting the V2 `permissions` example directly above it.
* `templates/docs/mobile-testing.md` line 6 — prose says the agent's
  `` `bash` `` tool; V2 names it `shell`.
* `context-guard.ts` line 14 — header comment still describes
  `experimental.chat.messages.transform` (the code below is correctly migrated).
* `docs/opencode-v2-migration.md` §5/§13/§16 claim the port is verified; they must
  record that the event layer was missed and is fixed here.
* Repo's own `opencode.json` omits `agents.explore.steps: 40` (present in
  `templates/opencode.json`) → the harness repo's own `explore` agent is uncapped.

### P2-1 — 15 persona skills are advertised on every request
V2 discovers `.agents/skills/` as *project compatibility* skills, so all 15
`SKILL.md` descriptions enter the model's available-skills list at every step
(the port's own §10 notes this and accepted it). They are **persona definitions**
read with the `read` tool, never invoked through the `skill` tool. Only
`.opencode/skills/{dev-loop,bounded-explore}` are genuine `skill`-tool targets
(`AGENTS.md` names them). Hiding the 15 removes a per-request prefix cost.

### P2-2 — per-agent `request.body.temperature` is a documented no-op
The V2 agents page warns that `request.body` is preserved but **not sent**, and
now says: "Configure active request settings on the provider, model, or model
variant instead." The `temperature: 0.1` blocks in 7 agent files are dead config
that reads like enforcement. Decide: drop, or express as a model variant.

---

## 3. Work item W1 — rewrite `context-guard.ts` `hooks.event`

**File:** `templates/.opencode/plugins/context-guard.ts`
**Delete:** lines 359–473 (the whole `event: async ({ event }: any) => {…}` member).
**Insert:** the block below (same position: first member of the `hooks` object
literal, immediately before `"tool.execute.before"`).

Also add the `modelFields` helper above `const hooks = {`:

```ts
  /* V2 ModelRef ({ id, providerID, variant }) -> the shape `guard.modelLabel`
   * reads ({ providerID, modelID }). Never invent a label. */
  const modelFields = (m: any) =>
    m && typeof m === "object" ? { providerID: m.providerID, modelID: m.id } : null
```

Replacement `hooks.event`:

```ts
    event: async ({ event }: any) => {
      try {
        // V2 event envelope: { id, created, type, location, data }. The payload is
        // `event.data` — V1's `event.properties` does NOT exist in V2 — and several
        // event NAMES changed (session.updated, message.updated, file.watcher.updated
        // and session.error are gone). See docs/opencode-v2-event-remap-plan.md.
        const type = event?.type
        const d = event?.data || {}

        if (type === "session.created") {
          const sid = d.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          if (d.parentID) {
            // A subagent dispatch. Track it so the guard never treats a persona
            // session as the primary orchestrator (leases, tool blocks, and funds
            // attribution all key off isPrimary/primaryRoot). A CHILD's
            // session.created carries no `model`, so its funds label comes from
            // `session.step.started` below.
            childSessions.add(sid)
            childParent.set(sid, d.parentID)
            return
          }
          const label = guard.modelLabel(modelFields(d.model))
          if (label) sessionModel.set(sid, label)
          writeLease(sid)
          syncBoard()
          const root =
            typeof d.location?.directory === "string" && d.location.directory
              ? d.location.directory
              : directory
          void collectOrient(sid, root)
          return
        }

        /* Per-step model capture. V1 stored the label from every assistant message
         * (including children, which is what `armFunds`'s fallback needs); in V2 a
         * child's `session.created` omits `model`, so `session.step.started` — which
         * carries `{ agent, model }` for every session — is the reliable source. */
        if (type === "session.step.started") {
          const sid = d.sessionID
          const label = guard.modelLabel(modelFields(d.model))
          if (typeof sid === "string" && sid.length > 0 && label) sessionModel.set(sid, label)
          return
        }

        // Keeps the funds-stop label current when the user switches model mid-session.
        if (type === "session.model.selected") {
          const sid = d.sessionID
          const label = guard.modelLabel(modelFields(d.model))
          if (typeof sid === "string" && sid.length > 0 && label) sessionModel.set(sid, label)
          return
        }

        if (type === "session.deleted") {
          const id = d.sessionID
          if (id) {
            clearLease(id)
            childSessions.delete(id)
            childParent.delete(id)
            sessionModel.delete(id)
            sessions.delete(id)
            // Auto-close this session's long-lived serves (dev server/emulator):
            // the harness must not leave them orphaned after the session ends.
            // Detached + best-effort; `reap` never touches a live owner's serve.
            try {
              const serve = path.join(directory, "scripts", "serve.js")
              if (fs.existsSync(serve)) {
                spawn(process.execPath, [serve, "reap"], {
                  cwd: directory,
                  detached: true,
                  stdio: "ignore",
                }).unref()
              }
            } catch {
              /* reaping is best-effort */
            }
          }
          return
        }

        // One model call == one assistant message == one orchestrator turn. This is
        // the V2 replacement for V1's `message.updated` (which no longer exists);
        // `data.tokens` is the same TokenUsageInfo the pure core already reads.
        if (type === "session.step.ended") {
          const sid = d.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          if (!isPrimary(sid)) return
          touchLease(sid)
          const note = guard.noteAssistant(
            stateFor(sid),
            {
              id: d.assistantMessageID,
              sessionID: sid,
              role: "assistant",
              tokens: d.tokens,
            },
            loadThresholds()
          )
          // Not gated on `newTurn`: a token-band crossing must be logged whenever it
          // actually changes.
          if (note.bandChanged && note.band) {
            logEvent({ kind: "band", sessionID: sid, band: note.band, turn: note.turns })
            await report(`turn ${note.turns}: ${note.band} band`)
          }
          if (note.requestChanged && note.requestLevel) {
            logEvent({
              kind: "request",
              sessionID: sid,
              level: note.requestLevel,
              tokens: note.requestTokens,
            })
          }
          if (note.noStateChanged) {
            logEvent({
              kind: "no_state",
              sessionID: sid,
              turn: note.turns,
              noStateTurns: note.noStateTurns,
            })
            await report(`turn ${note.turns}: no material state change across several turns`)
          }
          return
        }

        // V2 renamed `session.error`. A failed dispatch reports its own provider/
        // model on the structured error; capture it even for child sessions so the
        // funds stop is armed on the session the user actually sees.
        if (type === "session.execution.failed" || type === "session.step.failed") {
          const sid = d.sessionID
          if (typeof sid !== "string" || sid.length === 0) return
          const text = JSON.stringify(d.error ?? d)
          if (!guard.fundsError(text)) return
          const label = guard.modelLabel(d.error) || sessionModel.get(sid) || null
          await armFunds(sid, label, type)
          return
        }
      } catch {
        /* the guard must never break a session */
      }
    },
```

**Behaviour deltas to expect (intentional):**
* `session.deleted` → `clearLease` + `serve.js reap` now actually run (they didn't).
* Subagent sessions stop being treated as primary.
* Turn counting now comes from `session.step.ended`; `session.usage.updated` is
  deliberately *not* used for turns (it also fires at admission, before any
  assistant message).

---

## 4. Work item W2 — release the funds stop on real user input

V1 released the stop when a `message.updated` with `role: "user"` arrived. That is
part of the dead handler. Replace it with the **session `prompt` admission hook**,
which V2 documents as firing exactly for user prompts and commands that submit
through `session.prompt` (not for synthetic/shell/compaction/move messages).

**File:** `templates/.opencode/plugins/context-guard.ts`, in the `// ---- V2
registration ----` block (lines 924–956), alongside the other `ctx.*.hook` calls.

Add:

```ts
  await ctx.session.hook("prompt", (event: any) => {
    try {
      // A real user turn releases the provider funds stop (the top-up-complete
      // message). This is the V2 replacement for the dead `message.updated`
      // role==="user" branch. Synthetic/shell/compaction submissions do not fire
      // this hook, so the stop cannot be cleared by the harness's own traffic.
      const sid = event?.sessionID
      if (!isPrimary(sid)) return
      const state = stateFor(sid as string)
      state.fundsPending = false
      state.fundsNotice = null
    } catch {
      /* never break a prompt */
    }
  })
```

Note: with W1 in place, `isPrimary()` correctly excludes subagent sessions, so a
persona's own prompt cannot clear the orchestrator's stop.

---

## 5. Work item W3 — threshold reload without the event watcher

### 5.1 Problem
`loadThresholds()` (lines 111–121) caches `thresholds` and is only invalidated by
the dead `file.watcher.updated` branch. V1's watcher event name no longer exists.

### 5.2 Chosen fix (deterministic, no watcher dependency)
Make the cache mtime-aware. Replace lines **58** and **111–121**:

```ts
  let thresholds: any = null
  let thresholdsMtime = -1
  const ORCHESTRATION_ABS = path.join(directory, ORCHESTRATION_REL)

  /* Read `.agents/memory/orchestration.md` once and cache it, re-reading whenever
   * the file's mtime changes. This replaces V1's `file.watcher.updated` branch
   * (that event name does not exist in V2): a plain stat is cheaper than relying on
   * an event we have not observed firing in 2.0.29, and it cannot go stale. */
  const loadThresholds = () => {
    let mtime = -1
    try {
      mtime = fs.statSync(ORCHESTRATION_ABS).mtimeMs
    } catch {
      /* missing/unreadable -> documented defaults from the core */
    }
    if (thresholds && mtime === thresholdsMtime) return thresholds
    let text = ""
    try {
      text = fs.readFileSync(ORCHESTRATION_ABS, "utf8")
    } catch {
      /* missing/unreadable -> documented defaults from the core */
    }
    thresholds = guard.parseThresholds(text)
    thresholdsMtime = mtime
    return thresholds
  }
```

Delete the `if (type === "file.watcher.updated") { … thresholds = null }` branch
(lines 404–407) — it is superseded. (Do **not** add a `filesystem.changed`
handler: see §5.3.)

### 5.3 Caveat recorded for the record
`filesystem.changed` **exists** in the 2.0.29 manifest
(`data: { file: string, event: "add"|"change"|"unlink" }`, `durability:
"ephemeral"`) and is the nominal rename of `file.watcher.updated`, but it did
**not** fire in an isolated probe project even for add/change/unlink events in
the location (with the location activated and a plugin subscribed). Do not build
on it unless a probe in a real project shows it firing.

---

## 6. Work item W4 — fix `harness-freshness.ts`

**File:** `contrib/global-plugins/harness-freshness.ts`, loop at lines 262–291.

Replace the body of the `for await` loop:

```ts
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            // V2 envelope: the payload is `event.data` (V1's `event.properties` does
            // not exist). A child session carries `data.parentID`.
            const d: any = (event as any)?.data || {}
            if (event?.type === "session.deleted") {
              const sid = d.sessionID
              if (typeof sid === "string" && sid) {
                notices.delete(sid)
                checked.delete(sid)
              }
              continue
            }
            if (event?.type !== "session.created") continue
            const sid = d.sessionID
            if (typeof sid !== "string" || !sid) continue
            if (d.parentID) continue // child/subagent session
            if (checked.has(sid)) continue
            checked.add(sid)
            const dir =
              typeof d.location?.directory === "string" && d.location.directory
                ? d.location.directory
                : ctx.location.directory
            await evaluate(sid, dir)
          } catch (err: any) {
            report(`check failed: ${err?.message || err}`, "warn")
          }
        }
      } catch (err: any) {
        if (!controller.signal.aborted) report(`event stream failed: ${err?.message || err}`, "warn")
      }
    })()
```

The `session.hook("context", …)` block below it (lines 293–316) is already correct
— leave it.

---

## 7. Work item W5 — tests

**File:** `tests/agent-harness.test.js`.

### 7.1 Rewrite the fixtures (mechanical)

`loadGuardPlugin()` (line 5432) needs no signature change — only the call sites.

| Line | Old | New |
|---|---|---|
| 5529, 5595, 5638, 5672, 5700, 5716, 5735, 5755, 5796, 5876, 5899 | `{ type: "session.created", properties: { info: { id: SID } } }` | `{ type: "session.created", data: { sessionID: SID, location: { directory: <that test's directory> } } }` |
| 5577–5580 | `{ type: "session.created", properties: { info: { id: "ses_guard_child", parentID: sid } } }` | `{ type: "session.created", data: { sessionID: "ses_guard_child", parentID: sid } }` |
| 5686 | `properties: { info: { id: relaxed } }` | `data: { sessionID: relaxed }` |
| 5532–5535, 5566–5569 | `{ type: "message.updated", properties: { info: { id: "m"+i, role: "assistant", sessionID: sid } } }` | `{ type: "session.step.ended", data: { sessionID: sid, assistantMessageID: "m"+i } }` |

For the two `session.created` emits in tests that use `tmpdir()` without a deploy
(e.g. 5526, 5586), a `data.location` is optional (`collectOrient` falls back to
`directory`), but include it where the test's intent is session-start behaviour.
For the orient test (5632, an `h.deploy()` target) keep the fallback path.

**Note on 5566–5569 ("Crossing the next band updates the tail"):** the loop there
must now emit `session.step.ended` too — same substitution as above.

### 7.2 New test — a V2 `session.created` actually arms the guard

Place next to the other `loadGuardPlugin` tests (after ~5630):

```js
test("context-guard: a V2 session.created writes a lease and marks a child as non-primary", async () => {
  const target = tmpdir();
  const g = await loadGuardPlugin({ directory: target });
  const parent = "ses_v2_parent";

  await g.emit({
    type: "session.created",
    data: { sessionID: parent, location: { directory: target } },
  });
  const lease = path.join(target, ".serve", "sessions", `${parent}.json`);
  assert.ok(fs.existsSync(lease), "the plugin wrote a session lease from the V2 event payload");
  assert.strictEqual(JSON.parse(fs.readFileSync(lease, "utf8")).sessionID, parent);

  // A child session must NOT be treated as a primary orchestrator.
  await g.emit({ type: "session.created", data: { sessionID: "ses_v2_child", parentID: parent } });
  // The first pure inspection is blocked for a primary session...
  await assert.rejects(
    g.toolBefore("shell", parent, { command: "cat src/a.ts" }),
    /TOOL BLOCK/
  );
  // ...but never for a child/subagent session.
  await g.toolBefore("shell", "ses_v2_child", { command: "cat src/a.ts" });
});
```

### 7.3 New drift guard (this is the one that would have caught the original bug)

Add near the other `[drift-guard]` tests:

```js
test("[drift-guard] event-stream plugins read event.data, never V1 event.properties", () => {
  const files = [
    path.join(h.TEMPLATES_DIR, ".opencode", "plugins", "context-guard.ts"),
    path.join(__dirname, "..", "contrib", "global-plugins", "harness-freshness.ts"),
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (!src.includes("event.subscribe")) continue;
    assert.doesNotMatch(
      src,
      /event\??\.properties/,
      `${path.basename(f)}: V2 event envelopes have no \`properties\` field (payload is \`event.data\`)`
    );
    assert.doesNotMatch(
      src,
      /"message\.updated"|"file\.watcher\.updated"|"session\.updated"|"session\.error"/,
      `${path.basename(f)}: that V1 event name does not exist in V2`
    );
  }
});
```

(The second `doesNotMatch` is regex-safe because the JSON-Schema `properties:` keys
used by the tool plugins are bare identifiers, not quoted event names.)

### 7.4 Delete the now-obsolete test
`"context-guard refreshes request tokens on a repeat emit of the same message id"`
(line 5067) tests the pure core (`guard.noteAssistant`) directly, **not** the
plugin — keep it. Only the plugin-level `message.updated` fixtures change.

### 7.5 Run

```bash
npm run lint && npm test     # expect 424 passing + the 2 new tests, 0 failing
```

---

## 8. Work items W6–W9 (P1/P2)

### W6 — `convertV1Permission` completeness
`bin/agent-harness.js` line 331. Change the action map:

```js
function convertV1Permission(v1) {
  const out = [];
  if (!v1 || typeof v1 !== "object" || Array.isArray(v1)) return out;
  // V1 -> V2 action renames (docs/opencode-v2-migration: "Permission actions also
  // changed"). Unmapped V1 actions would produce rules that can never match.
  const ACTION = { bash: "shell", task: "subagent", write: "edit", patch: "edit" };
  for (const [action, rule] of Object.entries(v1)) {
    const actionName = ACTION[action] || action;
    if (rule && typeof rule === "object" && !Array.isArray(rule)) {
      for (const [resource, effect] of Object.entries(rule)) {
        if (typeof effect === "string") out.push({ action: actionName, resource, effect });
      }
    } else if (typeof rule === "string") {
      out.push({ action: actionName, resource: "*", effect: rule });
    }
  }
  return out;
}
```

Extend the existing V1→V2 convergence test (line ~568) with a `write`/`patch`/`task`
case asserting the emitted rules use `edit`/`subagent`.

### W7 — doc/prose drift
1. `templates/docs/mcp-integrations.md`: delete/replace the stale bullet
   *"MCP tools are registered prefixed by the server name (`pg_*`), so the glob is
   `"<server>*": false` / `true`."* → state the V2 form (action `<server>_*`, or
   `<server>*` if action wildcards match — the file already uses the V2 rule above).
2. `templates/docs/mobile-testing.md` line 6: `` `bash` `` → `` `shell` ``.
3. `context-guard.ts` line 14: `${...}` header comment →
   "injected into the conversation TAIL via the V2 `context` session hook".
4. `opencode.json` (harness repo root): add `"steps": 40` to `agents.explore` to
   match `templates/opencode.json`.
5. `docs/opencode-v2-migration.md`: add a **§17** recording this fix (the event
   contract was missed; list the V1→V2 event mapping table from §1.2/§1.3 here),
   and correct §13/§16's "verified" claims (they covered load + config gates, not
   event behaviour).

### W8 — hide the 15 persona skills from the model's skill list (P2)
For each `templates/.agents/skills/<persona>/SKILL.md`, add to the frontmatter:

```yaml
metadata:
  opencode/autoinvoke: false
```

Keep `.opencode/skills/dev-loop/SKILL.md` and
`.opencode/skills/bounded-explore/SKILL.md` **advertised** (they are invoked via
the `skill` tool by `AGENTS.md`).

Verify after deploy: `opencode api get '/api/skill?location[directory]=<project>'`
should still list all 21 (the 15 personas stay registered and loadable by ID); they
simply leave the model's *available* list. Their personas read the file directly
with `read`, so nothing in the flow changes. (To confirm the advertised-vs-registered
split from a session, `session.instructions.updated` / the model's skill list is the
advertised set.)

### W9 — decide on `request.body.temperature` (P2)
7 agent files carry `request: { body: { temperature: 0.1 } }`
(`diagnostics-expert`, `docs`, `features`, `handoff`, `planner`, `product-manager`,
`qa-architect`, `qa-runner`). It is a documented V2 no-op. Default
recommendation: **drop** the blocks and note the deletion in the migration doc;
alternatively move determinism to a model variant. Removing them also removes a
false impression of enforcement. (Ask the user before choosing; both are
acceptable.)

---

## 9. Reference appendix

### 9.1 Where the V2 contracts live (re-derive if the cache is gone)

```bash
mkdir -p /tmp/opencode/ocp && cd /tmp/opencode/ocp
npm pack @opencode/plugin@2.0.29 @opencode/schema@2.0.29 \
         @opencode/ai@2.0.29 @opencode/client@2.0.29
for f in *.tgz; do tar xzf "$f"; done
```

* Event union / payloads:
  `opencode-client-2.0.29/dist/promise/generated/types.d.ts` → `export type V2Event`
  (search `SessionCreated`, `SessionStepEnded`, `SessionExecutionFailed`,
  `FilesystemChanged`, `TokenUsageInfo`, `ModelRef`).
* Tool hook events: `opencode-plugin-2.0.29/dist/promise/tool.d.ts` → `ToolHooks`.
* Session hooks: `opencode-plugin-2.0.29/dist/promise/session.d.ts` →
  `SessionHooks`, `SessionContext`, `SessionPrompt`.
* `Tool.Result` / `Tool.Error`: `opencode-schema-2.0.29/dist/tool.d.ts`.
* `Message` (context hook `messages` element): `opencode-ai-2.0.29/dist/schema/messages.d.ts`.

`@opencode/cli@2.0.29` is installed at
`/usr/local/lib/nodejs/node-v24.20.0-linux-x64/lib/node_modules/@opencode/cli`.

### 9.2 Probe recipes (how the facts above were obtained)

```bash
# 1. Event envelope + names.  /tmp/opencode/probe/.opencode/plugins/probe.ts
#    subscribes to ctx.event.subscribe and appends {keys,type,data,properties}
#    to /tmp/opencode/probe-events.log, then:
cd /tmp/opencode/probe
opencode api get '/api/plugin?location[directory]=/tmp/opencode/probe'   # activates the location
opencode api post /api/session --data '{"title":"t","location":{"directory":"/tmp/opencode/probe"}}'
cat /tmp/opencode/probe-events.log

# 2. A real turn (tokens/step events):
cd /tmp/opencode/probe && opencode run --model opencode-go/deepseek-v4.1-flash "Reply with one word: hello"

# 3. Child sessions (parentID):
opencode api post /api/session --data '{"title":"child","parentID":"<parent>","location":{"directory":"/tmp/opencode/probe"}}'

# 4. Permission semantics (global relative edit deny, agent-level deny/narrow grant):
#    write a probe project opencode.json + `opencode run --agent <id> "…"`.
```

### 9.3 Live checks against a deployed project

```bash
P=~/develop/PublicVirtualLibrary
opencode api get "/api/plugin?location[directory]=$P"   # local plugins: 11 (10 + global)
opencode api get "/api/agent?location[directory]=$P"    # 22 agents
opencode api get "/api/skill?location[directory]=$P"    # 21 on this machine: 15 persona
#   (.agents/skills) + dev-loop + bounded-explore (.opencode/skills) + 2 global
#   user skills + 2 built-in
```

---

## 10. Release & deploy (per `AGENTS.md`)

```bash
# 1. Version bump (the version-bump test enforces it): 0.1.159 -> 0.1.160
#    package.json only.
# 2. Gates
cd ~/develop/agent-harness && npm run lint && npm test
# 3. Commit + push
git add -A && git commit -m "fix: remap the plugin event stream to the V2 payload (data, not properties) and restore the guard rails (0.1.160)" && git push origin main
# 4. Deploy both active projects from THIS WSL checkout
node ~/develop/agent-harness/bin/agent-harness.js update --target ~/develop/PublicVirtualLibrary
node ~/develop/agent-harness/bin/agent-harness.js update --target /mnt/c/develop/FamilyBudget
# 5. Refresh every ACTIVE worktree of each project (see AGENTS.md §5) — do NOT run
#    `update --target <worktree>` (it rewrites {{WORKSPACE_ROOT}} in opencode.json).
for wt in $(git -C ~/develop/PublicVirtualLibrary worktree list --porcelain | awk '/^worktree /{print $2}' | tail -n +2); do
  git -C "$wt" merge --ff-only origin/main || echo "MANUAL: $wt"
done
```

Then run the project's own gates in each deployed project:
`npm run test:dispatch`, `npm run test:prefix`, and `agent-harness doctor --target .`.

---

## 11. Verification checklist (post-fix)

- [ ] `npm run lint && npm test` green on the harness (424 + 2 new).
- [ ] **Restart OpenCode** (`opencode service restart`) so the server reloads the
      global + project plugins, then `opencode api get /api/info`.
- [ ] Deployed project: `/api/plugin` still shows all 11 local plugins `active`.
- [ ] **Lease proof:** create a session with
      `location.directory=<project>` via `/api/session`, then assert
      `<project>/.serve/sessions/<sessionID>.json` now exists (it does NOT today).
- [ ] **Guard-log proof:** with that session, assert a `kind:"orient"` line lands in
      `<project>/.agents/guard-events.jsonl` (mtime advances past 2026-10-09).
- [ ] **Child tracking:** dispatch a subagent in a scratch session and confirm the
      child does NOT appear in `.serve/sessions/` (only primaries).
- [ ] **Freshness proof:** in a deliberately stale worktree, start a session and
      confirm `harness-freshness` logs its evaluation / writes
      `<tree>/.serve/harness-freshness.json`; use `AGENT_HARNESS_FRESHNESS=dry` to
      avoid mutating.
- [ ] **Turn telemetry:** after a real multi-turn session, confirm `kind:"band"` /
      `kind:"request"` guard events appear (today: zero).
- [ ] **Funds release:** hard to trigger safely; at minimum assert with a unit test
      that `ctx.session.hook("prompt")` clears `fundsPending` on a primary session
      and is a no-op on a child.
- [ ] `docs/opencode-v2-migration.md` §17 records the mapping and the corrected
      verification claims.
- [ ] Watch for turn-count inflation from `session.step.ended` firing for
      `title`/`compaction`/`generate` steps: if the band fires too early, record the
      `agent` from `session.step.started` (keyed by `assistantMessageID`) and skip
      `session.step.ended` for the hidden `title`/`compaction` agents.

---

## 12. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `session.step.ended` counts auxiliary (title/compaction) steps as orchestrator turns | Kept parity with V1 (which counted all assistant messages). If inflation shows, filter via `session.step.started.agent`. |
| A hook throwing breaks sessions | Every new branch is inside the existing swallow-everything `try/catch`; the `prompt` hook has its own `try/catch`. |
| `session.created` arriving after the first tool call (lease race) | `touchLease` re-creates a missing lease, so the tool path is a safety net either way. |
| Tests depend on real `h.deploy` + spawned `orient.js` (slow) | Reuse the existing orient test's pattern; keep the new lease/child test on a bare `tmpdir()`. |
| Deploy rewrites `{{WORKSPACE_ROOT}}` in a worktree | Never `update --target <worktree>`; fast-forward worktrees with `git merge --ff-only`. |

## 13. Out of scope (deliberate)

- `services/board` (standalone Next.js service, not the OpenCode API).
- Historical point-in-time docs (`docs/backlog-integrity-fixes.md`,
  `docs/cost-optimization-*.md`, `docs/adr-board-service.md`).
- The `.opencode/package.json` (`@opencode-ai/plugin`) leftovers in deployed
  projects — project-side and unused in V2.
