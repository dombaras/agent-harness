---
action: restart_server
timeout_sec: 120
verify: exit_code
description: Restart one managed dev server (disabled until command is set).
---
# restart_server

Only one named, managed process may be restarted. Enable with a bounded command
(for example `node scripts/serve.js stop <unit>`); never a broad `pkill`.
