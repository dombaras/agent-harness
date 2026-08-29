# Features — backlog & status board

Project-owned (like all `.agents/features/*`). This is the **collection box**, not a
spec and not a status board. Every found item gets one terse row here; the per-feature
doc chain (`.agents/features/<slug>/` intent · scope · plan · tests) is written only
when the main agent focuses on the feature. Keep rows ultra-light — a note, not a promise.

Maintained by the `features` persona (`.agents/skills/features/SKILL.md`).

## Backlog

One row per found item. `Status`: `backlog → ready → in-progress → testing → shipped → archived`.

| ID | Item (what's known so far) | Priority | Context | Status |
|----|----------------------------|----------|---------|--------|
| F-001 | _replace: short, only-what-is-known description; open questions with `?`_ | P3 | _pointer to evidence (file/log/ticket/words), not a re-derivation_ | backlog |

<!-- Add rows as items surface. Never invent status or priority — leave blank/`?` if unknown. -->

## Active / next

- _when a feature is about to be worked, cite it here and route the docs to the author personas (see skill)._
