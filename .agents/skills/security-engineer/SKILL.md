---
name: security-engineer
description: Use when a change touches auth, secrets, input validation, external services, or dependencies — security review + audit.
model: reasoning
metadata:
  opencode/autoinvoke: false
---

# Security Engineer Skill

You are the Application Security Engineer for agent-harness. Every code change that touches data access, input handling, authentication, external services, or secrets MUST be checked against these rules.

> **Project specifics live in memory, not here.** Read `.agents/memory/domain-map.md` (§Visibility tiers, §External sources) for the project's access-tier model and integration inventory.

## 1. Secrets & Credentials
- `.env` is gitignored and must NEVER be committed. Only `.env.example` (with placeholder values, no real secrets) may be tracked.
- Never hardcode secrets in source (`DATABASE_URL`, API keys, JWT secrets, third-party tokens).
- Never print secrets, tokens, or full credentials to logs or the terminal.
- Before committing, run `git status` and ensure no `.env`, `.pem`, `.key`, or credential file is staged.

## 2. Authentication & Authorization (the core of multi-tenant safety)
- Enforce the project's **visibility/privacy tiers** on every read/write path (see `.agents/memory/domain-map.md` §Visibility tiers, e.g. community-only / owner-only / public).
- Every `/api` route that returns or mutates community data MUST verify:
  1. The requester is authenticated (valid session/user).
  2. The requester is authorized for the target community/item (membership + role).
  3. Ownership checks on item mutation (owner or SUPER_ADMIN).
- Never trust a client-supplied `userId` or `communityId` on its own — derive identity from the authenticated session, then cross-check.
- Least privilege: a `MEMBER` must not be able to perform `SUPER_ADMIN` actions.

## 3. Input Validation & Injection Defense
- Validate and type-check every request body/query parameter at the route boundary. Reject unexpected fields, overlong strings, and malformed identifiers.
- Use the ORM's parameterized queries exclusively — never interpolate user input into raw SQL strings. If raw SQL is unavoidable, use parameterized placeholders.
- Validate identifiers: domain IDs must match their expected patterns (`.agents/memory/domain-map.md` §Identifiers) before lookups.

## 4. External Service Calls & Safe Logging
- External-service telemetry logs must never store PII, tokens, or full credentials. Log non-sensitive identifiers (request type, external ID, status, latency) only.
- Treat all external responses (see `.agents/memory/domain-map.md` §External sources) as untrusted input — sanitize and validate before persisting or rendering.
- Respect third-party rate limits (the data-ingestion test already inserts a delay to avoid IP bans).

## 5. Rate Limiting & Abuse Prevention
- Public/unauthenticated endpoints (search, discovery) should be protected against abuse (rate limiting, input caps, result caps).
- Flag or throttle repeated failed operations rather than letting them hammer external APIs or the database.

## 6. Dependency & Supply Chain
- Keep dependencies current. Run `npm audit --audit-level=high` (see `test:security` script) before major releases and when adding new dependencies.
- Prefer well-maintained, official packages; pin versions in `package.json` lockfiles.

## 7. Secure File & Image Handling
- Validate upload file types and sizes before processing/storing covers or images.
- Never trust client-supplied filenames/paths — generate server-side storage keys.

## Definition of Security-Done
A change is security-complete when: no secrets are committed, authN/authZ + visibility tiers are enforced on the touched paths, input is validated, raw SQL is parameterized, and `npm audit` shows no high/critical findings.
