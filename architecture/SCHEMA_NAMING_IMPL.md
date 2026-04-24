# Schema Naming Cleanup — Implementation Plan

References: `architecture/SCHEMA_NAMING.md`

## What already exists

The wire format (what the model writes) is defined in `src/plan/draft.ts` using TypeBox. The compiler in `src/plan/compile.ts` reads the wire format and produces branded domain types defined in `src/plan/types.ts`. The domain types use the same field names as the wire format today — the compiler does a straight field-by-field copy with ID branding.

**Wire format field counts (grep across src/ and test/):**
- `.kind` — 59 occurrences in 13 src files, 77 in 7 test files
- `onSuccess`/`onFailure` — 11 src files
- `entryStep` — used in draft.ts, compile.ts, compile-errors.ts, program.ts, types.ts
- `timeoutMs` — used in draft.ts, compile.ts, types.ts, checks.ts, scheduler.ts
- `maxRuns` — used in draft.ts, compile.ts, types.ts, scheduler.ts
- `successCriteria` — used in draft.ts, compile.ts, program.ts, pi-relay.ts
- `.id` on steps/artifacts — pervasive (branded as StepId/ArtifactId everywhere)

**Bundled plan templates:** 5 YAML files under `plans/` that use wire-format field names.

## Architecture decision

**Wire format is snake_case. Domain types stay camelCase.**

The JSON the model writes uses snake_case — the dominant convention in JSON APIs. The TypeScript code stays camelCase — standard TS convention. The compiler maps between the two. It already does ID branding; adding field name translation is trivial.

## Rename map

### Wire format (`draft.ts` / JSON)

| Current | New |
|---|---|
| `kind` | `type` |
| `id` | `name` |
| `onSuccess` | `on_success` |
| `onFailure` | `on_failure` |
| `entryStep` | `entry_step` |
| `successCriteria` | `success_criteria` |
| `maxRuns` | `max_runs` |
| `timeoutMs` | `timeout` (unit changes to seconds) |

### Domain types (`types.ts` / TypeScript)

| Current | New |
|---|---|
| `kind` | `type` |
| `id` | `name` (branded StepId/ArtifactId) |
| `onSuccess` | unchanged |
| `onFailure` | unchanged |
| `entryStep` | unchanged |
| `successCriteria` | unchanged |
| `maxRuns` | unchanged |
| `timeoutMs` | `timeout` (seconds; runtime converts to ms at point of use) |

Only two domain fields actually rename: `kind` -> `type` and `id` -> `name`. These are semantic improvements, not convention changes. The camelCase multi-word fields stay camelCase in TS.

The compiler maps: `doc.on_success` -> `step.onSuccess`, `doc.entry_step` -> `program.entryStep`, etc.

### Fields that stay the same in both layers

`task`, `instruction`, `command`, `paths`, `description`, `summary`, `outcome`, `reads`, `writes`, `routes`, `fields`, `list`, `actor`.

## Step-by-step implementation

Each step produces a compiling, testable increment. Run `npm run check && npm test` after each.

### Step 1: Rename wire format in `draft.ts`

**Files:** `src/plan/draft.ts`

This is the source of truth for the wire format. All field name changes happen here.

- Rename `IdField` to `NameField`. Same validation rules.
- In `ActionStepSchema`: `kind` -> `type`, `id` -> `name`, `maxRuns` -> `max_runs`.
- In `CommandStepSchema`: `kind` -> `type`, `id` -> `name`, `timeoutMs` -> `timeout`, `onSuccess` -> `on_success`, `onFailure` -> `on_failure`.
- For `timeout`: change type constraints from `minimum: 100, maximum: 600_000` (ms) to `minimum: 1, maximum: 7200` (seconds). Update description to say seconds. Default 600 (10 minutes).
- In `FilesExistStepSchema`: `kind` -> `type`, `id` -> `name`, `onSuccess` -> `on_success`, `onFailure` -> `on_failure`.
- In `TerminalStepSchema`: `kind` -> `type`, `id` -> `name`.
- In `ArtifactContractSchema`: `id` -> `name`.
- In `PlanDraftSchema`: `entryStep` -> `entry_step`, `successCriteria` -> `success_criteria`.
- Update all `description` strings: replace "StepId" with "step name", "ArtifactId" with "artifact name", "ActorId" with "actor name".
- Update the `StepSchema` union description.

The `PlanDraftDoc` type is derived via `Static<typeof PlanDraftSchema>` so it updates automatically.

After this step: `draft.ts` compiles but `compile.ts` breaks because it reads the old field names from `PlanDraftDoc`.

### Step 2: Rename domain types

**Files:** `src/plan/types.ts`, `src/plan/program.ts`

Only two field names change in the domain types:

In `types.ts`:
- All step interfaces: `kind` -> `type`, `id` -> `name`.
- `ArtifactContract`: `id` -> `name`.
- `ArtifactShape`: `kind` -> `type` (same reasoning — discriminated union).
- `CommandStep`: `timeoutMs` -> `timeout` (now seconds).
- All camelCase fields (`onSuccess`, `onFailure`, `maxRuns`) stay as-is.
- `PlanDraft`: unchanged (camelCase stays).

In `program.ts`:
- No field renames. `entryStep`, `successCriteria` stay camelCase.

After this step: types.ts and program.ts compile, but everything that reads `.kind`, `.id`, or `.timeoutMs` breaks.

### Step 3: Update compiler

**Files:** `src/plan/compile.ts`

The compiler maps wire format (snake_case) to domain types (camelCase). After step 1, the wire-format fields have new names. Update the compiler to read the new wire names and produce the updated domain types.

- `brandStep`: match on `doc.type` instead of `doc.kind`.
- `brandAction`: `doc.name` -> `StepId(doc.name)`, `doc.max_runs` -> `maxRuns`.
- `brandCommand`: `doc.name` -> `StepId(doc.name)`, `doc.on_success` -> `onSuccess`, `doc.on_failure` -> `onFailure`, `doc.timeout` -> `timeout` (passthrough — both seconds now).
- `brandFilesExist`: `doc.name`, `doc.on_success` -> `onSuccess`, `doc.on_failure` -> `onFailure`.
- `brandTerminal`: `doc.name`.
- `buildArtifacts`: `c.name` instead of `c.id`.
- `compile`: `doc.entry_step` -> `entryStep`, `doc.success_criteria` -> `successCriteria`.
- Entry step check: `stepsById.get(entryStep)?.type === "terminal"`.

### Step 3b: Update timeout handling

**Files:** `src/runtime/checks.ts`, `src/runtime/scheduler.ts`

`CommandStep.timeout` is now seconds. Runtime converts at point of use.

- `checks.ts`: `const timeoutMs = step.timeout ? step.timeout * 1000 : DEFAULT_COMMAND_TIMEOUT_MS`.
- `scheduler.ts`: any reads of `step.timeoutMs` become `step.timeout`.

### Step 3: Update tool description

**Files:** `src/pi-relay.ts`

The `buildToolDescription` function lists field names in the action step structure block. Update to match the new wire format:
- `kind: "action"` -> `type: "action"`
- `id:` -> `name:`
- References to "step IDs" -> "step names"
- References to "artifact IDs" -> "artifact names"

### Step 4: Update all source files that read domain types

**Files:** Every src file that accesses `.kind`, `.id`, or `.timeoutMs` on step/artifact domain types.

The domain-type renames are limited to three fields: `.kind` -> `.type`, `.id` -> `.name`, `.timeoutMs` -> `.timeout`. camelCase fields like `.onSuccess` are unchanged.

Affected files (from grep counts):

- `src/runtime/scheduler.ts` (12 `.kind`, `.id`, `.timeoutMs`)
- `src/runtime/run-report.ts` (10 `.kind`, `.id`)
- `src/runtime/events.ts` (`.kind` in the reducer)
- `src/runtime/artifacts.ts` (`.kind`, `.id`)
- `src/render/run-result.ts` (15 `.kind`, `.id`)
- `src/render/plan-preview.ts` (`.kind`, `.id`)
- `src/execute.ts` (`.kind`)
- `src/pi-relay.ts` (`.kind`, `.id`)
- `src/actors/task-prompt.ts` (`.kind`)
- `src/actors/completion-tool.ts` (`.kind` in ArtifactShape)

**Other discriminated unions that use `kind`:**

These are internal unions, not plan types, but should be renamed to `type` for consistency across the codebase:

- `CompileError` in `compile-errors.ts` — error discriminator
- `RelayEvent` in `events.ts` — event discriminator
- `RelayDetails` in `pi-relay.ts` — result discriminator
- `ArtifactShape` in `types.ts` — shape discriminator
- `CheckOutcome` in `checks.ts` — outcome discriminator

Each has `.kind` as its tag field. All rename to `.type`.

Delegate to subagents — each file is an independent mechanical edit.

### Step 5: Update compile error messages

**Files:** `src/plan/compile-error-format.ts`

- "Step id" -> "Step name"
- "step id" -> "step name"
- "kind 'terminal'" -> "type 'terminal'"

### Step 6: Update tool description

**Files:** `src/pi-relay.ts`

The `buildToolDescription` function's action step structure block:
- `kind: "action"` -> `type: "action"`
- `id:` -> `name:`
- "step IDs" -> "step names", "artifact IDs" -> "artifact names"

### Step 7: Update bundled plan templates

**Files:** `plans/verified-edit.md`, `plans/debate.md`, `plans/reviewed-edit.md`, `plans/multi-gate.md`, `plans/bug-fix.md`

Mechanical rename in YAML:
- `kind:` -> `type:`
- Step `id:` -> `name:` (NOT the template's own frontmatter `name`)
- `onSuccess:` -> `on_success:`
- `onFailure:` -> `on_failure:`
- `entryStep:` -> `entry_step:`
- `successCriteria:` -> `success_criteria:`
- `maxRuns:` -> `max_runs:`
- No templates currently specify `timeoutMs`, so no unit conversion needed.

### Step 8: Update all test files

**Files:** All 10 test files that construct `PlanDraftDoc` or domain type literals.

Tests construct both wire-format objects (for compile/template tests) and domain-type objects (for scheduler/artifacts tests). Both use the same field names now, so every test literal needs updating.

Delegate to subagents — each test file is independent.

### Step 9: Verify and clean up

- `npm run check && npm test`
- Grep for any remaining references to old field names across the entire repo.
- Read a bundled plan template to verify it parses with the new schema.
- Verify compile error messages use the new vocabulary.

## Dependency graph

```
Step 1 (draft.ts — wire format)
  └── Step 2 (types.ts, program.ts — domain types)
        └── Step 3 (compile.ts)
              └── Step 3b (checks.ts, scheduler.ts — timeout conversion)
                    └── Step 4 (all src files — bulk mechanical rename)
                          ├── Step 5 (compile error messages)
                          ├── Step 6 (tool description)
                          ├── Step 7 (bundled plan templates)
                          └── Step 8 (all test files)
                                └── Step 9 (verify + cleanup)
```

Steps 1-4 are the critical path — they break the build progressively and fix it. Steps 5-8 are independent of each other after step 4. The build won't pass until all source files are updated (step 4), and tests won't pass until steps 5-8 are complete.

In practice, do steps 1-3b together (small, focused files), then step 4 as a bulk pass (subagents), then steps 5-8 in parallel (subagents), then step 9 to verify.

## Risks

**1. Scope of `.kind` -> `.type` rename.** `kind` is used as the discriminator in seven discriminated unions: `Step`, `ArtifactShape`, `CompileError`, `RelayEvent`, `RelayDetails`, `CheckOutcome`, `AttemptOutcome`. All need renaming. Missing one produces confusing type errors. The TypeScript compiler will catch every missed site as a type error — the rename is mechanically safe.

**2. Template validation.** Templates validate against `PlanDraftSchema` after substitution (`substitute.ts:68`). Templates must be updated (step 7) before template tests can pass.

**3. Timeout unit conversion.** The field changes from milliseconds to seconds. The conversion to ms moves to `checks.ts` where the actual `exec` call happens. No bundled templates currently specify a timeout, so no value conversion is needed — but verify this before proceeding.

**4. Template discovery.** `src/templates/discovery.ts` may inspect raw YAML before schema validation (e.g., to extract actor references for the `/relay` command). Check if it references field names like `kind` or `actor` directly.

**5. `pi-relay.ts` plansUsingActor helper.** Line 343: `(step as Record<string, unknown>).actor === actorName`. This reads the raw plan object (wire format). The field `actor` is unchanged, so no impact — but verify no other field is accessed this way.
