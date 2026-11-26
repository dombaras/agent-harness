# F-053 — plan

## Value-first sequence

1. Reproduce the gap from the commit objects: b513264 has the template copies but not the
   deployed copies, while a local checkout had them untracked. (Evidence first, no guessing.)
2. Change the parity oracle from the working tree to the git index, so an uncommitted copy
   cannot satisfy it.
3. Prove both directions: an untracked copy fails locally, a committed copy passes (the
   current tree plus the b513264/d055956 pair).

## Product concepts applied

- Fail closed at the cheapest tier: the mistake is caught by a 0.1 s source-contract test
  instead of a red main branch and a blocked UAT deploy.
- The commit is the product surface: what ships must be what the repository says it ships,
  not what one machine's deploy happened to leave behind.
