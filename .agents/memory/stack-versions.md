# Stack versions — agent-harness

Confirmed framework / runtime versions. Verify against `package.json` and
`mobile/package.json` before trusting this file.

- **Web**: 
- **Styling**: 
- **ORM / DB**: 
- **Mobile**: 
- **Key native libs**: 

## Web gotchas

Record framework/library gotchas that bite during builds. Seed with any that
apply to your stack; prune the rest.

- **Async route params (App Router)**: dynamic route params in `page.tsx` /
  `route.ts` are Promises — always `const { id } = await params;`.
- **Framer Motion typing**: import the `Variants` type explicitly to avoid
  strict-TS build failures.

## ORM / DB gotchas

- **Generator & config layout**: a recent ORM major renamed the client generator
  and moved config out of `schema.prisma` (e.g. a `prisma.config.ts`). Confirm the
  exact generator name and datasource location before editing the schema.
- Record migrate + generate commands here once confirmed.

## Mobile gotchas

- **css-interop freeze race**: on `shadow-*` / `opacity-*` / `#NN` color
  shorthand in Expo Go — prefer inline styles for animated/opacity properties.
- **Expo Go vs dev build**: remote push notifications require an `eas` dev build
  (Expo Go cannot receive them).
- Record any other native/runtime caveats discovered during sessions here.
