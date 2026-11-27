# Rulebook moved — `.agents/rulebook.md`

The canonical operating rulebook now lives at [`.agents/rulebook.md`](rulebook.md).
Read it before non-trivial work; the always-on digest is the repository-root
`AGENTS.md`, and the dispatch/lifecycle mechanics are in
`.agents/rules/00-operating.md`.

This file is deliberately a stub. opencode V2 auto-injects the nearest `AGENTS.md`
whenever a file under `.agents/` is read, so keeping the full rulebook here would
add ~28 KB (~7.4K tokens) to every handoff, plan, or review read.
