# Run Report: Artifacts over Tool Calls

## Problem

When a relay run finishes, the planner (outer pi assistant) receives a
text report that it uses to narrate the result to the user. Currently
the report prioritizes tool call logs over artifact values:

```
✓ argue — advocate
  → read ~/repos/pi-relay/src/actors/render-value.ts
  → read ~/repos/pi-relay/src/runtime/artifacts.ts
  → grep /TOON/ in ~/repos/pi-relay/src
  "TOON is better because it uses 40% fewer tokens..."

✓ challenge — critic
  → read ~/repos/pi-relay/src/actors/render-value.ts
  "The advocate's case collapses under scrutiny..."

Produced: debate_log
```

The planner knows which files were read but not what the debate
concluded. The artifact values — the actual substance — are invisible.
The planner can't tell the user who won the debate, what the diagnosis
was, or what the experiment tried.

## What the planner needs

The planner presents results to the user. It needs:

1. **What happened** — outcome and a compact step timeline
2. **What was produced** — artifact values, rendered readably
3. **What each step concluded** — the actor's narration (already present)

Tool calls (`→ read`, `→ edit`, `→ grep`) are useful for debugging
but not for narrating results. Knowing the actor read 5 files tells
the user nothing about the conclusion. The artifacts ARE the
conclusion.

## Proposed report format

```
Relay run: SUCCESS — Debate: Should we use TOON?

✓ argue — advocate
✓ challenge — critic
✓ evaluate — judge → resolved

## Artifacts

### debate_log (3 entries)

[1] by advocate (step: argue):
  role: advocate
  argument: TOON is better because it uses 40% fewer tokens...

[2] by critic (step: challenge):
  role: critic
  critique: The advocate's case collapses under scrutiny...

[3] by judge (step: evaluate):
  role: judge
  verdict: resolved
  conclusion: Retain YAML-like rendering
  prevailing_side: critic

Total: 6 turns · $0.12
```

The timeline is one line per step — step name, actor, route (if
non-generic). No tool calls, no narration inline. The artifacts
section carries the full content using the same YAML-like renderer
and attribution headers the actors see.

## What changes in each template's report

- **verified-edit**: `change_notes` — what files were changed and why
- **bug-fix**: `diagnosis` + `fix_notes` — root cause and what was fixed
- **reviewed-edit**: `notes` + `spec_verdict` + `quality_verdict` — implementation and review results
- **debate**: `debate_log` — the full exchange
- **autoresearch**: `experiment_log` — what was tried (capped to last N entries)

## Accumulated artifact capping

Accumulated artifacts can have many entries. For the planner's report:

- **10 or fewer entries**: show all
- **More than 10**: show the last 10 with a note:
  `(15 earlier entries omitted)`

The full history is always available in the TUI's expanded view
(Ctrl+O). The report is for the planner to narrate, not for archival.

## Timeline simplification

The per-step timeline becomes a compact one-line-per-step summary:

```
✓ argue — advocate
✓ challenge — critic
✓ evaluate — judge → resolved
✗ verify
  Failed: npm test exited with code 1
```

No tool calls. No narration. Routes shown only when non-generic
(not "done", "next", "success"). Failure reasons shown only for
failed steps.

This is the same information the collapsed TUI view shows — the
report matches what the user already saw.

## Narration

The per-step narration (the actor's final text output) is currently
the main content in the report. With artifacts carrying the substance,
the narration becomes redundant for steps that write artifacts.

Drop narration for steps that produced artifacts — the artifact value
IS the narration. Keep narration only for steps that wrote no
artifacts (e.g., action steps with empty writes).

## Non-accumulated artifacts

Non-accumulated artifacts (single value) are rendered with the same
YAML-like format, just without attribution headers:

```
### diagnosis

root_cause: subtract function uses + instead of -
file: src/math.js
line: 6
fix: change return a + b to return a - b
```

## Implementation scope

1. Rewrite `renderRunReportText` in `run-report.ts`:
   - Compact one-line timeline (no tool calls, no narration)
   - Artifact values section using `renderValue` from `render-value.ts`
   - Accumulated artifacts with attribution headers
   - Cap accumulated entries at 10
   - Failure reasons on failed steps only
2. Import `renderValue` and `isAccumulatedEntryArray` into `run-report.ts`
3. Access committed artifact values from the `RunReport` — currently
   the report only carries artifact metadata (id, writer, description).
   Add `value: unknown` to `ArtifactSummary` so the report includes
   the committed values.
4. The step-actor resolver needs to be available at report-build time
   for attribution rendering.
