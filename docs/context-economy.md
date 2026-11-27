# Context economy for state documents

Large state documents can consume context before an agent reaches the section it
needs. In the measured LibraryOS case, reading `FINDINGS-REGISTER.md` whole
(52,020 B) moved context from 32,880 to 47,382 tokens; the first edit landed
only at 72,577. A headings-first read was estimated to save about 10–15K
tokens. The measurement and implementation rationale are recorded in
`scripts/qa/outline-lib.js:7-18`.

## Read flow

1. Run `outline` on the state document.
2. Choose the relevant heading and its reported line range.
3. Call `read` with that section's explicit `offset` and `limit`.

This keeps disclosure bounded while preserving the file's section structure.

## Outline tool

```text
node scripts/qa/outline.js <file> [--max-level N] [--max N] [--json] [--root <dir>]
```

The default output is a fence-aware Markdown heading outline, bounded to 40
headings. Each heading includes `L<start>-<end>` and the file byte size. Use
`--json` for structured output, `--max-level` to limit heading depth, `--max`
to change the heading bound, and `--root` to resolve a relative path from
another repository root. The CLI contract is implemented in
`scripts/qa/outline.js:15-18`; rendering is in `scripts/qa/outline-lib.js:78-110`.

## Oversized-read guard

| Path | Size | Ranged read | Knobs |
|---|---:|---|---|
| Markdown under `.agents/` | `< 12,000 B` | Allowed | — |
| Markdown under `.agents/` | `>= 12,000 B` | Allowed when `offset` or `limit` is explicit | `AGENT_GUARD_STATEDOC=0` disables the block; `AGENT_STATE_READ_BYTES` changes the threshold |
| Code, `README.md`, `CHANGELOG.md`, and `docs/**` | Any | Not gated | — |

An unranged read of an oversized `.agents/**` Markdown file is aborted before
the read executes. The refusal includes a bounded heading outline and an exact
next ranged `read` call; it also points to `outline` for the full list. The
guard applies to primary and child sessions. See
`.opencode/plugins/context-guard.ts:968-1001` and
`scripts/qa/outline-lib.js:146-187`.

## Deliberately out of scope

This guard does not gate non-Markdown files, project documentation, or reads
that already specify `offset` or `limit`. It does not choose which section an
agent needs, summarize section contents, or replace the underlying `read`
tool. Operational gate documentation remains in `docs/gates.md`.
