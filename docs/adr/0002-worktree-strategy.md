# ADR 0002 — Keep `git worktree` as the feature-isolation primitive

Status: accepted

## Context

OpenCode 2.3.2 added a native worktree surface: the `worktree.directory`
config key, a plugin `ctx.worktree` domain (`transform`/`add`/`list`/`create`/
`remove`), and `opencode run --worktree [=name]`. The harness still shells out
to `git worktree` and keeps its own convention, `<repo>/../.worktrees/<repo>/<id>`
([F-015](../../BACKLOG.md), scan §G3).

The harness flow is not just "make a checkout". `backlog worktree <id>` creates
a **named branch** off `origin/main`, records path + branch in the board row's
Handoff cell, runs `scripts/worktree-setup.js` in the new tree, leases the
checkout to the session, and `archive` removes the worktree plus its merged
branch. `check-worktrees` and `worktree-prune` guard every linked checkout,
including ones a live session is standing in.

The native surface differs in ways that matter here:

- Native creation is `git worktree add --detach ... HEAD` — a detached HEAD,
  not a branch. The harness lands branches (`ship` fast-forwards `main`), so a
  detached native checkout cannot be the feature's working tree.
- Native creation has no board row, handoff pointer, bootstrap hook, or lease.
  The harness's cleanup and concurrency guarantees depend on all four.
- With no `worktree.directory` setting, native worktrees land in the server data
  directory (`~/.local/share/opencode/worktree/<project-id>/...`). The managed
  permissions deny `edit` under `~/.local/share/opencode/**`, so an agent
  working in a native checkout there is blocked by the harness's own policy.

## Decision

1. Keep `git worktree` in `backlog worktree` as the **only** creation primitive
   for feature isolation. Do not adopt `ctx.worktree.create` or
   `opencode run --worktree` for that flow.
2. Adopt the one native setting that removes a real conflict: the managed
   `opencode.json` sets
   `"worktree": { "directory": "../.worktrees/{{PROJECT_DIR}}" }`. Native
   worktrees then land beside harness worktrees in the allowed sibling
   container instead of under the denied data directory.
3. The setting is add-only in the config merge: a project that already chose a
   `worktree.directory` keeps its value, like every other project override.
4. Document the divergence in `README.md`; revisit the decision if native
   creation learns named branches, a bootstrap hook, and board bookkeeping.

## Consequences

- One worktree neighborhood per repo. `git worktree list` remains the single
  inventory, so `check-worktrees`/`tidy` see native checkouts too.
- Harness-created and native-created worktrees are distinguishable: the former
  has a branch and a board row, the latter is detached and has neither.
- A native worktree is still outside the board/handoff/lease lifecycle: a
  session that does its real work in one gets no cleanup on archive and no
  live-owner guard from `worktree-prune`. That is acceptable for throwaway
  exploration, not for a feature.
- If a future OpenCode release gives native creation a branch parameter and
  plugin hooks for setup/teardown, this ADR is the place to supersede.
