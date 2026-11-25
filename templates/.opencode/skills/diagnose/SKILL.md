---
name: diagnose
description: Use to diagnose an unknown cause — write a diagnosis.md with two or more candidates and discriminating tests, then dispatch the falsifier before code changes.
model: reasoning
metadata:
  opencode/autoinvoke: false
---

# Diagnose — the inquiry loop

Use this procedure when the cause of a symptom is not yet proven. A known fix from
a failing test does not need it; an unknown cause does. The artifact is
`.agents/features/<slug>/diagnosis.md`, and `test:diagnosis` enforces its shape —
`scripts/qa/diagnosis-lib.js` is the single parser (do not invent a second
format).

## 1. Resolve and declare

- Find the feature id and slug; read `.agents/features/<slug>/meta.json`.
- Scaffold only if absent (never overwrite a filled diagnosis):
  ```
  node scripts/qa/feature-scaffold.js --id <id> --slug <slug> \
    --title "<title>" --risk <low|high> --kind <bug|incident|fix> \
    --symptom <stable-lowercase-key>
  ```
- `bug|incident|fix` sets `requiresDiagnosis: true`; `feature|investigate|ops` does
  not. A high-risk feature can opt in explicitly. A legacy feature (no `meta.json`)
  only warns.

## 2. Frame the symptom

Write `status`, `symptom`, `confidence`, `owner`, `falsifier`, then
`## Observed vs expected`:

- Observed: the user-visible behaviour, with a reproducible pointer.
- Expected: the specified behaviour.
- Reported by / evidence pointer: who reported it and where the evidence lives.

## 3. Gather evidence

Fill `## Evidence` with pointers only — `file:line`, a command, a log path, a
record. State what each item supports. If the logs are missing, add the
instrumentation and reproduce first; an absence of evidence is not evidence for
the leading candidate.

## 4. Enumerate candidate causes

At least **two**, each with:

- a cause (a mechanism, not a restatement of the symptom),
- a likelihood,
- a **discriminating test** — the cheapest command/observation whose result
  differs between candidates,
- a result (`confirmed | refuted | pending`).

Run the cheapest discriminating test. A candidate with a pending test is not
confirmed, however plausible.

## 5. Rule out

Record each ruled-out cause with the evidence that eliminated it. `status: open`
may have no ruled-out cause only with a written reason; `status: confirmed`
requires at least one, plus exactly one candidate marked `confirmed`.

## 6. State confidence

`low | medium | high` — and the observation that would move it. Confidence is a
claim about the evidence, not about the prose.

## 7. Write the outcome oracle

Name the reported surface and the before/after observation now, before the fix:

- Before (red): the command/observation that reproduces the reported symptom.
- After (green): the same command/observation expected after the fix.
- Command / observation, environment / surface, independent owner.

A unit test that never touches the reported surface is not an outcome oracle.

## 8. Dispatch the falsifier (required)

Use `dispatch_persona`/`subagent` with the input contract in
`.agents/skills/falsifier/SKILL.md`: diagnosis path, evidence pointers, proposed
fix (if any), empty write scope. Put the read paths in the dispatch spec's
Read-only files, not Owned files, and keep the objective read-only — the persona
preflight rejects a write objective the falsifier cannot honor. The falsifier is
read-only and returns only the `## Falsification` block. Append that block
verbatim to the diagnosis and record its identity (`falsifier:` scalar and
`- Reviewer:` line). Never let the falsifier's output be summarized away.

If the outcome is `weakened` or `refuted`, return to step 4 — do not implement a
fix around a refuted diagnosis.

## 9. Verify and hand off

```
node scripts/qa/check-diagnosis.js --feature <id> [--json]
```

Then report the diagnosis path, `status`, `confidence`, the falsifier outcome, the
next action, and the one open question that could still invalidate the cause. Code
changes may start only after this passes; unknown-cause work is T2/T3.
