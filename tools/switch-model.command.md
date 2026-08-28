---
description: Switch the reasoning-tier model between deepseek-v4-pro and big-pickle.
---

Switch the reasoning-tier model to $ARGUMENTS. Valid values are `deepseek`
(or `pro`) for `opencode/deepseek-v4-pro`, or `pickle` (or `big-pickle`) for
`opencode/big-pickle`.

Run:

```
powershell -ExecutionPolicy Bypass -File scripts/switch-reasoning-model.ps1 -Target $ARGUMENTS
```

This rewrites the `model` field in `opencode.json` and the `model:` frontmatter
of the six reasoning-tier agents (planner, system-architect, security-engineer,
diagnostics-expert, product-manager, qa-architect).

Report the old model -> new model delta, and remind the user that opencode
does not hot-reload config, so they must quit and restart for it to take
effect.
