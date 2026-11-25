# Harness lifecycle: from symptom to proven change

The harness now follows an inquiry loop, not only an execution loop. A reported
symptom is recorded, tested against competing explanations, challenged by an
independent reader, fixed only after the explanation is confirmed, and then
proved to have changed in the real surface that was reported.

This closes a gap in the harness: it was execution-strong but inquiry-weak. A
symptom could go straight to a plausible cause and a patch, while “done” meant
green CI rather than “the reported behavior changed”. F-040 makes the reasoning
and the before/after proof part of the delivery contract.

## When the loop applies

A feature declares its scope in
`.agents/features/<slug>/meta.json`. The `kind` field is explicit metadata; the
harness never infers diagnostic scope from a diff.

* `bug`, `incident`, and `fix` require a diagnosis.
* Those kinds may deliberately set `requiresDiagnosis: false`.
* `feature`, `investigate`, and `ops` do not require one by default.
* High-risk work in a non-diagnostic kind may opt in with
  `requiresDiagnosis: true`.
* A legacy feature with no `meta.json` produces a warning and is never blocked.

The feature scaffold creates the metadata and the initial artifact:

```text
node scripts/qa/feature-scaffold.js --kind bug --symptom "<symptom>"
```

The `/diagnose <symptom>` command is the operator-friendly equivalent. Both
routes begin the same record; neither proves a cause by itself.

## The five stages

### 1. Declare

The actor states the symptom in observable terms and chooses the work kind.
The scaffold writes `meta.json` and a `diagnosis.md` stub under the feature
directory. This makes the inquiry visible before implementation starts.

The declaration should say what happened, not what the actor thinks caused it.
For example, “the restart badge remains after the service restarts” is a
symptom; “the cache is stale” is a candidate cause.

### 2. Diagnose

The actor fills in `diagnosis.md` with:

* observed behavior and expected behavior;
* an `Evidence` section with source pointers;
* at least two `Candidate causes`;
* one discriminating test for every candidate;
* `Ruled out` causes and the evidence that ruled them out;
* a confidence level and a status.

The candidates are alternatives, not two names for the same explanation. A
discriminating test should produce a result that changes which explanation is
credible. The evidence belongs in the feature artifact, where a later reviewer
can inspect the reasoning without reconstructing it from a patch.

### 3. Falsify

Before any code change, an independent read-only `falsifier` persona tries to
break the diagnosis. It records a `## Falsification` block in the diagnosis
artifact. The goal is not to approve the preferred explanation; it is to find
evidence that would make it wrong, incomplete, or too broad.

Unknown-cause work is routed by `dispatch-tier` to at least T2 and pays the
`test:diagnosis` gate. This prevents an unresolved inquiry from being treated
as a small, purely mechanical change.

### 4. Fix

The actor implements the smallest change supported by the confirmed diagnosis.
The diagnosis must have `status: confirmed` and exactly one confirmed result
before enforcement-mode diagnostic work proceeds.

During the rollout, `AGENT_HARNESS_DIAGNOSIS=warn` (or `--warn`) reports
failures without blocking. Warn mode is intended for one release only; it is
not a permanent bypass.

### 5. Prove

The QA plan records an `## Outcome oracle` with all of these fields:

* Reported symptom
* Before (red)
* After (green)
* Command / observation
* Environment / surface
* Independent owner

“Before” must demonstrate the reported failure, and “After” must demonstrate
the changed behavior. A `bug`, `incident`, or `fix` change with an incomplete
oracle fails `test:qa-plan`, even when the diff is empty. The oracle is the
proof that the work changed the product behavior, rather than merely producing
a plausible patch.

## The diagnosis gate

Run the gate directly when checking an inquiry artifact:

```text
npm run test:diagnosis
node scripts/qa/check-diagnosis.js [--feature <id>] [--warn] [--json]
```

It checks the declared feature metadata, the diagnosis shape, evidence
pointers, candidate count and tests, ruled-out evidence, falsification, and
the outcome oracle. It checks only the scope declared in metadata.

Exit code `0` means every required diagnosis is valid, or that warn mode
allowed the failures. Exit code `1` means a required diagnosis is missing or
malformed. Exit code `2` means the invocation is invalid, such as an unknown
feature or unreadable metadata.

The gate runs in `run-gates`, `ship`, `finalize` preflight, and CI. Its gate
reference is [the diagnosis gate in the gate catalog](gates.md#testdiagnosis--inquiry-loop-diagnosis-gate).

## Resume and state

`orient` and
`node scripts/checkpoint.js resume --feature <id>` show the diagnosis status,
confidence, and up to three open questions. They also flag the diagnosis as
stale when HEAD or the harness version has moved since the artifact was
recorded.

These commands report state only. Neither command mutates the diagnosis
artifact. The actor must decide whether the changed checkout invalidates the
evidence and then update the artifact through the normal inquiry stages.

## Rollout and deliberate opt-out

Use warn mode for one release while existing feature directories are brought
into the declared workflow. Legacy directories without `meta.json` remain
warning-only and are never blocked.

For a knowingly designed change, set `requiresDiagnosis: false` in
`meta.json`. This is the deliberate opt-out, not an inference from the patch.
A capability build such as F-040 itself can use that opt-out when it is not
repairing a reported failure.

## Implementation pointers

The live validator and shared parser are
[`templates/scripts/qa/diagnosis-lib.js`](../templates/scripts/qa/diagnosis-lib.js)
and
[`templates/scripts/qa/check-diagnosis.js`](../templates/scripts/qa/check-diagnosis.js).
They are the source of truth for artifact shape and gate behavior.

The gate catalog places this loop in the wider gate sequence:
[`docs/gates.md`](gates.md#testdiagnosis--inquiry-loop-diagnosis-gate).
