# Run Report: Artifacts Inline with Timeline

## Problem

When a relay run finishes, the planner receives a text report to
narrate the result to the user. Currently the report shows tool call
logs (`→ read`, `→ edit`) and a one-line narration per step, but
artifact values — the actual substance of what was produced — are
invisible. The planner can't tell the user what the debate concluded,
what the diagnosis found, or what the experiment tried.

## What the planner should see

A chronological timeline where each step shows its narration AND the
artifacts it committed, inline:

```
Relay run: SUCCESS — Debate: Should we use TOON?

✓ argue — advocate
  "TOON is better because it uses 40% fewer tokens..."

  → debate_log [1]:
    role: advocate
    argument: TOON is better because...

✓ challenge — critic
  "The advocate's case collapses under scrutiny..."

  → debate_log [2]:
    role: critic
    critique: The advocate's case collapses...

✓ evaluate — judge → resolved
  "The motion fails — retain YAML-like rendering"

  → debate_log [3]:
    role: judge
    verdict: resolved
    conclusion: Retain YAML-like rendering
    prevailing_side: critic

Total: 6 turns · $0.12
```

The planner reads top-to-bottom and gets the full story in order.
No separate artifacts section. No cap on entries. No dropped
narration.

## Design principles

1. **Timeline-first.** The report reads as a chronological story.
   Each step appears in execution order, same as the TUI.
2. **Artifacts inline.** Each step's committed artifact entries appear
   directly under that step, not in a batch at the end.
3. **Narration kept.** The actor's narration carries context the
   artifact value doesn't — why it made the choice, what it
   considered, what it rejected.
4. **No cap on entries.** Show everything. The planner needs the full
   picture. Context window management is the model's concern.
5. **Tool calls dropped from the report.** `→ read`, `→ edit`,
   `→ grep` are debugging detail. The planner doesn't need to know
   which files were read to narrate the result. Tool calls remain
   visible in the TUI's expanded view (Ctrl+O).

## Per-step report block

Each step in the timeline produces a block:

```
<icon> <stepId> — <actor> [retry tag] [non-generic route]

  "<narration>"

  → <artifactId> [entry index for accumulated]:
    <rendered value>
```

- **Icon**: ✓ success, ✗ failure, ⏳ open
- **Actor**: only for action steps
- **Retry tag**: `(retry)` or `(retry N)` when attempt > 1
- **Route**: shown only when non-generic (not "done", "next", etc.)
- **Narration**: the actor's final text output, quoted, always present
  for action steps
- **Artifact entries**: each artifact this step committed, rendered
  with the YAML-like renderer. For accumulated artifacts, show the
  entry index (`[1]`, `[2]`). For non-accumulated, just the value.
- **Failure reason**: shown for failed steps (check failures, engine
  errors, no completion)

Check steps show their command and pass/fail result. Terminal steps
show their summary.

## Accumulated artifact rendering

For accumulated artifacts, each step writes one entry. That entry
appears under the step that wrote it in the timeline. The full
accumulated array is never shown as a batch — it's distributed
across the timeline entries, which IS the chronological order.

This means the planner sees the debate unfold step by step, not as
a dump of the final array.

## What the report builder needs

Currently `buildRunReport` receives `RelayRunState` and `AuditLog`.
It produces `RunReport` with `ArtifactSummary` containing only
`{artifactId, writerStep, description}` — no values.

To render artifact values inline, the report builder needs access to
the committed artifact values. Two options:

**Option A: Pass the ArtifactStore to buildRunReport.**
The report builder calls `store.snapshot()` to get values and pairs
them with timeline entries by matching `stepId`.

**Option B: Include values in ArtifactSummary.**
The caller (scheduler/execute) reads the committed values from the
store and passes them into the report.

Option A is simpler — the store already has everything indexed. The
report builder can look up which artifacts a step committed by
checking the store's entries.

For accumulated artifacts, the store holds `AccumulatedEntry[]`.
The report builder walks the array and distributes entries to the
timeline steps that produced them (matching by `stepId`).

## Non-accumulated artifacts

For non-accumulated artifacts, the value appears under the single
step that wrote it:

```
✓ diagnose — worker
  "Found the bug — subtract uses + instead of -"

  → diagnosis:
    root_cause: subtract function uses + instead of -
    file: src/math.js
    line: 6
    fix: change return a + b to return a - b
```

Same format as accumulated entries, just without the `[N]` index.

## Implementation scope

1. Pass `ArtifactStore` to `buildRunReport` (or to
   `renderRunReportText` directly).
2. For each timeline entry, look up which artifacts the step committed
   and render their values inline.
3. For accumulated artifacts, distribute entries to the timeline step
   that produced each one (match by `AccumulatedEntry.stepId`).
4. Drop tool call rendering from the text report.
5. Keep narration for all action steps.
6. Use `renderValue` for artifact values.
7. Update tests.
