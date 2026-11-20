---
description: Reclaim local disk and de-clutter the tree — prune stale serve records, merged feature worktrees, and merged local branches. Never touches live, dirty, or unmerged work.
---

Reclaim local state after shipping. This is a **convergence** pass, not a delete
sweep: every step refuses to touch work a live session owns, an unmerged branch,
or a dirty tree. Run it from the **main** checkout.

1. **Show what is up first** (never prune blind):
   ```
   node scripts/serve.js list
   node scripts/backlog.js worktree-prune --json
   ```
   Read the two reports. `serve.js list` shows live jobs + the capacity verdict;
   `worktree-prune --json` lists the linked worktrees and, per worktree, whether
   it is removable (clean + merged) or kept (dirty / unmerged / live session).

2. **Prune stale serve records** (dead pids only — a live process is kept):
   ```
   node scripts/serve.js prune --worktrees
   ```
   `--worktrees` also clears records under every sibling worktree's `.serve/`, so
   a stopped emulator/dev server is not misreported as live. It never stops a
   running process; use `serve.js stop --name <label>` / `stop-all` for that.

3. **Prune merged feature worktrees** (clean + branch already merged only):
   ```
   node scripts/backlog.js worktree-prune
   ```
   It removes a worktree only when its branch is merged and the tree is clean,
   and it refuses a checkout a live session is rooted in (F-252). Named branches
   (`worktree-prune <branch>...`) prune explicitly; `--self` is the token `ship`
   passes after CI is green — do not hand-pass it.

4. **Delete merged local branches** (optional, after the worktrees are gone):
   list what is fully merged into `origin/main` and delete only those:
   ```
   git branch --merged origin/main
   ```
   Delete a branch only if its worktree is already pruned and you are sure the
   content is on `main`: `git branch -d <branch>` (the `-d` refuses unmerged
   branches — never use `-D` here).

5. **Report the delta**: what was pruned (serve records, worktrees, branches) and
   what was kept and why. If a worktree was kept because a session is live or the
   tree is dirty, that is a finding to surface — not something to force.

If the working tree is dirty, stop and report — do not prune around uncommitted
work. `git status` is the gate.
