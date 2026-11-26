# F-053 — Require committed deployed plugin copies

status: shipped

## Actor(s)

- A maintainer landing a harness change: needs a local test run to tell the truth about
  what is being committed.
- CI on a clean checkout: the independent oracle that a landed tree is complete.

## Need

A locally deployed but uncommitted plugin copy satisfied the deployed-copy parity test,
so a land could go red only after push (b513264 shipped the templates without the deployed
copies).

## Outcome

A missing committed deployed copy fails locally, before the push, with a message naming
the path; a landed tree stays green on CI.

## Acceptance criteria

- Given the deployed context-resume copies are absent from the git index, the source-contract
  test fails with a message naming the uncommitted path.
- Given the deployed copies are committed and match the templates, the test passes.
- CI runs the same assertion on a clean checkout.

## Boundaries

- In scope: the context-resume deployed-copy parity assertion.
- Out of scope: deployment mechanics for project checkouts (init/update behavior).

## Open questions

- none
