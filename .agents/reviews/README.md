# Reviews & audits — agent-harness

Durable home for **review / audit / investigation deliverables** — the reports a
session produces when it inspects the codebase and files follow-up rows. This
namespace exists so audits stop improvising slugs inside the `.agents/features/`
tree (which is for feature *contracts*: intent → scope → plan → tests) and stop
silently relying on `check-product` treating "no intent.md/plan.md yet" as "not
at planning stage".

## When to write here

A session that runs a code-quality review, regression-package review, logs audit,
dependency audit, or similar **investigation that files follow-up rows** writes
its durable findings here:

```
.agents/reviews/<id-or-slug>/REPORT.md     # the consolidated findings
.agents/reviews/<id-or-slug>/scans/*.md    # per-surface scan output (web/mobile/scripts…)
```

`<id-or-slug>` is the board row ID (e.g. the F-104 code-quality review) or a
hyphenated slug when no row exists yet. One review = one directory; never edit
another review's directory.

## Artifact convention (keep reviews comparable)

Every `REPORT.md` follows the same spine so audits become comparable instead of
bespoke:

1. **Scope + provenance** — what was audited, which surfaces, which session.
2. **Findings, each tagged** with the quality-parameter it violates
   (`.agents/memory/quality-parameters.md`: P1 dead-code · P2 deps · P3
   right-sized · P4 one-home-per-fact · P5 layering · P6 error/state · P7 type
   honesty · P8 consistency) and a `file:line` evidence pointer.
3. **Remediation** — the fix shape for each finding.
4. **Follow-up rows** — every legacy-debt finding that is not fixed in this
   review ships as a board row (evidence cites this `REPORT.md`).
5. **Root-cause findings about the harness** — flag defects in the harness's own
   rules/gates/tools separately, addressed to the harness maintainer.

Reviews that are **no-user-facing** ship as `docs`/`chore`; if the review files
follow-up rows, add a `docs`-type changelog line so the milestone is visible in
the human changelog.

Mechanical quality gates (`.agents/memory/quality-parameters.md` P1/P3/P4) stop
debt from being *introduced* on new/changed code; these reviews clear *legacy*
debt and file the follow-ups.
