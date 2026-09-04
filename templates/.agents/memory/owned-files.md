# Owned files per active row

Project-owned (like all `.agents/memory/*`). Maps each **in-progress** backlog row
to the files/globs it owns, so the cross-session collision check is precise instead
of coarse.

`npm run test:concurrency` reads this file: when the working tree is dirty and 2+
rows are In progress, it attributes each dirty file to the row(s) whose globs match
it — and fails *exactly* when a file is owned by two sessions (or a tree mixes two
sessions' WIP), instead of failing on every "2+ In progress + dirty" tree.

Keep it current: record a row's owned files the moment you pick it up
(`backlog owns <id> --files "glob, glob"`), and clear it when it ships
(`backlog owns <id> --files "?"`). A row not listed here is simply unattributed.

Format — one line per row, comma-separated globs/paths (`*` = within a segment,
`**` = any depth, `?` = one char):

- F-041: lib/wikidata.ts, scripts/qa/tests/wikidata-genres.test.ts
