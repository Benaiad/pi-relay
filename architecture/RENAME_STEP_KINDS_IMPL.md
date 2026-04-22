# Rename Step Kinds — Implementation Plan

Break free of the verification-gate naming. These steps are
general-purpose deterministic computation nodes — they read
artifacts, run arbitrary commands, and route on outcomes. Three
groups of renames:

1. **Step kinds:** `verify_command` → `command`,
   `verify_files_exist` → `files_exist`
2. **Routing fields:** `onPass` → `onSuccess`, `onFail` → `onFailure`
   (matches terminal step vocabulary: `outcome: "success" | "failure"`)
3. **Event kinds:** `verify_passed` → `check_passed`,
   `verify_failed` → `check_failed`

## Scope

Clean break, no deprecation aliases. pi-relay is v0.1.0 with no
published API stability guarantees. User templates that reference old
names will get clear schema validation errors.

## What does NOT rename

- **`PriorCheckResult`**, `lastCheckResult`, `priorCheckResult` —
  "check" is the right abstraction for "run something deterministic
  and report the outcome."
- **`CheckOutcome`**, `CheckContext`, `CheckOutputCallback` in
  `checks.ts` — same reasoning.
- **`runFilesExist`** in `checks.ts` — already clean, no "verify"
  prefix.
- **Architecture docs** — historical. New docs use the new names.

## Rename map

### Step kinds and types

| Old | New |
|-----|-----|
| `"verify_command"` (kind literal) | `"command"` |
| `"verify_files_exist"` (kind literal) | `"files_exist"` |
| `VerifyCommandStep` (type) | `CommandStep` |
| `VerifyFilesExistStep` (type) | `FilesExistStep` |
| `VerifyCommandStepSchema` (schema) | `CommandStepSchema` |
| `VerifyFilesExistStepSchema` (schema) | `FilesExistStepSchema` |
| `brandVerifyCommand` (compiler fn) | `brandCommand` |
| `brandVerifyFilesExist` (compiler fn) | `brandFilesExist` |
| `executeVerifyCommand` (scheduler) | `executeCommand` |
| `executeVerifyFilesExist` (scheduler) | `executeFilesExist` |
| `buildVerifyCommandBlock` (preview) | `buildCommandBlock` |
| `buildVerifyFilesExistBlock` (preview) | `buildFilesExistBlock` |
| `describeVerifyStep` (scheduler) | `describeCommandStep` |
| `describeVerifyStep` (run-report) | `describeCommandStep` |
| `describeVerifyStepInline` (run-result) | `describeCommandStepInline` |
| `describeVerifyStepShort` (run-result) | `describeCommandStepShort` |
| `runVerifyCommand` (checks.ts) | `runCommand` |

### Routing fields

| Old | New |
|-----|-----|
| `onPass` (schema field) | `onSuccess` |
| `onFail` (schema field) | `onFailure` |
| `VERIFY_PASS_ROUTE` (compile.ts constant) | `SUCCESS_ROUTE` |
| `VERIFY_FAIL_ROUTE` (compile.ts constant) | `FAILURE_ROUTE` |
| `VERIFY_PASS` (events.ts constant) | `CHECK_SUCCESS` |
| `VERIFY_FAIL` (events.ts constant) | `CHECK_FAILURE` |

The internal `RouteId` values also change:
- `RouteId("pass")` → `RouteId("success")`
- `RouteId("fail")` → `RouteId("failure")`

These are edge keys in the compiled program. The scheduler uses them
to look up the next step after a check. The values must match between
compile.ts (which creates the edges) and scheduler.ts / events.ts
(which look them up).

### Event kinds

| Old | New |
|-----|-----|
| `"verify_passed"` | `"check_passed"` |
| `"verify_failed"` | `"check_failed"` |

These appear in the `RelayEvent` union, the `applyEvent` reducer,
the `buildAttemptTimeline` walker, and any test that matches on
event kinds.

## File-by-file changes

### Source

**`src/plan/draft.ts`**
- Kind literals: `"verify_command"` → `"command"`,
  `"verify_files_exist"` → `"files_exist"`
- Schema names: `VerifyCommandStepSchema` → `CommandStepSchema`,
  `VerifyFilesExistStepSchema` → `FilesExistStepSchema`
- Field names: `onPass` → `onSuccess`, `onFail` → `onFailure`
  (on both step schemas)
- Update descriptions

**`src/plan/types.ts`**
- Interface renames + kind literals
- Field renames: `onPass` → `onSuccess`, `onFail` → `onFailure`
  (on both `CommandStep` and `FilesExistStep`)

**`src/plan/compile.ts`**
- Import renames
- Function renames: `brandVerifyCommand` → `brandCommand`, etc.
- `brandStep` switch cases
- `brandCommand`: `doc.onPass` → `doc.onSuccess`,
  `doc.onFail` → `doc.onFailure`
- `brandFilesExist`: same field renames
- `buildEdges` switch cases + field access:
  `step.onPass` → `step.onSuccess`, `step.onFail` → `step.onFailure`
- Route constants: `VERIFY_PASS_ROUTE` → `SUCCESS_ROUTE`,
  `VERIFY_FAIL_ROUTE` → `FAILURE_ROUTE`, values change to
  `RouteId("success")` / `RouteId("failure")`
- `buildArtifacts` kind check

**`src/runtime/events.ts`**
- Event union: `"verify_passed"` → `"check_passed"`,
  `"verify_failed"` → `"check_failed"`
- Reducer cases in `applyEvent`
- Constants: `VERIFY_PASS` → `CHECK_SUCCESS`,
  `VERIFY_FAIL` → `CHECK_FAILURE`, values change to
  `RouteId("success")` / `RouteId("failure")`

**`src/runtime/scheduler.ts`**
- Import renames
- `executeStep` switch cases
- Method renames
- `describeVerifyStep` → `describeCommandStep`
- Route ID usage: `makeRouteId("pass")` → `makeRouteId("success")`,
  `makeRouteId("fail")` → `makeRouteId("failure")`
- `handleActionCompleted` target kind check

**`src/runtime/checks.ts`**
- `runVerifyCommand` → `runCommand`
- Import renames
- Doc comment updates

**`src/runtime/run-report.ts`**
- Kind checks
- Function rename
- Event kind matches in `buildAttemptTimeline`:
  `"verify_passed"` → `"check_passed"`,
  `"verify_failed"` → `"check_failed"`

**`src/render/plan-preview.ts`**
- Function renames + switch cases
- Field access: `step.onPass` → `step.onSuccess`,
  `step.onFail` → `step.onFailure`

**`src/render/run-result.ts`**
- Kind checks + function renames

**`src/execute.ts`**
- Kind check in `summarizePlanImpact`

### Templates (all `.md` files)

Every bundled template and example:
- `kind: verify_command` → `kind: command`
- `kind: verify_files_exist` → `kind: files_exist`
- `onPass:` → `onSuccess:`
- `onFail:` → `onFailure:`

Files: `plans/verified-edit.md`, `plans/bug-fix.md`,
`plans/reviewed-edit.md`, `plans/multi-gate.md`,
`examples/autoresearch/autoresearch.md`,
`examples/sample-plan.json`.

### Tests

Every test file that constructs step objects or plan fixtures:
- Kind literals
- `onPass` → `onSuccess`, `onFail` → `onFailure`
- Import renames (`runVerifyCommand` → `runCommand`)
- Event kind matches (`"verify_passed"` → `"check_passed"`, etc.)

Files: `test/plan/draft.test.ts`, `test/plan/compile.test.ts`,
`test/runtime/checks.test.ts`, `test/runtime/scheduler.test.ts`,
`test/templates/substitute.test.ts`,
`test/templates/discovery.test.ts`,
`test/replay.integration.test.ts`,
`test/index.confirmation.test.ts`.

### README

- Step kinds section
- Custom templates example
- Core concepts descriptions
- Routes section (`onPass` / `onFail` → `onSuccess` / `onFailure`)

## Implementation strategy

Single commit. Purely mechanical — no logic changes, no new
behavior, no new tests.

Order:

1. Domain types (`types.ts`)
2. Schema (`draft.ts`)
3. Compiler (`compile.ts`)
4. Events (`events.ts`)
5. Runtime (`checks.ts`, `scheduler.ts`)
6. Report + render (`run-report.ts`, `plan-preview.ts`,
   `run-result.ts`, `execute.ts`)
7. Templates and examples
8. Tests
9. README

Verify after every layer: `npx tsc --noEmit`. Full suite at the end:
`npm run check && npm test`.

**Commit:** `refactor: rename verify steps to command/files_exist, onPass/onFail to onSuccess/onFailure`

## Risks

- **User templates break.** Clear schema errors with valid options
  listed. Low risk at v0.1.0.

- **RouteId value change.** Internal edge keys change from
  `"pass"/"fail"` to `"success"/"failure"`. Both compile.ts and
  scheduler.ts/events.ts must agree. The compiler creates edges with
  these values; the scheduler looks them up. If they mismatch, the
  scheduler fails with "no edge from X on route Y" — loud, not
  silent. Tests catch this.
