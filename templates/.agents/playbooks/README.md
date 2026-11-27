# heal playbooks

One file per allowlisted action. `heal` selects the action deterministically
(`heal-lib.js`), then loads `<action>.md` and runs its `command` only when the
policy mode is `auto`, the tier is in `risk.auto_tiers`, and every budget /
breaker / kill-switch check passes.

A playbook without `command` is valid but **disabled**: the item is escalated
with the reason, never guessed. Add a command only when the exact check is
known and safe to re-run.

```md
---
action: rerun
command: ["npm", "run", "test:quick"]
timeout_sec: 600
verify: exit_code
description: Re-run the failing quick tier with no cache.
---
```

Rules:

- `command` is an argv array (or a simple string parsed to argv). Shell
  metacharacters (`; | & > < $`) are refused, so evidence can never become a
  command.
- Commands come from this directory only; the loop never builds one from logs.
- T0 actions: `retry`, `rerun`, `quarantine`, `resync`, `clear_cache`,
  `restart_server`, `rebase`. `patch` is assist-only (isolated worktree +
  handoff; the loop never auto-merges T1).
- Run `heal playbook validate` after editing.
