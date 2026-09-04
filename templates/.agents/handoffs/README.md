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
log is enforced without a shared file.

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

    ## Done this session (planned → shipped → deferred)
    - <planned → shipped → deferred, one line each, with file + commit refs>

    ## Still open / next
    - <deferred items + next-session entry point>

Lines starting with `#` are ignored by the gate.
