---
action: rerun
timeout_sec: 600
verify: exit_code
description: Re-run the failing check with no cache (disabled until command is set).
---
# rerun

Enable by setting `command:` to the exact check named by the signal, for
example `["npm", "run", "test:quick"]`. A successful exit verifies the signal;
a failure escalates and counts toward the breaker.
