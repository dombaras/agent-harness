# BACKLOG — canonical task list (CI smoke fixture)

A small, well-formed board used by `ci-gates.sh` to prove the board service
round-trips every section through the shipped gates. Keep it valid: the gates
fail on a blank priority/evidence, a frozen row without a reopen condition, or an
undeclared epic.

## Epics

| Key | Label | Goal |
|-----|-------|------|
| tooling | Dev tooling | The board itself and development tooling |
| auth | Auth & security | Sessions, 2FA, access control |

## Active / next

- _the next few picks (optional): cite each as `ID (P)`._

## In progress

| ID | Epic | Task | Handoff |
|----|------|------|---------|
| F-002 | tooling | Wire the board service smoke gate | .agents/handoffs/F-002.md |

## Queued

| ID | P | Epic | Task | Evidence | Depends on |
|----|---|------|------|----------|------------|
| F-003 | P1 | auth | Add a second factor to superadmin login | user report | ? |

## Open

| ID | P | Epic | Task | Evidence | Depends on |
|----|---|------|------|----------|------------|
| F-001 | P2 | tooling | Record the migration parity check | CI run | ? |

## Frozen

| ID | Epic | Task | Why frozen / reopen when |
|----|------|------|--------------------------|
| F-004 | tooling | Offline board cache | online-only for v1 | reopen when an offline need is proven |

## Archive (shipped · done)

| ID | Epic | Task | Closed |
|----|------|------|--------|
| F-005 | tooling | Import current live rows only | shipped 2026-10-03 |
