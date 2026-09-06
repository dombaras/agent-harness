---
description: Switch the reasoning-tier model (default deepseek/deepseek-v4-pro direct).
---

Change the reasoning-tier model to `$ARGUMENTS`.

Valid values:
- `deepseek` / `direct` (default) -> `deepseek/deepseek-v4-pro` (direct API key)
- `zen` / `opencode` -> `opencode/deepseek-v4-pro` (Zen gateway)
- `pickle` / `big-pickle` -> `opencode/big-pickle`
- `nvidia` / `kimi` / `kimi-k3` -> `nvidia/moonshotai/kimi-k3` (NVIDIA NIM)
- `nemotron` / `nemotron-ultra` -> `nvidia/nemotron-3-ultra-550b-a55b:free` (NVIDIA NIM, free)
- `openrouter` / `or` / `minimax-m3` / `m3` -> `openrouter/minimax/minimax-m3` (OpenRouter)
- any other explicit model id (e.g. `opencode/gpt-5.6-luna`)

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
