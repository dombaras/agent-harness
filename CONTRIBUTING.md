# Contributing

Thanks for improving the harness. It is a Node CLI plus a `templates/` tree that
is deployed into other projects, so two rules matter more than anything else:

1. **Fix harness-owned files in `templates/`, never in a deployed project.**
   `scripts/qa/**`, `scripts/*.js`, `.opencode/**`, `.agents/{skills,rules}`,
   `.agents/AGENTS.md`, `AGENTS.md`, and the opencode config are overwritten by
   `update`. A project-side edit will be lost (and `update` fails closed on it).
2. **Bump `package.json` in the same commit as any change under `bin/` or
   `templates/`.** A test enforces this.

## Before opening a PR

```bash
npm run lint
npm test
npm run test:pack   # packs the tarball, installs it, runs init --dry-run
```

`npm test` must be green. Add a test for a behavioural change — the suite is the
contract that protects deployed projects.

## Commit messages

Use `feat:` / `fix:` / `docs:` and end the subject with the version, e.g.
`feat: example change (0.2.0)`. Keep a changelog entry for user-visible changes.

## Public behaviour

Model routing defaults to the `opencode-go/*` models in
`templates/opencode.json` and `templates/.opencode/agents/*.md`. Do not change
those defaults silently — portability is opt-in, and the defaults are covered by
a regression test.
