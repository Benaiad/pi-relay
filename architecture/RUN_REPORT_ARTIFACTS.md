# Run Report: Add Artifact Values Inline

## Problem

When a relay run finishes, the planner receives a text report to
narrate the result to the user. The report currently shows tool calls,
narration, and routes — but artifact values are missing. The planner
sees `Produced: debate_log` but never the debate content itself.

## Change

Add artifact values inline after each step, keeping everything else
as-is. The report gains one new section per step: the artifact values
that step committed.

## What the planner sees (before → after)

Before:
```
✓ diagnose — worker
  → read src/auth/login.ts
  "Found the root cause: encodeURIComponent converts + to %2B"

Produced: diagnosis, fix_notes
```

After:
```
✓ diagnose — worker
  → read src/auth/login.ts
  "Found the root cause: encodeURIComponent converts + to %2B"

  artifact diagnosis:
    root_cause: encodeURIComponent converts + to %2B
    file: src/auth/login.ts
    fix: add decodeURIComponent before the query
```

## Full example: debate

```
Relay run: SUCCESS — Debate: Should we migrate to GraphQL?

✓ argue — advocate
  → read src/api/users.ts
  → grep /fields/ in src/api/
  "GraphQL eliminates overfetching — our users endpoint returns 40
   fields when the mobile app needs 5."

  artifact debate_log [1]:
    role: advocate
    argument: GraphQL solves the overfetching problem...

✓ challenge — critic
  → read src/api/users.ts
  "The overfetching argument is valid but the migration cost is
   understated."

  artifact debate_log [2]:
    role: critic
    critique: Migration cost is understated...

✓ evaluate — judge → resolved
  "The motion fails — retain YAML-like rendering."

  artifact debate_log [3]:
    role: judge
    verdict: resolved
    conclusion: REST with sparse fieldsets solves overfetching
    prevailing_side: critic

Produced: debate_log
Total: 6 turns · $0.12
```

## Rules

1. **Keep everything that's there today.** Tool calls, narration,
   routes, failure reasons, usage — unchanged.
2. **Add artifact values after the narration.** Each artifact the step
   committed is rendered inline using the YAML-like renderer.
3. **Accumulated artifacts show per-step entries.** Each entry appears
   under the step that produced it, with `[N]` index. The timeline
   IS the chronological order.
4. **No cap.** Show all entries. The planner needs the full picture.
5. **Non-accumulated artifacts** show the value without an index.

## Implementation

1. Pass `ArtifactStore` to `renderRunReportText`.
2. For each timeline entry (action step), look up which artifacts
   the step committed. For accumulated artifacts, find entries
   matching the step's `stepId`. For non-accumulated, check if
   the step is the artifact's writer.
3. Render each artifact value using `renderValue` from
   `render-value.ts`, prefixed with `artifact <id>:` (or
   `artifact <id> [N]:` for accumulated).
4. Resolve actor names for accumulated entry attribution using
   the program's step definitions.
5. Update tests.
