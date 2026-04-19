# Flatten Step Types — Implementation Plan

Implements [FLATTEN_STEP_TYPES.md](./FLATTEN_STEP_TYPES.md).

## What already exists

The current step model uses three step kinds (`action`, `check`,
`terminal`) where `check` contains a nested `CheckSpec` union
(`file_exists | command_exits_zero`). The refactoring eliminates
the `check` kind entirely, promoting each check variant to a
top-level step kind (`verify_command`, `verify_files_exist`).

Action steps and their `routes` array are unchanged.

### Files that change

| File | Role | Change |
|---|---|---|
| `src/plan/types.ts` | Domain types | Delete `CheckStep`, `CheckSpec`. Add `VerifyCommandStep`, `VerifyFilesExistStep`. Update `Step` union. |
| `src/plan/draft.ts` | TypeBox schema | Delete `CheckStepSchema`, `CheckSpecSchema`. Add `VerifyCommandStepSchema`, `VerifyFilesExistStepSchema`. Update `StepSchema` union. |
| `src/plan/compile.ts` | Compiler | Replace `brandCheck` with `brandVerifyCommand` + `brandVerifyFilesExist`. Update `buildEdges` cases. |
| `src/runtime/events.ts` | Event union + reducer | Rename `check_passed` → `verify_passed`, `check_failed` → `verify_failed`. Update reducer cases. Rename `CHECK_PASS`/`CHECK_FAIL` constants. |
| `src/runtime/checks.ts` | Check execution engine | Delete `runCheck`. Replace with `runVerifyCommand` + `runFilesExist`. Each takes its step type directly. |
| `src/runtime/scheduler.ts` | Step dispatch | Replace `case "check"` with `case "verify_command"` and `case "verify_files_exist"`. Split `executeCheck` into two methods. Update `describeCheck`. |
| `src/runtime/run-report.ts` | Report builder | Update `describeCheckInline` → `describeVerifyStep`. Update `check_passed`/`check_failed` cases in timeline builder. Rename `AttemptOutcome` variants `check_pass` → `verify_pass`, `check_fail` → `verify_fail`. Update `StepSummary.checkDescription` → `verifyDescription`. |
| `src/render/run-result.ts` | TUI rendering | Update `describeCheckInline`, `describeCheck`, `describeActiveStep`, `appendAttemptBlock` to dispatch on new step kinds. Rename `check_pass`/`check_fail` outcome references. |
| `src/render/plan-preview.ts` | Plan review rendering | Replace `buildCheckBlock` with `buildVerifyCommandBlock` + `buildVerifyFilesExistBlock`. Replace `describeCheckForReview`. |
| `src/execute.ts` | Orchestration | Update `summarizePlanImpact`: replace `step.kind === "check"` with verify kind checks. Rename `checkStepCount` → `verifyStepCount`. |
| `examples/sample-plan.json` | Example plan | Replace check step with `verify_command` step. |
| `plans/*.md` | Bundled templates (4 files) | Replace `kind: check` + nested `check:` with `kind: verify_command` + flat fields. |
| `examples/autoresearch/autoresearch.md` | Example template | Same as above. |
| `README.md` | Docs | Update template example snippet. |
| `test/runtime/checks.test.ts` | Check engine tests | Rewrite to test `runVerifyCommand` + `runFilesExist` directly. |
| `test/plan/draft.test.ts` | Schema validation tests | Update check step fixtures to verify step fixtures. Update invalid-kind test. |
| `test/plan/compile.test.ts` | Compiler tests | Update 2 check step fixtures → verify step fixtures. |
| `test/runtime/scheduler.test.ts` | Scheduler tests | Update 4 check step fixtures. Update `check_passed`/`check_failed` event assertions. |
| `test/index.confirmation.test.ts` | Confirmation dialog tests | Update 3 check step fixtures. |
| `test/replay.integration.test.ts` | Replay test | Update 1 check step in YAML template fixture. |
| `test/templates/discovery.test.ts` | Template discovery test | Update 1 check step in YAML fixture. |
| `test/templates/substitute.test.ts` | Template substitution test | Update 1 check step in expected output fixture. |

### Architecture decisions

1. **Events rename from `check_*` to `verify_*`.** The event
   names should match the step vocabulary. Internal constants
   `CHECK_PASS`/`CHECK_FAIL` become `VERIFY_PASS`/`VERIFY_FAIL`.
   The `AttemptOutcome` variants `check_pass`/`check_fail` become
   `verify_pass`/`verify_fail`.

2. **`verify_files_exist` takes `paths: string[]` (min 1).**
   Semantics: all must exist. Failure reason lists missing paths.
   The current `file_exists` check takes a single `path: string`;
   this changes to an array.

3. **No shared base type for verify steps.** TypeScript structural
   typing means `VerifyCommandStep` and `VerifyFilesExistStep` are
   independently defined. Both have `id`, `onPass`, `onFail` but
   there is no `VerifyBase` interface — the overlap is small enough
   that sharing adds indirection without value.

4. **`runCheck` is deleted, not refactored.** Each verify kind gets
   its own standalone execution function. No dispatcher needed when
   the scheduler already dispatches on step kind.

5. **`describeCheck` functions split by call site.** The run-report,
   run-result, and plan-preview each had their own `describeCheck`
   variant. Each becomes a `describeVerifyStep` that dispatches on
   the step kind. The logic is trivial enough that sharing across
   renderers is not worth the coupling.

### Data flow (unchanged)

The overall data flow is identical. The only structural change is
that `executeStep` dispatches to four cases instead of three, and
the check execution functions receive their step type directly
instead of a `CheckSpec` extracted from a `CheckStep`.

### Risks

- **Template YAML parsing.** Templates embed plan YAML that flows
  through `PlanDraftSchema` validation. Changing the schema means
  all bundled templates must be updated atomically. This is
  mechanical but a compile error in any template will surface at
  runtime (template load), not at compile time. Mitigation: the
  existing template discovery tests will catch this.

- **Audit log replay.** Renaming events from `check_*` to `verify_*`
  means any persisted audit logs with the old event names won't
  replay correctly. This is acceptable per the design doc (no
  backward compatibility). There is no persistent audit log today;
  events are in-memory per run.

## Implementation steps

Each step leaves the codebase compiling and tests passing.

### Step 1: Domain types (`src/plan/types.ts`)

Delete `CheckSpec` and `CheckStep`. Add:

```typescript
interface VerifyCommandStep {
  readonly kind: "verify_command";
  readonly id: StepId;
  readonly command: string;
  readonly timeoutMs?: number;
  readonly onPass: StepId;
  readonly onFail: StepId;
}

interface VerifyFilesExistStep {
  readonly kind: "verify_files_exist";
  readonly id: StepId;
  readonly paths: readonly string[];
  readonly onPass: StepId;
  readonly onFail: StepId;
}
```

Update the `Step` union:

```typescript
type Step = ActionStep | VerifyCommandStep | VerifyFilesExistStep | TerminalStep;
```

This will break every downstream `switch (step.kind)` exhaustiveness
check, which is exactly the point — the compiler will flag every
site that needs updating.

**Verify:** The project will NOT compile — the remaining steps fix
the downstream breakage in dependency order.

### Step 2: TypeBox schema (`src/plan/draft.ts`)

Delete `CheckSpecSchema` and `CheckStepSchema`. Add:

- `VerifyCommandStepSchema` — flat object with `kind: "verify_command"`,
  `id`, `command`, `timeoutMs?` (default 600000, max 600000),
  `onPass`, `onFail`.
- `VerifyFilesExistStepSchema` — flat object with `kind: "verify_files_exist"`,
  `id`, `paths` (array, minItems 1), `onPass`, `onFail`.

Update `StepSchema` union to include the two new schemas instead
of `CheckStepSchema`.

Carry schema descriptions forward from the existing `CheckSpecSchema`
descriptions, adapted for the flat step context.

**Verify:** Project still won't compile (downstream references to
`CheckStep` remain), but the schema module itself will be
self-consistent.

### Step 3: Compiler (`src/plan/compile.ts`)

- Remove `CheckStep` from imports. Add `VerifyCommandStep`,
  `VerifyFilesExistStep`.
- Replace `brandCheck` with `brandVerifyCommand` and
  `brandVerifyFilesExist`. Each produces its respective step type.
- Update `brandStep` switch: remove `case "check"`, add
  `case "verify_command"` and `case "verify_files_exist"`.
- Update `buildEdges` switch: replace `case "check"` with two
  cases for verify kinds. Both use the same `VERIFY_PASS_ROUTE` /
  `VERIFY_FAIL_ROUTE` constants (renamed from `CHECK_*`).

**Verify:** Compiler module compiles. Other modules still broken.

### Step 4: Events and reducer (`src/runtime/events.ts`)

- Rename event kinds: `check_passed` → `verify_passed`,
  `check_failed` → `verify_failed`.
- Update `applyEvent` reducer: rename the two case arms.
- Rename constants: `CHECK_PASS` → `VERIFY_PASS`,
  `CHECK_FAIL` → `VERIFY_FAIL`.

**Verify:** Events module compiles. Downstream consumers (scheduler,
reports, renderer) still reference old event names.

### Step 5: Check execution engine (`src/runtime/checks.ts`)

- Delete `runCheck` dispatcher function.
- Rename `runFileExists` → `runFilesExist`. Change parameter from
  `Extract<CheckSpec, { kind: "file_exists" }>` to
  `VerifyFilesExistStep`. Iterate `step.paths` and check each.
  Collect missing paths into the failure reason.
- Rename `runCommandExitsZero` → `runVerifyCommand`. Change
  parameter from `Extract<CheckSpec, ...>` to `VerifyCommandStep`.
  Read `step.command` and `step.timeoutMs` directly. Drop `cwd`
  parameter — the execution context's `cwd` is always used.
  Change default timeout from 60s to 600s (10 minutes).
- Update imports: remove `CheckSpec`, add step types.
- Export `runVerifyCommand` and `runFilesExist` individually.

**Verify:** Checks module compiles.

### Step 6: Scheduler (`src/runtime/scheduler.ts`)

- Update imports: remove `CheckStep`, `CheckSpec`. Add verify step
  types.
- Update `executeStep` switch: remove `case "check"`, add
  `case "verify_command"` and `case "verify_files_exist"`.
- Replace `executeCheck` with `executeVerifyCommand` and
  `executeVerifyFilesExist`. Each calls its respective execution
  function from the checks module and emits `verify_passed` /
  `verify_failed` events.
- Update `describeCheck` → `describeVerifyStep`. Dispatch on step
  kind to produce the human-readable description. Used for the
  `lastCheckResult` forwarding.
- Update references to `check_passed`/`check_failed` if any exist
  in string form.

**Verify:** Scheduler compiles.

### Step 7: Run report (`src/runtime/run-report.ts`)

- Rename `AttemptOutcome` variants: `check_pass` → `verify_pass`,
  `check_fail` → `verify_fail`.
- Update `buildAttemptTimeline`: rename `case "check_passed"` →
  `case "verify_passed"`, `case "check_failed"` → `case "verify_failed"`.
  Update outcome values in the closed attempt records.
- Update `buildStepSummary`: replace `step.kind === "check"` with
  a check for verify kinds. `describeCheckInline` → `describeVerifyStep`.
- Rename `StepSummary.checkDescription` → `verifyDescription`.
- Update `formatTimelineEntry`: replace `step.kind === "check"` with
  verify kind checks. Replace `attempt.outcome === "check_fail"` with
  `"verify_fail"`.
- Delete `describeCheckInline`, replace with `describeVerifyStep`
  that dispatches on step kind.

**Verify:** Run report compiles.

### Step 8: TUI renderers

**`src/render/run-result.ts`:**

- Update `appendAttemptBlock`: replace `step.kind === "check"` with
  checks for verify kinds. Update `describeCheckInline` call →
  `describeVerifyStep`.
- Update `describeActiveStep`: replace `step.kind === "check"` with
  verify kind checks.
- Delete `describeCheck` and `describeCheckInline`. Replace with
  `describeVerifyStep` that dispatches on step kind.
- Update `iconForAttemptOutcome`: rename `check_pass` → `verify_pass`,
  `check_fail` → `verify_fail`.

**`src/render/plan-preview.ts`:**

- Update `buildStepBlock` switch: remove `case "check"`, add
  `case "verify_command"` and `case "verify_files_exist"`.
- Replace `buildCheckBlock` with `buildVerifyCommandBlock` and
  `buildVerifyFilesExistBlock`. Each renders its step type with
  the appropriate description format.
- Delete `describeCheckForReview`.

**Verify:** Both renderer modules compile.

### Step 9: Execute pipeline (`src/execute.ts`)

- Update `PlanImpact`: rename `checkStepCount` → `verifyStepCount`.
- Update `summarizePlanImpact`: replace `step.kind === "check"` with
  checks for both verify kinds. For `verify_command`, push the
  command string into `commandChecks` and set `mayRunCommands`.

**Verify:** Full project compiles (`npm run build` / `tsc`).

### Step 10: Tests — checks engine (`test/runtime/checks.test.ts`)

Rewrite to test `runVerifyCommand` and `runFilesExist` directly.
The test structure stays the same — same scenarios, same assertions —
but each test constructs a verify step object instead of a `CheckSpec`.

For `runFilesExist`, add a test case with multiple paths where some
exist and some don't, verifying the failure reason lists the missing
ones.

**Verify:** `npm test -- checks.test` passes.

### Step 11: Tests — schema validation (`test/plan/draft.test.ts`)

Update all check step fixtures to use the new verify step shapes.
Update the invalid-check-kind test to use an invalid `kind` value
at the step level (e.g. `kind: "verify_nope"`).

**Verify:** `npm test -- draft.test` passes.

### Step 12: Tests — compiler (`test/plan/compile.test.ts`)

Update 2 check step fixtures → `verify_files_exist` (these used
`file_exists`). Adjust assertions if step kind names appear in
error messages.

**Verify:** `npm test -- compile.test` passes.

### Step 13: Tests — scheduler (`test/runtime/scheduler.test.ts`)

Update 4 check step fixtures → `verify_command` (these used
`command_exits_zero`). Update event assertions from `check_passed` /
`check_failed` to `verify_passed` / `verify_failed`.

**Verify:** `npm test -- scheduler.test` passes.

### Step 14: Tests — confirmation + replay + templates

- `test/index.confirmation.test.ts`: Update 3 check step fixtures.
- `test/replay.integration.test.ts`: Update YAML template fixture
  (1 check step).
- `test/templates/discovery.test.ts`: Update YAML fixture (1 check
  step).
- `test/templates/substitute.test.ts`: Update expected output
  fixture (1 check step).

**Verify:** `npm test` — full suite green.

### Step 15: Templates and examples

Update all plan template YAML files to use the new step kinds:

- `plans/verified-edit.md`: `kind: check` + `check: { kind: command_exits_zero, command: "{{verify}}" }` → `kind: verify_command` + `command: "{{verify}}"`. Drop any `cwd` fields.
- `plans/reviewed-edit.md`: Same pattern.
- `plans/bug-fix.md`: Same pattern.
- `plans/multi-gate.md`: 3 check steps, same pattern each.
- `examples/autoresearch/autoresearch.md`: 3 check steps.
- `examples/sample-plan.json`: Replace check step JSON.
- `README.md`: Update template example snippet.

**Verify:** `npm test` — full suite still green (template tests
exercise these files).

### Step 16: Final verification

```
npm run format
npm run lint
npm test
npm run build
```

Commit with message:
```
refactor: flatten check step into verify_command and verify_files_exist

Replace the nested CheckStep/CheckSpec discriminated union with
two top-level step kinds. Each verify kind is a flat step type
with its own fields and no nested check object.

Events renamed: check_passed → verify_passed, check_failed → verify_failed.
AttemptOutcome variants: check_pass → verify_pass, check_fail → verify_fail.
verify_files_exist takes paths: string[] instead of path: string.
Default verify_command timeout: 60s → 600s.
Drop cwd from verify_command (always uses plan working directory).
```
