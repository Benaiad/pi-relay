# Attributed Artifacts — Implementation Plan

This document sequences the implementation described in
`ATTRIBUTED_ARTIFACTS.md`. Each phase produces a compiling, testable
increment.

## What already exists

- **`src/runtime/artifacts.ts`** — `ArtifactStore` with `commit(stepId, writes)`
  and `snapshot(reads)`. Accumulated artifacts append via
  `appendToAccumulator(id, value)` which produces a flat `unknown[]`.
- **`src/actors/engine.ts`** — `buildTaskPrompt(instruction, reads,
  artifacts, contracts, priorAttempts)` renders artifacts as JSON in
  code fences via `fenceJson(value)`. No attribution, no identity line.
- **`src/actors/types.ts`** — `ActionRequest` carries `step`, `actor`,
  `artifacts`, `artifactContracts`.
- **`src/plan/types.ts`** — `ArtifactContract` has `accumulate?: boolean`.
- **`src/runtime/scheduler.ts`** — calls `artifactStore.commit(stepId, writes)`
  and builds `ActionRequest` with the artifact snapshot.

## Phase 1: AccumulatedEntry type and store change

Wrap accumulated entries with metadata at commit time.

**Files created:**

- `src/runtime/accumulated-entry.ts`
  ```ts
  export interface AccumulatedEntry {
    readonly index: number;
    readonly stepId: StepId;
    readonly value: unknown;
    readonly committedAt: number;
  }
  ```

**Files changed:**

- `src/runtime/artifacts.ts`
  - `appendToAccumulator(id, value)` → `appendToAccumulator(id, value, stepId)`
  - Each appended entry is wrapped as `AccumulatedEntry` with
    `index` (0-based, increments per append), `stepId` (from the
    commit call), `committedAt` (from the clock).
  - `commit()` already receives `stepId` — pass it through to
    `appendToAccumulator`.
  - The stored value for accumulated artifacts becomes
    `AccumulatedEntry[]` instead of `unknown[]`.
  - `snapshot()` returns the `AccumulatedEntry[]` as-is for
    accumulated artifacts. The presentation layer handles rendering.

**Verify:** Update existing accumulate tests in
`test/runtime/artifacts.test.ts` to assert that entries are
`AccumulatedEntry` objects with `index`, `stepId`, `committedAt`.
Existing non-accumulated tests remain unchanged.

**Commit:** `feat: wrap accumulated artifact entries with attribution metadata`

## Phase 2: Actor self-identification in task prompt

Add identity line to the task prompt.

**Files changed:**

- `src/actors/engine.ts`
  - `buildTaskPrompt` gains `actorName: string` and `stepId: StepId`
    parameters.
  - First line becomes `You are: ${actorName} (step: ${unwrap(stepId)})`
    before the `Task:` line.
  - `runAction` passes `actor.name` and `step.id` to `buildTaskPrompt`.

**Verify:** Add a test in `test/actors/` (or update existing engine
prompt tests) asserting the identity line is present and correctly
formatted.

**Commit:** `feat: inject actor identity into task prompt`

## Phase 3: YAML-like value renderer

A simple renderer that produces human-readable, token-efficient
output from artifact values. No YAML library dependency.

**Files created:**

- `src/actors/render-value.ts`
  ```ts
  export const renderValue = (value: unknown, indent?: number): string
  ```

  Rules:
  - `null` → `null`
  - `boolean` → `true` / `false`
  - `number` → `String(number)`
  - `string` → unquoted if safe (no colons, newlines, leading
    special chars), quoted otherwise
  - `object` → one line per key, value on same line if primitive,
    indented block if nested
  - `array` → one line per element prefixed with `- `
  - Depth limit (4 levels) — beyond that, fall back to inline JSON

  Target: readable by an LLM, not a YAML parser. Does not need to
  round-trip. Optimizes for token count and clarity.

**Verify:** Unit tests covering each value type, nested objects,
arrays of objects, strings with special characters, depth limit
fallback.

**Commit:** `feat: YAML-like value renderer for artifact presentation`

## Phase 4: Attributed artifact rendering in task prompt

Wire the renderer and attribution into `buildTaskPrompt`.

**Files changed:**

- `src/actors/engine.ts`
  - `buildTaskPrompt` detects accumulated artifacts by checking if the
    snapshot value is an `AccumulatedEntry[]` (check for the `stepId`
    property on the first element).
  - For accumulated artifacts, render each entry with an attribution
    header:
    ```
    [1] by philosopher (step: argue):
      position: free will is an illusion
      argument: ...
    ```
    Actor name is resolved from `step.actor` via `unwrap()` — the
    engine has the program's step definitions available, or the actor
    name can be passed alongside the entry. Simplest: resolve from
    the `ActionRequest` which carries the actor config.
    
    For entries from OTHER steps (in multi-actor accumulated
    artifacts), the engine needs access to the program to resolve
    step → actor. Add `program: Program` to the parameters or pass
    a resolver function.
  - For non-accumulated artifacts, replace `fenceJson(value)` with
    `renderValue(value)`.
  - Keep `fenceJson` as fallback for edge cases where `renderValue`
    produces something too long or unreadable.

- `src/runtime/scheduler.ts`
  - The `ActionRequest` already carries `artifactContracts`. Add
    `program` (or a step→actor resolver) so the engine can look up
    actor names for entries from other steps.

**Verify:** Integration test: create a plan with two actors writing
to the same accumulated artifact, compile, run with a scripted
engine, capture the task prompt passed to the second actor, assert
it contains attributed entries with correct actor names and step IDs.

**Commit:** `feat: render accumulated artifacts with attribution in task prompt`

## Phase 5: Attempt number on accumulated entries

Track which attempt of a step produced each entry.

**Files changed:**

- `src/runtime/accumulated-entry.ts` — add `attempt: number` to
  `AccumulatedEntry`.
- `src/runtime/artifacts.ts` — `commit()` gains an optional
  `attempt?: number` parameter. The scheduler passes the current
  attempt count for the step.
- `src/runtime/scheduler.ts` — pass `state.steps.get(stepId).attempts`
  to `commit()` when committing action step writes.
- `src/actors/engine.ts` — include attempt number in the attribution
  header when `attempt > 1`:
  ```
  [3] by philosopher (step: argue, attempt 2):
  ```

**Verify:** Test with a scripted engine that re-enters a step via
back-edge. Assert the second entry's attempt number is 2.

**Commit:** `feat: track attempt number on accumulated entries`

## Phase 6: Update existing tests

Review and update tests that assert on artifact snapshot values.
Accumulated artifact snapshots now return `AccumulatedEntry[]`
instead of `unknown[]`. Tests that access `.value` on accumulated
entries need to unwrap through the entry structure.

**Verify:** Full test suite passes. `npm test`.

**Commit:** `test: update artifact tests for AccumulatedEntry shape`
