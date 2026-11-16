# Security

## Reporting

Please report suspected vulnerabilities **privately** via GitHub Security
Advisories on this repository (Security → Advisories → Report a vulnerability).
Do not open a public issue for a security problem.

Include the version (`agent-harness --version`), the command you ran, and the
smallest reproduction you can. We will acknowledge the report and coordinate a
fix and disclosure.

## Scope

The harness writes agent instructions, plugins, and scripts into a target
project. Changes to `templates/` and `bin/agent-harness.js` are the most
security-sensitive areas: they run in every deployed project. The CLI never
sends project data anywhere; the only network calls are the optional
`npm view` version check and the project's own configured services.
