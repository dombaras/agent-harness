---
description: Diagnose a feature's unknown cause — fill diagnosis.md with alternatives and discriminating tests, then dispatch the falsifier before any code changes.
---

Run the inquiry loop for `$ARGUMENTS` (the feature id/slug), following the
`diagnose` skill (`.opencode/skills/diagnose/SKILL.md`). The output is a valid
`.agents/features/<slug>/diagnosis.md` that passes `test:diagnosis`, plus an
independent falsifier review appended to it. No implementation dispatch until the
falsifier returns.

1. **Resolve the feature.** Find the row and slug (`backlog_list` / `orient`).
   Read `.agents/features/<slug>/meta.json` when it exists and keep its id/symptom.
   `scripts/qa/diagnosis-lib.js` is the parser the gate uses — its shape
   (status/symptom/confidence, Evidence, Candidate causes, Ruled out,
   Falsification, Outcome oracle) is authoritative; do not invent sections.

2. **Scaffold only if the artifact is missing.** Never overwrite a filled
   diagnosis:
   ```
   node scripts/qa/feature-scaffold.js --id <id> --slug <slug> \
     --title "<title>" --risk <low|high> --kind <bug|incident|fix> \
     --symptom <stable-lowercase-key>
   ```
   `bug|incident|fix` writes `meta.json` + the `diagnosis.md` stub. If a
   diagnosis-shaped doc exists without metadata, add `meta.json` (`kind`,
   `symptom`, `requiresDiagnosis: true`) rather than retyping the shape.

3. **State observed vs expected.** One reproducible pointer per line (command,
   log path, file:line, record). The symptom key is stable lowercase and matches
   `meta.json`.

4. **Gather evidence as pointers.** Fill `## Evidence` rows with
   `Evidence | Source (file:line / command / log) | Supports`. A row that re-derives
   the evidence instead of pointing at it is not evidence.

5. **Enumerate at least two candidate causes.** Each needs a likelihood, a
   **discriminating test** (a command/observation that separates it from the
   others — not a restatement of the cause), and a recorded result
   (`confirmed | refuted | pending`). Run the cheapest test that discriminates.
   Do not mark a candidate confirmed while its test is pending.

6. **Record what is ruled out** with the evidence that ruled it out. `status: open`
   may have none yet, but only with a written reason why; `confirmed` must have at
   least one and exactly one candidate whose Result is `confirmed`.

7. **Set confidence** (`low|medium|high`) and say what would change it. Write the
   `## Outcome oracle` now: the reported surface, the command/observation that
   reproduces it **before** the fix (red), the expected after (green), the
   environment, and an independent owner. A unit assertion is not the reported
   surface.

8. **Dispatch the falsifier** (read-only, architect tier) with the input contract
   from `.agents/skills/falsifier/SKILL.md`: diagnosis path, evidence pointers,
   the proposed fix, empty write scope. Put those paths in the dispatch spec's
   **Read-only files**, not Owned files, and keep the objective read-only — the
   persona preflight rejects a write objective this persona cannot honor. Wait for
   the `## Falsification` block, then append it verbatim and set
   `falsifier: <persona/session>` and `- Reviewer:`. The falsifier never edits the
   file; you do.

9. **Verify the artifact**, then continue only if it passes:
   ```
   node scripts/qa/check-diagnosis.js --feature <id> [--json]
   ```
   A `refuted`/`weakened` outcome reopens the candidates — do not implement around
   it. Report the diagnosis path, status, confidence, falsifier outcome, and the
   next action.
