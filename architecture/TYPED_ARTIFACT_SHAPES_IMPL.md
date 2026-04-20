# Typed Artifact Shapes — Implementation Plan

Step-by-step implementation of the design in `TYPED_ARTIFACT_SHAPES.md`. Each
step produces a compiling, test-passing increment. Verify after each step with
`npx tsc --noEmit && npx vitest run`.

## What already exists

- `ArtifactShape` type in `types.ts:13` — single variant `{ kind: "untyped_json" }`
- `ArtifactShapeSchema` in `draft.ts:174-182` — TypeBox schema, single literal
- `ArtifactContract` in `types.ts:27-31` — carries `shape: ArtifactShape`
- `validateShape` in `artifacts.ts:99-115` — switch on `contract.shape.kind`,
  one arm doing JSON round-trip
- `buildCompletionInstruction` in `complete-step.ts:55-101` — lists writable
  artifacts with description only, no shape info
- `buildTaskPrompt` in `engine.ts:215-304` — renders input artifacts with
  description and value, no shape info
- 26 test occurrences, 7 template occurrences, 2 example occurrences of
  `untyped_json`

## Step 1: Add new shape variants alongside `untyped_json`

Add `text`, `record`, and `record_list` to the type and schema while keeping
`untyped_json`. This lets existing tests and templates continue to work while
the new shapes are built out.

### `types.ts`

Replace line 13:

```typescript
export type ArtifactShape =
  | { readonly kind: "untyped_json" }
  | { readonly kind: "text" }
  | { readonly kind: "record"; readonly fields: readonly string[] }
  | { readonly kind: "record_list"; readonly fields: readonly string[] };
```

### `draft.ts`

Replace `ArtifactShapeSchema` at lines 174-182:

```typescript
const TextShapeSchema = Type.Object({
  kind: Type.Literal("text"),
});

const RecordShapeSchema = Type.Object({
  kind: Type.Literal("record"),
  fields: Type.Array(
    IdField("A field name the artifact value must contain."),
    { minItems: 1 },
  ),
});

const RecordListShapeSchema = Type.Object({
  kind: Type.Literal("record_list"),
  fields: Type.Array(
    IdField("A field name each element must contain."),
    { minItems: 1 },
  ),
});

const ArtifactShapeSchema = Type.Union(
  [
    Type.Object(
      { kind: Type.Literal("untyped_json") },
      { description: "Deprecated. Use text, record, or record_list." },
    ),
    TextShapeSchema,
    RecordShapeSchema,
    RecordListShapeSchema,
  ],
  {
    description:
      "Shape of an artifact's value. " +
      "'text' for plain strings, " +
      "'record' for an object with named fields, " +
      "'record_list' for an array of objects each with the same named fields.",
  },
);
```

### `artifacts.ts`

Add three new arms to the switch in `validateShape` (lines 99-115):

```typescript
case "untyped_json": {
  // Legacy — accepts any JSON-serializable value.
  try {
    void JSON.parse(JSON.stringify(value));
    return ok(undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(`value is not JSON-serializable: ${message}`);
  }
}

case "text": {
  if (typeof value !== "string") {
    return err(`expected a string, got ${typeof value}`);
  }
  return ok(undefined);
}

case "record": {
  return validateRecord(value, contract.shape.fields);
}

case "record_list": {
  if (!Array.isArray(value)) {
    return err(`expected an array, got ${typeof value}`);
  }
  for (let i = 0; i < value.length; i++) {
    const elementResult = validateRecord(value[i], contract.shape.fields);
    if (!elementResult.ok) {
      return err(`element [${i}]: ${elementResult.error}`);
    }
  }
  return ok(undefined);
}
```

Add helper above the switch:

```typescript
const validateRecord = (
  value: unknown,
  fields: readonly string[],
): Result<void, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(`expected an object, got ${Array.isArray(value) ? "array" : typeof value}`);
  }
  const obj = value as Record<string, unknown>;
  const missing = fields.filter((f) => !(f in obj));
  if (missing.length > 0) {
    return err(`missing fields: ${missing.join(", ")}`);
  }
  return ok(undefined);
};
```

### Verify

`npx tsc --noEmit && npx vitest run` — all existing tests pass. No tests use
the new shapes yet; no existing code produces them.

**Commit:** `feat: add text, record, and record_list artifact shape variants`

---

## Step 2: Surface shape in actor prompts

### `complete-step.ts`

In `buildCompletionInstruction`, update the writable artifact line builder
(lines 66-71) to append shape information:

```typescript
.map((id) => {
  const contract = input.artifactContracts.get(id);
  const description = contract?.description ?? "";
  const shapeLine = contract ? formatShapeHint(contract.shape) : "";
  const line = `  - ${unwrap(id)}: ${description}`.trimEnd();
  return shapeLine ? `${line}\n    ${shapeLine}` : line;
})
```

Add `formatShapeHint` in the same file:

```typescript
const formatShapeHint = (shape: ArtifactShape): string => {
  switch (shape.kind) {
    case "untyped_json":
      return "";
    case "text":
      return "Value: a string";
    case "record":
      return `Value: an object with fields [${shape.fields.join(", ")}]`;
    case "record_list":
      return `Value: an array of objects, each with fields [${shape.fields.join(", ")}]`;
  }
};
```

Import `ArtifactShape` from `types.ts`.

### `engine.ts`

In `renderArtifact` (line 306), the function currently receives
`description: string`. It does not have access to the contract's shape. Two
options:

**(a)** Change the parameter to take the full `ArtifactContract` instead of
just `description`. This ripples into `buildTaskPrompt` where `renderArtifact`
is called (line 288).

**(b)** Pass shape info separately alongside description.

Option (a) is cleaner. Change `renderArtifact` signature:

```typescript
const renderArtifact = (
  id: string,
  contract: ArtifactContract | undefined,
  value: unknown,
  stepActorResolver?: (stepId: StepId) => string | undefined,
): string => {
```

Update the call site in `buildTaskPrompt` (line 288):

```typescript
const contract = contracts.get(id);
inputs.push(renderArtifact(unwrap(id), contract, value, stepActorResolver));
```

In `renderArtifact`, add a shape hint line after the header:

```typescript
const shapeLine = contract ? formatShapeHint(contract.shape) : "";
```

And append it after the header in the output. Import `formatShapeHint` from
`complete-step.ts` (export it), or duplicate the small function locally. Export
is cleaner — one definition.

Also update the `contracts` parameter type in `buildTaskPrompt` (line 219)
from `ReadonlyMap<ArtifactIdType, { description: string }>` to
`ReadonlyMap<ArtifactIdType, ArtifactContract>` to carry the full contract.
Check the call site in `runAction` (line 77) — it already passes
`artifactContracts` which is `ReadonlyMap<ArtifactId, ArtifactContract>`, so
this narrows to the right type without changes upstream.

### Tests

Update `complete-step.test.ts` — existing tests use `untyped_json` shape on
contracts. They still pass (the format hint returns `""` for `untyped_json`).
Add one test: a contract with `record` shape produces a "Value: an object
with fields [...]" line in the completion instruction output.

### Verify

`npx tsc --noEmit && npx vitest run`

**Commit:** `feat: surface artifact shape in actor completion and task prompts`

---

## Step 3: Migrate templates to new shapes

Update every bundled template and example. For each artifact, choose the
appropriate shape based on what the instruction asks the actor to produce.

### Template mapping

**`plans/bug-fix.md`:**
- `diagnosis`: `{ kind: untyped_json }` → `{ kind: record_list, fields: [root_cause, file, line, fix] }`
- `fix_notes`: `{ kind: untyped_json }` → `{ kind: text }`

**`plans/verified-edit.md`:**
- `change_notes`: `{ kind: untyped_json }` → `{ kind: text }`

**`plans/reviewed-edit.md`:**
- `notes`: `{ kind: untyped_json }` → `{ kind: text }`
- `spec_verdict`: `{ kind: untyped_json }` → `{ kind: record, fields: [compliant, gaps] }`
- `quality_verdict`: `{ kind: untyped_json }` → `{ kind: record, fields: [approved, issues, fixes] }`

**`plans/debate.md`:**
- `debate_log`: `{ kind: untyped_json }` → `{ kind: record_list, fields: [role, claims] }`

**`plans/multi-gate.md`:**
- `change_notes`: `{ kind: untyped_json }` → `{ kind: text }`

**`examples/sample-plan.json`:**
- Update to use `text` or `record` as appropriate.

**`examples/autoresearch/autoresearch.md`:**
- Update artifacts to appropriate new shapes.

### Verify

`npx tsc --noEmit && npx vitest run` — the replay integration tests
(`test/replay.integration.test.ts`) validate templates against the schema, so
they'll confirm the new shapes parse correctly.

**Commit:** `refactor: migrate bundled templates to typed artifact shapes`

---

## Step 4: Migrate test fixtures and remove `untyped_json`

This is the bulk mechanical step. Every test file with `untyped_json` needs
updating.

### Test fixture migration

Each test artifact's shape changes based on how the test uses it:

- Artifacts committed with string values → `{ kind: "text" }`
- Artifacts committed with objects → `{ kind: "record", fields: [...] }` where
  fields match the keys the test commits
- Artifacts used structurally without specific field requirements →
  `{ kind: "text" }` (simplest valid shape)

Files and occurrence counts:

| File | Occurrences | Notes |
|---|---|---|
| `test/plan/draft.test.ts` | 2 | `validPlan` fixture |
| `test/plan/compile.test.ts` | 5 | `basicPlan` + inline plans |
| `test/runtime/artifacts.test.ts` | 3 | `planWithTwoWriters` + accumulation test |
| `test/runtime/scheduler.test.ts` | 12 | Multiple test plan fixtures |
| `test/actors/complete-step.test.ts` | 2 | Contract fixtures |
| `test/templates/substitute.test.ts` | 1 | Inline template |
| `test/replay.integration.test.ts` | 1 | Template YAML |
| `test/index.confirmation.test.ts` | 2 | Inline plans |

For `artifacts.test.ts`, the migration requires care: tests that commit
arbitrary values (numbers, objects, arrays) must now use shapes that match
what they commit. The cyclic-value test (line 135) tests `shape_mismatch` —
update it to use `text` shape and commit a non-string value, which should
also produce `shape_mismatch`.

Delegate the mechanical edits to a subagent if needed — 26 occurrences across
8 files.

### Remove `untyped_json`

After all tests use new shapes:

**`types.ts`:** Remove the `{ readonly kind: "untyped_json" }` variant from
`ArtifactShape`.

**`draft.ts`:** Remove the `untyped_json` literal from the `ArtifactShapeSchema`
union.

**`artifacts.ts`:** Remove the `case "untyped_json"` arm from `validateShape`.
The exhaustive switch guarantees a compile error if any reference remains.

### New shape validation tests

Add to `artifacts.test.ts`:

```
text shape: accepts string value
text shape: rejects number value
text shape: rejects object value
record shape: accepts object with all declared fields
record shape: rejects object missing a field
record shape: permits extra fields
record shape: rejects non-object value (string)
record shape: rejects array value
record_list shape: accepts array of conforming objects
record_list shape: rejects element missing a field (reports index)
record_list shape: rejects non-array value
record_list shape: accepts empty array
```

Add to `draft.test.ts`:

```
schema accepts text shape
schema accepts record shape with fields
schema accepts record_list shape with fields
schema rejects record shape without fields
schema rejects unknown shape kind
```

### Verify

`npx tsc --noEmit && npx vitest run`

**Commit:** `feat: remove untyped_json, migrate all fixtures to typed shapes`

---

## Step 5: Update architecture docs

**`RELAY_TOOL_SCHEMA.md`:** Regenerate the JSON schema from the live TypeBox
output (`npx tsx -e "import { PlanDraftSchema } from './src/plan/draft.ts'; console.log(JSON.stringify(PlanDraftSchema, null, 2));"`).

**`TYPED_ARTIFACT_SHAPES.md`:** Mark as implemented.

**`RELAY_SCHAME_SIMPLIFICATION_IDEAS.md`:** Note that shape has been replaced.

**Commit:** `docs: update architecture docs for typed artifact shapes`

---

## File change summary

| File | Change |
|---|---|
| `src/plan/types.ts` | `ArtifactShape` union: 3 variants replacing 1 |
| `src/plan/draft.ts` | `ArtifactShapeSchema`: union of 3 TypeBox schemas |
| `src/runtime/artifacts.ts` | `validateShape`: 3 arms + `validateRecord` helper |
| `src/actors/complete-step.ts` | `formatShapeHint` + shape line in writable artifacts |
| `src/actors/engine.ts` | `renderArtifact` takes full contract, shows shape hint |
| `plans/bug-fix.md` | 2 artifact shapes updated |
| `plans/verified-edit.md` | 1 artifact shape updated |
| `plans/reviewed-edit.md` | 3 artifact shapes updated |
| `plans/debate.md` | 1 artifact shape updated |
| `plans/multi-gate.md` | 1 artifact shape updated |
| `examples/sample-plan.json` | shape updated |
| `examples/autoresearch/autoresearch.md` | shape updated |
| `test/plan/draft.test.ts` | fixture migration + new schema tests |
| `test/plan/compile.test.ts` | fixture migration |
| `test/runtime/artifacts.test.ts` | fixture migration + 12 new validation tests |
| `test/runtime/scheduler.test.ts` | fixture migration (12 occurrences) |
| `test/actors/complete-step.test.ts` | fixture migration + shape hint test |
| `test/templates/substitute.test.ts` | fixture migration |
| `test/replay.integration.test.ts` | fixture migration |
| `test/index.confirmation.test.ts` | fixture migration |
| `architecture/RELAY_TOOL_SCHEMA.md` | regenerated |
| `architecture/TYPED_ARTIFACT_SHAPES.md` | marked implemented |

## Dependency graph

```
Step 1: types.ts + draft.ts + artifacts.ts  (new variants + validation)
  │
  ▼
Step 2: complete-step.ts + engine.ts        (actor prompt changes)
  │
  ▼
Step 3: plans/*.md + examples/              (template migration)
  │
  ▼
Step 4: test/**/*.ts + remove untyped_json  (fixture migration + cleanup)
  │
  ▼
Step 5: architecture/*.md                   (docs)
```

Steps 2 and 3 are independent of each other but both depend on step 1. They
could be done in parallel or swapped. Step 4 must be last before docs because
removing `untyped_json` requires all consumers to be migrated.

## Risks

**Test fixture migration volume.** 26 occurrences across 8 test files. Each
needs a decision about which shape to use based on what the test commits. Most
are straightforward (tests committing objects → `record`, tests committing
strings → `text`), but `scheduler.test.ts` has 12 occurrences with varying
committed value shapes. Delegate to a subagent if the mechanical volume is
distracting.

**`artifacts.test.ts` semantics change.** Tests that commit arbitrary values
(numbers, booleans) to `untyped_json` artifacts will fail with typed shapes
because no shape accepts arbitrary primitives. These tests must either: (a)
change the committed value to match the shape, or (b) use a shape that accepts
the value. Since `text` only accepts strings and `record`/`record_list` only
accept objects/arrays, committing a bare number is no longer valid. This is
intentional — the design removes the "anything goes" escape hatch.

**Replay integration test.** `test/replay.integration.test.ts:103` has
`shape: { kind: untyped_json }` in a YAML template string. This must be updated
to a valid new shape or the test will fail schema validation.

**`engine.ts` parameter type widening.** Changing `buildTaskPrompt`'s
`contracts` parameter from `{ description: string }` to `ArtifactContract`
is a narrowing of the accepted type (more fields required), but the only call
site already passes `ArtifactContract` values, so this is safe.
