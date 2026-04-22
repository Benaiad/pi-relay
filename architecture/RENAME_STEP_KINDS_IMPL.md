# Rename Step Kinds — Implementation Plan

Rename `verify_command` → `command` and `verify_files_exist` →
`files_exist`. These steps are no longer pure verification gates —
they read artifacts, run arbitrary computation, and will soon write
artifacts. The "verify" prefix is a misnomer that actively misleads
about what the steps can do.

## Scope

Clean break, no deprecation aliases. pi-relay is v0.1.0 with no
published API stability guarantees. User templates that reference the
old kind names will get a clear schema validation error with the
correct kind listed.

## What does NOT rename

- **Event kinds** `verify_passed` / `verify_failed` — these describe
  outcomes, not step kinds. A command step still "passes" or "fails."
- **`PriorCheckResult`** and `lastCheckResult` — these describe the
  concept (a check was performed), not the step kind.
- **`CheckOutcome`**, `CheckContext`, `CheckOutputCallback` in
  `checks.ts` — "check" is the right abstraction for "run and report
  pass/fail."
- **Architecture docs** — historical documents. They describe the
  design as it was when written. Updating them retroactively falsifies
  the record. New docs use the new names.

## Rename map

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
| `runVerifyCommand` (checks.ts) | `runCommand` |

## File-by-file changes

### Source (73 occurrences across 9 files)

**`src/plan/draft.ts`** (6)
- `Type.Literal("verify_command")` → `Type.Literal("command")`
- `Type.Literal("verify_files_exist")` → `Type.Literal("files_exist")`
- `VerifyCommandStepSchema` → `CommandStepSchema`
- `VerifyFilesExistStepSchema` → `FilesExistStepSchema`
- Update descriptions: "A deterministic verification step" →
  "A deterministic step"

**`src/plan/types.ts`** (5)
- `VerifyCommandStep` → `CommandStep`
- `VerifyFilesExistStep` → `FilesExistStep`
- Kind literals in both interfaces
- `Step` union uses new names

**`src/plan/compile.ts`** (17)
- Import renames
- `brandVerifyCommand` → `brandCommand`
- `brandVerifyFilesExist` → `brandFilesExist`
- `brandStep` switch cases: `"verify_command"` → `"command"`,
  `"verify_files_exist"` → `"files_exist"`
- `buildEdges` switch cases
- `buildArtifacts` kind check

**`src/runtime/scheduler.ts`** (15)
- Import renames
- `executeStep` switch cases
- `executeVerifyCommand` → `executeCommand`
- `executeVerifyFilesExist` → `executeFilesExist`
- `describeVerifyStep` → `describeCommandStep`
- `handleActionCompleted` target kind check

**`src/runtime/checks.ts`** (6)
- `runVerifyCommand` → `runCommand`
- Parameter types import renames
- Doc comment updates

**`src/runtime/run-report.ts`** (6)
- Kind checks in `buildStepSummary`, `formatTimelineEntry`
- `describeVerifyStep` → `describeCommandStep`

**`src/render/plan-preview.ts`** (8)
- `buildVerifyCommandBlock` → `buildCommandBlock`
- `buildVerifyFilesExistBlock` → `buildFilesExistBlock`
- `buildStepBlock` switch cases
- Extract type narrowing updates

**`src/render/run-result.ts`** (8)
- Kind checks in `appendAttemptBlock`, `describeActiveStep`
- `describeVerifyStepInline` → `describeCommandStepInline`
- `describeVerifyStepShort` → `describeCommandStepShort`

**`src/execute.ts`** (2)
- Kind check in `summarizePlanImpact`

### Templates (6 occurrences across 4 files)

- `plans/verified-edit.md` — `kind: verify_command` → `kind: command`
- `plans/bug-fix.md` — same
- `plans/reviewed-edit.md` — same
- `plans/multi-gate.md` — 3 occurrences, same
- `examples/autoresearch/autoresearch.md` — 3 occurrences, same

### Tests (53 occurrences across 8 files)

- `test/plan/draft.test.ts` — kind literal
- `test/plan/compile.test.ts` — kind literals in plan fixtures
- `test/runtime/checks.test.ts` — kind literals, function import
  rename (`runVerifyCommand` → `runCommand`)
- `test/runtime/scheduler.test.ts` — kind literals in plan fixtures
- `test/templates/substitute.test.ts` — kind literal
- `test/templates/discovery.test.ts` — kind literal
- `test/replay.integration.test.ts` — kind literal
- `test/index.confirmation.test.ts` — kind literals

### README (4 occurrences)

- Step kinds section: `verify_command` → `command`,
  `verify_files_exist` → `files_exist`
- Custom templates example
- Core concepts descriptions

### Incidental

- `examples/sample-plan.json` — kind literal

## Implementation strategy

Single commit. The rename is purely mechanical — no logic changes,
no new behavior, no new tests. Every occurrence of the old name is
replaced with the new name. The rename map above is exhaustive.

Order of edits within the commit:

1. Domain types (`types.ts`) — establishes the new names
2. Schema (`draft.ts`) — wire format matches domain types
3. Compiler (`compile.ts`) — bridges wire to domain
4. Runtime (`checks.ts`, `scheduler.ts`) — execution layer
5. Report + render (`run-report.ts`, `plan-preview.ts`,
   `run-result.ts`, `execute.ts`) — presentation layer
6. Templates and examples (`.md` files)
7. Tests
8. README

Verify after every layer: `npx tsc --noEmit`. Run full suite at the
end: `npm run check && npm test`.

**Commit:** `refactor: rename verify_command to command, verify_files_exist to files_exist`

## Risks

- **User templates break.** Any user-created template with
  `kind: verify_command` will fail schema validation. The TypeBox
  schema error will say the kind is invalid and list the valid
  options. Low risk given v0.1.0 adoption.

- **Muscle memory.** Contributors familiar with the codebase will
  reach for `VerifyCommandStep` and autocomplete won't find it. The
  compiler catches this immediately. No silent breakage.
