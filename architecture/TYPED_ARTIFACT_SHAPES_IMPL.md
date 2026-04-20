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

## Step 1: Replace `untyped_json` with three typed shapes

Replace the type, schema, validation, and every consumer in one atomic step.
No backward compatibility — `untyped_json` is deleted, not deprecated.

### `types.ts`

Replace line 13:

```typescript
export type ArtifactShape =
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
  [TextShapeSchema, RecordShapeSchema, RecordListShapeSchema],
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

Replace the `validateShape` function (lines 99-115) and add a
`validateRecord` helper:

```typescript
const validateRecord = (
  value: unknown,
  fields: readonly string[],
): Result<void, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(
      `expected an object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
  }
  const obj = value as Record<string, unknown>;
  const missing = fields.filter((f) => !(f in obj));
  if (missing.length > 0) {
    return err(`missing fields: ${missing.join(", ")}`);
  }
  return ok(undefined);
};

const validateShape = (
  value: unknown,
  contract: ArtifactContract,
): Result<void, string> => {
  switch (contract.shape.kind) {
    case "text": {
      if (typeof value !== "string") {
        return err(`expected a string, got ${typeof value}`);
      }
      return ok(undefined);
    }
    case "record":
      return validateRecord(value, contract.shape.fields);
    case "record_list": {
      if (!Array.isArray(value)) {
        return err(`expected an array, got ${typeof value}`);
      }
      for (let i = 0; i < value.length; i++) {
        const elementResult = validateRecord(
          value[i],
          contract.shape.fields,
        );
        if (!elementResult.ok) {
          return err(`element [${i}]: ${elementResult.error}`);
        }
      }
      return ok(undefined);
    }
  }
};
```

### Templates — `plans/*.md` + `examples/`

All artifact shapes updated atomically:

| Template | Artifact | New shape |
|---|---|---|
| `bug-fix` | `diagnosis` | `{ kind: record_list, fields: [root_cause, file, line, fix] }` |
| `bug-fix` | `fix_notes` | `{ kind: text }` |
| `verified-edit` | `change_notes` | `{ kind: text }` |
| `reviewed-edit` | `notes` | `{ kind: text }` |
| `reviewed-edit` | `spec_verdict` | `{ kind: record, fields: [compliant, gaps] }` |
| `reviewed-edit` | `quality_verdict` | `{ kind: record, fields: [approved, issues, fixes] }` |
| `debate` | `debate_log` | `{ kind: record_list, fields: [role, claims] }` |
| `multi-gate` | `change_notes` | `{ kind: text }` |
| `examples/sample-plan.json` | update to appropriate shape |
| `examples/autoresearch/autoresearch.md` | update to appropriate shape |

### Test fixtures — all 26 occurrences

Each test artifact's shape changes based on how the test uses it. Delegate
the mechanical migration to a subagent — give it the list of files and the
mapping rules:

- Artifacts where the test commits a string → `{ kind: "text" }`
- Artifacts where the test commits an object → `{ kind: "record", fields: [<keys>] }`
  where `<keys>` are the keys the test actually commits
- Artifacts where the test commits varied types (numbers, arrays, objects) or
  is not testing artifact shape specifically → `{ kind: "text" }` and update
  the committed value to be a string
- The cyclic-value test (`artifacts.test.ts:135`) → change the artifact shape
  to `{ kind: "text" }` and keep committing the cyclic object; it still
  produces `shape_mismatch` because a cyclic object is not a string

Files and occurrence counts:

| File | Occurrences |
|---|---|
| `test/plan/draft.test.ts` | 2 |
| `test/plan/compile.test.ts` | 5 |
| `test/runtime/artifacts.test.ts` | 3 |
| `test/runtime/scheduler.test.ts` | 12 |
| `test/actors/complete-step.test.ts` | 2 |
| `test/templates/substitute.test.ts` | 1 |
| `test/replay.integration.test.ts` | 1 |
| `test/index.confirmation.test.ts` | 2 |

### New shape validation tests

Add to `artifacts.test.ts`:

```
text shape: accepts string value
text shape: rejects number value
text shape: rejects object value
record shape: accepts object with all declared fields
record shape: rejects object missing a field
record shape: permits extra fields
record shape: rejects non-object value
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

**Commit:** `feat: replace untyped_json with text, record, and record_list shapes`

---

## Step 2: Surface shape in actor prompts

### `complete-step.ts`

Add and export `formatShapeHint`:

```typescript
export const formatShapeHint = (shape: ArtifactShape): string => {
  switch (shape.kind) {
    case "text":
      return "Value: a string";
    case "record":
      return `Value: an object with fields [${shape.fields.join(", ")}]`;
    case "record_list":
      return `Value: an array of objects, each with fields [${shape.fields.join(", ")}]`;
  }
};
```

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

### `engine.ts`

Change `renderArtifact` (line 306) to take the full contract:

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

Inside `renderArtifact`, derive `description` and shape hint from `contract`:

```typescript
const description = contract?.description ?? "";
const descSuffix = description ? ` (${description})` : "";
const shapeLine = contract ? formatShapeHint(contract.shape) : "";
```

Append `shapeLine` after the header when non-empty.

Update `buildTaskPrompt`'s `contracts` parameter type (line 219) from
`ReadonlyMap<ArtifactIdType, { description: string }>` to
`ReadonlyMap<ArtifactIdType, ArtifactContract>`. The call site in `runAction`
(line 77) already passes `ArtifactContract` values — this is safe.

Import `formatShapeHint` from `complete-step.ts` and `ArtifactContract` from
`types.ts`.

### Tests

Add to `complete-step.test.ts`:

```
completion instruction includes shape hint for record artifacts
completion instruction includes shape hint for text artifacts
```

### Verify

`npx tsc --noEmit && npx vitest run`

**Commit:** `feat: surface artifact shape in actor completion and task prompts`

---

## Step 3: Update architecture docs

**`RELAY_TOOL_SCHEMA.md`:** Regenerate:
```
npx tsx -e "import { PlanDraftSchema } from './src/plan/draft.ts'; console.log(JSON.stringify(PlanDraftSchema, null, 2));"
```

**`TYPED_ARTIFACT_SHAPES.md`:** Mark as implemented.

**Commit:** `docs: update architecture docs for typed artifact shapes`

---

## File change summary

| File | Change |
|---|---|
| `src/plan/types.ts` | `ArtifactShape` union: 3 variants replacing 1 |
| `src/plan/draft.ts` | `ArtifactShapeSchema`: union of 3 TypeBox schemas |
| `src/runtime/artifacts.ts` | `validateShape`: 3 arms + `validateRecord` helper |
| `src/actors/complete-step.ts` | export `formatShapeHint` + shape line in writable artifacts |
| `src/actors/engine.ts` | `renderArtifact` takes full contract, shows shape hint |
| `plans/bug-fix.md` | 2 artifact shapes updated |
| `plans/verified-edit.md` | 1 artifact shape updated |
| `plans/reviewed-edit.md` | 3 artifact shapes updated |
| `plans/debate.md` | 1 artifact shape updated |
| `plans/multi-gate.md` | 1 artifact shape updated |
| `examples/sample-plan.json` | shape updated |
| `examples/autoresearch/autoresearch.md` | shape updated |
| `test/plan/draft.test.ts` | fixture migration + 5 new schema tests |
| `test/plan/compile.test.ts` | fixture migration |
| `test/runtime/artifacts.test.ts` | fixture migration + 12 new validation tests |
| `test/runtime/scheduler.test.ts` | fixture migration (12 occurrences) |
| `test/actors/complete-step.test.ts` | fixture migration + 2 shape hint tests |
| `test/templates/substitute.test.ts` | fixture migration |
| `test/replay.integration.test.ts` | fixture migration |
| `test/index.confirmation.test.ts` | fixture migration |
| `architecture/RELAY_TOOL_SCHEMA.md` | regenerated |
| `architecture/TYPED_ARTIFACT_SHAPES.md` | marked implemented |

## Dependency graph

```
Step 1: types + schema + validation + templates + tests + remove untyped_json
  │
  ▼
Step 2: complete-step.ts + engine.ts  (actor prompt changes)
  │
  ▼
Step 3: architecture/*.md             (docs)
```

Step 1 is the big atomic change — everything that references `untyped_json`
must update in one step because the type is deleted. Delegate the mechanical
fixture migration to a subagent.

Step 2 depends on step 1 (the `formatShapeHint` switch must cover the new
shape kinds, not `untyped_json`).

Step 3 is independent cleanup.

## Risks

**Step 1 is large.** ~35 edits across 18 files. The risk is a missed
occurrence causing a compile error. Mitigation: `npx tsc --noEmit` catches
every reference immediately. Run it after the type change, before committing,
and fix any stragglers.

**Test semantics change.** Tests that commit bare numbers or booleans to
artifacts will fail because no shape accepts arbitrary primitives. These tests
must update their committed values to match the declared shape. This is
intentional — every artifact now has a real contract.

**`engine.ts` parameter narrowing.** Changing `buildTaskPrompt`'s `contracts`
parameter from `{ description: string }` to `ArtifactContract` requires more
fields. The only call site already passes `ArtifactContract` values, so this
is safe.
