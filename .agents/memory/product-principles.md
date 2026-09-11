# Product principles — agent-harness

Project-owned product concepts that **lead** planning. The planner reads this
before emitting a dispatch plan; `product-manager` and `ui-designer` keep it
current. Fill it in during `npx @dombaras/agent-harness init`; evolve it as the
product does. Skills reference this instead of hardcoding product/UX assumptions.

## Actors
<!-- who uses the product, their goals, and emotional states -->
_TODO: list each actor (role), their primary goal, and what frustrates/delights them._

## Product concepts
<!-- the durable product ideas every feature must honor (e.g. community trust, one-tap primary actions) -->
_TODO: name the 2-5 concepts that define this product._

## UX heuristics
<!-- the standing UX rules every screen/flow follows -->
- **The 5 UI states** — ideal / empty (with CTA) / loading (skeleton) / error (retry) / partial.
- **Progressive disclosure** — high-frequency actions primary (one tap); fold secondary tiers behind menus/sheets.
- **Empty = default** — a new user's empty state is a primary design target, never an edge case.
- **Mobile ergonomics** — thumb-reachability, bottom sheets over modals, swipe actions.
- **RTL** — logical properties (`ps-*`/`pe-*`), direction-aware layout.
- **No dead-ends** — every state has a way forward (CTA, retry, dismissal).

## Design language
<!-- tokens & patterns (from ui-designer): color/typography/spacing, shared components -->
_TODO: reference the shared component / token system._

## Key journeys
<!-- the user-facing flows that matter most, with their happy + unhappy paths -->
_TODO: list the core journeys and their critical states._

## Value maximization rules
<!-- how planning sequences work to maximize user value first -->
- Ship the smallest slice that delivers the core outcome first.
- Order steps by user value, not by tech-dependency convenience.
- Prune anything that does not advance the user outcome.
