# Global opencode plugins

Plugins here are **machine-level**, not project-level. `agent-harness init`/`update`
never deploy these (they live outside `templates/`); install them into opencode's
global plugin directory with:

```bash
npx opencode-agent-harness install-global        # or: node bin/agent-harness.js install-global
```

That links each `*.ts`/`*.js` here into `~/.config/opencode/plugins/` (a symlink
pointing back at this checkout, or a copy where symlinks are unavailable). Opencode
auto-loads that directory for **every** project and session. Restart the opencode
service after installing.

## Why global, not a project plugin

Some checks must run even when a project's own harness is stale — and a check
shipped inside that stale harness could never fire, because the stale copy is what
opencode loads. Only a global plugin (plus a global instruction) is
version-independent. See `harness-freshness.ts`.

## `harness-freshness.ts`

On every primary session start — again when a session is cleared/compacted — and
once per session on its first activity (a session that survives an opencode
service restart never re-fires `session.created`, so its stale verdict is
re-checked instead of outliving the restart), it compares the checkout's
`.harness.json` version to the newest harness this machine can see (the
authoritative local checkout, or the npm registry when it leads) and keeps the
checkout current — **only when that is safe for the active branch**:

| state | action |
| --- | --- |
| up to date | nothing when only metadata moved; if a file opencode loads at startup changed after this process started, writes `restart-needed` and tells the session to restart **when convenient** (the task continues) |
| linked worktree, project **main already latest**, worktree HEAD is an ancestor of main (true fast-forward), no local change overlaps the incoming files | `git merge --ff-only <main>` (never rewrites history) |
| main checkout, no drift | `agent-harness update --target <tree>` from a local checkout, otherwise `npx --yes opencode-agent-harness@<latest> update --target <tree>` (the sanctioned deploy; fails closed on locally-modified harness files) |
| anything else (main stale, branch diverged, overlapping dirty files, merge/rebase in progress, update failed) | **no mutation** — writes `.serve/harness-freshness.json` and injects a session notice so the agent relays it and waits |

A successful apply injects a one-shot `HARNESS UPDATED` notice: files on disk are
current, but opencode loads plugins once at startup, so the session must restart
the opencode service before the updated plugins take effect.

Env knobs: `AGENT_HARNESS_HOME` (authoritative checkout), `AGENT_HARNESS_FRESHNESS=dry`
(detect/report only, never apply), `AGENT_HARNESS_NO_UPDATE_CHECK=1` (skip the
registry probe), `AGENT_HARNESS_NPX` / `AGENT_HARNESS_NPM` (override the CLIs).

### Relationship to the manual deploy workflow

The plugin is a **safety net**, not a replacement for the release workflow
(`~/develop/agent-harness/AGENTS.md` step 5: after `update`-ing a project, refresh
its active worktrees). The manual step is deterministic and runs at deploy time; the
plugin only acts at session start and deliberately **blocks** (does not force) the
unsafe cases — a diverged worktree, or a stale project main. Keep both.
