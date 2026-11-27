---
action: resync
timeout_sec: 900
verify: exit_code
description: Re-apply harness-owned templates to repair drift (disabled until command is set).
---
# resync

Drift repair is template re-apply, never an LLM edit. Enable with the project's
own update command, for example
`["npx", "opencode-agent-harness", "update", "--target", "."]`.
