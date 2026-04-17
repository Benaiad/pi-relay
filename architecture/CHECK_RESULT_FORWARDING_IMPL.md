# Check Result Forwarding — Implementation Plan

## What already exists

- **`src/runtime/scheduler.ts`**
  - `executeCheck(step)` runs the check, emits `check_passed` or
    `check_failed`, calls `followRoute(step.id, "pass"/"fail")`.
  - `followRoute(fromStep, route)` looks up the edge and calls
    `enqueueReady(target)`.
  - `executeAction(step)` builds an `ActionRequest` and sends it
    to the engine.

- **`src/actors/types.ts`**
  - `ActionRequest` has `step`, `actor`, `artifacts`,
    `priorAttempts`, `stepActorResolver`.

- **`src/actors/engine.ts`**
  - `buildTaskPrompt` renders identity, instruction, prior attempts,
    artifacts, and completion reminder.

- **`src/runtime/checks.ts`**
  - `CheckOutcome` is `{ kind: "pass" } | { kind: "fail"; reason: string }`.
  - Check descriptions are derived from the spec: command string
    for `command_exits_zero`, path for `file_exists`.

## Phase 1: Add PriorCheckResult type and scheduler tracking

**Files changed:**

- `src/actors/types.ts`
  - Add:
    ```ts
    export interface PriorCheckResult {
      readonly stepId: StepId;
      readonly outcome: "passed" | "failed";
      readonly description: string;
    }
    ```
  - Add to `ActionRequest`:
    ```ts
    readonly priorCheckResult?: PriorCheckResult;
    ```

- `src/runtime/scheduler.ts`
  - Add a field `private lastCheckResult: PriorCheckResult | undefined`
    to the `Scheduler` class.
  - In `executeCheck`: after determining pass/fail, set
    `this.lastCheckResult` with the step id, outcome, and a
    description derived from the check spec (command string or
    file path).
  - In `executeAction`: pass `this.lastCheckResult` as
    `priorCheckResult` in the `ActionRequest`, then clear it
    (`this.lastCheckResult = undefined`).
  - In `followRoute`: do NOT clear it — it persists until the next
    action step consumes it. If two checks chain before an action,
    only the most recent is kept.

**Verify:** `npm test`.

**Commit:** `feat: scheduler tracks last check result for forwarding`

## Phase 2: Render check result in task prompt

**Files changed:**

- `src/actors/engine.ts`
  - `buildTaskPrompt` gains the `priorCheckResult` parameter from
    `ActionRequest`.
  - After the identity line and before the instruction, render:
    ```
    ## Prior check result

    step: verify passed
      command: npm test
    ```
    or:
    ```
    ## Prior check result

    step: verify failed
      command: npm test
    ```
  - Only rendered if `priorCheckResult` is defined.
  - Pass `request.priorCheckResult` from `runAction` to
    `buildTaskPrompt`.

- `src/runtime/scheduler.ts`
  - Add helper `describeCheck(spec: CheckSpec): string` that returns
    the command string for `command_exits_zero` or
    `File exists: <path>` for `file_exists`. Reuses the same logic
    as `describeCheckInline` in `run-report.ts`.

**Verify:** Unit test: build a task prompt with a `priorCheckResult`
set, assert the "Prior check result" section is present with the
correct step id, outcome, and description.

**Commit:** `feat: inject prior check result into action step task prompt`

## Phase 3: Integration test

**Files created:**

- Add a test case in `test/runtime/scheduler.test.ts` (or a new
  file):
  - Plan: `implement → verify (check) → fix (action) → verify`
  - Scripted engine captures the `ActionRequest` for the fix step.
  - Assert `request.priorCheckResult` has `outcome: "failed"` and
    `description` matching the check command.
  - Assert `priorCheckResult` is undefined for the implement step
    (no prior check).

**Verify:** `npm test`.

**Commit:** `test: verify check result forwarding to action steps`
