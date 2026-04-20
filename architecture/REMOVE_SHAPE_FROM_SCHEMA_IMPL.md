# Remove `shape` from Schema — Implementation Plan

Single-step implementation. All changes are atomic — `shape` disappears from
the model-facing schema and every consumer in one commit. Verify with
`npx tsc --noEmit && npx vitest run`.

## Step 1: Remove `shape` from schema, compiler, templates, and tests

### `draft.ts`

Delete `ArtifactShapeSchema` (lines 174-182).

Remove `shape` from `ArtifactContractSchema` (line 189). The schema becomes:

```typescript
const ArtifactContractSchema = Type.Object(
  {
    id: IdField("Unique artifact identifier within this plan."),
    description: Type.String({
      minLength: 1,
      maxLength: 1000,
      description:
        "What this artifact represents, e.g. 'parsed requirements' or 'test output JSON'.",
    }),
  },
  {
    description:
      "Compile-time declaration of an artifact's identity and description.",
  },
);
```

### `compile.ts`

In `buildArtifacts()`, line 300: replace `shape: c.shape` with the hardcoded
default:

```typescript
artifacts.set(id, {
  id,
  description: c.description,
  shape: { kind: "untyped_json" },
});
```

### Templates (7 shape lines to remove)

| File | Lines to remove |
|---|---|
| `plans/bug-fix.md` | lines 18, 21 (`shape: { kind: untyped_json }`) |
| `plans/verified-edit.md` | line 17 |
| `plans/reviewed-edit.md` | lines 21, 24, 27 |
| `plans/debate.md` | line 21 |
| `plans/multi-gate.md` | line 33 |

### Examples (2 occurrences)

| File | Change |
|---|---|
| `examples/sample-plan.json:8` | remove `"shape"` field from artifact object |
| `examples/autoresearch/autoresearch.md:31` | remove `shape:` line |

### Test fixtures (26 occurrences across 8 files)

Remove `, shape: { kind: "untyped_json" }` from every artifact declaration in
`PlanDraftDoc` objects. Delegate to a subagent — it's mechanical removal of the
same string in every occurrence.

| File | Occurrences |
|---|---|
| `test/plan/draft.test.ts` | 2 (lines 13, 18) |
| `test/plan/compile.test.ts` | 5 (lines 33, 38, 245, 265, 278) |
| `test/runtime/artifacts.test.ts` | 3 (lines 19, 20, 178) |
| `test/runtime/scheduler.test.ts` | 12 (lines 133, 376, 377, 457, 458, 542, 543, 621, 622, 692, 696, 766) |
| `test/actors/complete-step.test.ts` | 2 (lines 17, 25) |
| `test/templates/substitute.test.ts` | 1 (line 286) |
| `test/replay.integration.test.ts` | 1 (line 103) |
| `test/index.confirmation.test.ts` | 2 (lines 28, 49) |

### Docs

Regenerate `architecture/RELAY_TOOL_SCHEMA.md`:
```
npx tsx -e "import { PlanDraftSchema } from './src/plan/draft.ts'; console.log(JSON.stringify(PlanDraftSchema, null, 2));"
```

### Verify

`npx tsc --noEmit && npx vitest run`

**Commit:** `feat: remove shape from model-facing artifact schema`

## What does not change

- `types.ts` — `ArtifactShape` and `ArtifactContract` unchanged
- `artifacts.ts` — `validateShape` unchanged
- `engine.ts` — reads compiled contracts, unaffected
- `complete-step.ts` — reads compiled contracts, unaffected
- `compile-errors.ts` — no shape-related errors
- `run-report.ts` — uses `description`, not `shape`

## Risks

**TypeBox `additionalProperties`.** If `ArtifactContractSchema` has
`additionalProperties: false` (TypeBox default for `Type.Object`), then a
template or plan that still includes `shape` will fail `Value.Check`. This is
fine — we're updating all templates atomically and there's no backward
compatibility requirement.

**Volume.** 35 edits across 15 source files. The risk is a missed occurrence.
Mitigation: `npx tsc --noEmit` catches any test fixture that still references
`shape` on the `PlanDraftDoc` type, since the `Static` type will no longer
include it.
