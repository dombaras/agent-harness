# Session handoffs — one file per session

Project-owned (like all `.agents/memory/*`). This directory holds the session
handoff, **sharded**: one file per session instead of a single shared
`handoff.md`. Each concurrent session owns its own file, so two sessions (e.g.
`F-003` and `F-035`) never rewrite each other's "where we stopped" — the failure
mode where one session's wrap-up clobbers another's and its dispatch log is
silently lost.

`npm run test:governance` reads EVERY `.md` file under this directory (plus the
legacy `.agents/memory/handoff.md` if it exists) and requires each to open with a
`## Dispatch log` section containing at least one entry — so a session's dispatch
log is enforced without a shared file. An entry is a bullet line
(`- <subagent> -> <model> -> <shipped/deferred>`) **or** a markdown table data row
(`| subagent | model | shipped/deferred |`); both are accepted, so pick one.
When the log has **5+ entries**, the handoff must also carry a
`## Fan-out justification` section (or a `dispatch_justification:` line) citing
the plan's `§Fan-out review` — the 5–7 band in `orchestration.md` where fan-out
must be justified.

## Naming & ownership

- One file per session. Name it after the `BACKLOG.md` feature ID (`F-003.md`),
  or a short hyphenated slug of the change (`return-no-condition.md`) when there
  is no feature row.
- **Own your file; never edit another session's file.** That single rule removes
  the collision. To resume a past session, READ its file; to continue the same
  feature in a new session, append a new dated `##`-block — never reorder or
  delete another session's entries.

## Template

    # Where we stopped (handoff) — <feature-id or slug>

    Date: <YYYY-MM-DD>

    ## Dispatch log
    - <subagent → model → shipped/deferred> (empty log = non-compliant session)

    ## Fan-out justification (required when the dispatch log has 5+ entries)
    - <why each dispatch is distinct/necessary — cite the plan's §Fan-out review>

    ## Retries (only when a persona was retried)
    - <persona>: <count> — <what changed on the last retry>

    ## Escalations (only when a persona was escalated)
    - <persona> -> <tier> reason: <evidence> attempt: <n>

    ## Session metadata (structured — record what is known, never fabricate)
    - work_type: <feature|bugfix|investigation|architecture|planning|qa|security|maintenance|process|conversation|other>
    - outcome: <shipped|resolved|deferred|investigation-complete|abandoned|superseded|conversation-only>
    - termination_reason: <gate-pass|checkpoint|blocked|escalated|abandoned|unknown>
    - checkpoint_count: <n> (omit when 0)

    ## Value shipped
    - <1-2 plain sentences: what the user now gets and why it matters — no file paths, no tech jargon>

    ## How (main points)
    - <the key approach in a sentence or two — the "how", not a file manifest>

    ## Done this session (planned → shipped → deferred)
    - <planned → shipped → deferred, one line each, with file + commit refs>

    ## Still open / next
    - <deferred items + next-session entry point>

Lines starting with `#` are ignored by the gate.
