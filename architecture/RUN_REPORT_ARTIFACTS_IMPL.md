# Run Report: Artifact Values Inline — Implementation Plan

This document sequences the implementation described in
`RUN_REPORT_ARTIFACTS.md`. The change adds artifact values inline
after each step in the text report the planner receives. Everything
else stays as-is.

## What already exists

- **`src/runtime/run-report.ts`**
  - `RunReport` has `artifacts: ArtifactSummary[]` with
    `{artifactId, writerStep, description}` — no values.
  - `renderRunReportText(report)` walks `report.timeline`, renders
    tool calls (last 6), narration, routes, failure reasons.
  - `buildRunReport(state, audit)` builds the report from run state
    and audit log. Has no access to artifact values.
  - `formatTimelineEntry(step, attempt)` renders one step block.

- **`src/execute.ts`**
  - Creates `ArtifactStore`, `Scheduler`, and calls
    `renderRunReportText(report)` for both `onUpdate` and the final
    result. Has `artifactStore` in scope.

- **`src/runtime/artifacts.ts`**
  - `ArtifactStore.all()` returns all `StoredArtifact[]` with values.
  - `ArtifactStore.snapshot(ids)` returns scoped snapshots.
  - Accumulated artifacts store `AccumulatedEntry[]` as the value.

- **`src/actors/render-value.ts`**
  - `renderValue(value, indent)` produces YAML-like text.

- **`src/runtime/accumulated-entry.ts`**
  - `AccumulatedEntry` with `{index, stepId, attempt, value, committedAt}`.
  - `isAccumulatedEntryArray(value)` type guard.

## Phase 1: Pass artifact store to the report renderer

The report renderer needs artifact values. Currently
`renderRunReportText` takes only `RunReport`. Add the artifact store
as a second parameter.

**Files changed:**

- `src/runtime/run-report.ts`
  - `renderRunReportText(report, artifactStore?)` — optional second
    parameter. When absent, behavior is unchanged (backwards
    compatible for `onUpdate` calls during the run where artifacts
    may be incomplete).
  - Import `ArtifactStore` and `renderValue`.

- `src/execute.ts`
  - Final `renderRunReportText(report)` call becomes
    `renderRunReportText(report, artifactStore)`.
  - The `onUpdate` call during streaming keeps calling without the
    store (artifacts are mid-flight, incomplete).

**Verify:** `npm test` — no behavior change yet, just plumbing.

**Commit:** `refactor: pass artifact store to renderRunReportText`

## Phase 2: Remove tool call cap

Currently `formatTimelineEntry` caps tool calls at 6:
```ts
const shown = toolCalls.slice(-6);
```

Remove the cap. Show all tool calls.

**Files changed:**

- `src/runtime/run-report.ts`
  - Remove `slice(-6)` and the `skipped` counter.

**Verify:** `npm test`.

**Commit:** `refactor: show all tool calls in run report`

## Phase 3: Build per-step artifact index

To render artifact values inline with each step, the renderer needs
to know which artifacts each step committed and their values.

**Files changed:**

- `src/runtime/run-report.ts`
  - Add helper `buildStepArtifactIndex(store, program)` that returns
    `Map<StepId, Array<{artifactId, value}>>`.
  - For each stored artifact:
    - If accumulated (`isAccumulatedEntryArray`): distribute entries
      to the step that produced each one (match by
      `AccumulatedEntry.stepId`). Each entry becomes
      `{artifactId, value: entry}` (the full `AccumulatedEntry`
      with attribution).
    - If non-accumulated: assign to the writer step from the program.
      Value is the raw committed value.
  - The index is built once per `renderRunReportText` call and passed
    to `formatTimelineEntry`.

**Verify:** Unit test: build an index from a mock store with both
accumulated and non-accumulated artifacts. Assert entries are
distributed to the correct steps.

**Commit:** `feat: build per-step artifact index for inline rendering`

## Phase 4: Render artifact values inline

Wire the per-step artifact index into `formatTimelineEntry`.

**Files changed:**

- `src/runtime/run-report.ts`
  - `formatTimelineEntry` gains a `stepArtifacts` parameter:
    the artifacts this step committed.
  - After narration (and route/failure lines), append artifact
    blocks:
    ```
      artifact diagnosis:
        root_cause: encodeURIComponent converts + to %2B
        file: src/auth/login.ts
    ```
  - For accumulated entries, show with index:
    ```
      artifact debate_log [1]:
        role: advocate
        argument: ...
    ```
  - Use `renderValue(value, 2)` for the value body (indent 2 to
    nest under the artifact header).
  - Import `isAccumulatedEntryArray` and `renderValue`.
  - For accumulated entries, resolve actor name from the program
    for the attribution line. The step definition carries the
    actor id.

**Verify:** Integration test: run a plan with artifacts through
the scheduler (scripted engine), call `renderRunReportText` with
the artifact store, assert the output contains artifact values
inline under the correct steps.

**Commit:** `feat: render artifact values inline in run report`

## Phase 5: Update execute.ts onUpdate calls

The `onUpdate` callback fires during the run for live progress. It
currently calls `renderRunReportText(report)` without the store.

Decide: should mid-run updates include partial artifact values?

**Option A:** No — keep `onUpdate` without the store. Artifacts appear
only in the final result. Simpler, no partial state issues.

**Option B:** Yes — pass the store to `onUpdate` too. The user sees
artifacts accumulate in real-time.

Recommendation: **Option A** for now. The TUI's `renderResult` already
shows live state through `details.state`. The text report is for the
planner, which only reads the final result.

**No code change needed if Option A.**

**Commit:** (none)

## Phase 6: Update tests

Review tests that assert on `renderRunReportText` output. Add
assertions for artifact values in the rendered text.

**Files changed:**

- Existing run-report tests — update assertions to expect artifact
  content when a store is provided.
- New test: debate-like plan with accumulated artifact, two actors.
  Assert the rendered report shows attributed entries under the
  correct timeline steps.

**Verify:** `npm test`. 

**Commit:** `test: assert artifact values in rendered run reports`
