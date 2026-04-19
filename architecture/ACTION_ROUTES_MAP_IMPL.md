# Action Routes as Map — Implementation Plan

Implements [ACTION_ROUTES_MAP.md](./ACTION_ROUTES_MAP.md).

## What already exists

`ActionStep.routes` is `readonly RouteEdge[]` where `RouteEdge`
is `{ route: RouteId, to: StepId }`. The wire format is an array
of `{ route: string, to: string }` objects. This refactoring
changes both to a map (`Record<string, string>` on the wire,
`ReadonlyMap<RouteId, StepId>` internally).

### Files that change

| File | Role | Change |
|---|---|---|
| `src/plan/types.ts` | Domain types | Delete `RouteEdge`. Change `ActionStep.routes` to `ReadonlyMap<RouteId, StepId>`. |
| `src/plan/draft.ts` | TypeBox schema | Delete `RouteEdgeSchema`. Replace `routes` field with `Type.Record`. |
| `src/plan/compile.ts` | Compiler | Update `brandAction` to build a Map from `Object.entries`. Update `buildEdges` to iterate the map. |
| `src/actors/complete-step.ts` | Completion protocol | Change `CompletionInstructionInput.routes` from `readonly RouteId[]` to `ReadonlyMap<RouteId, StepId>` or keep as `readonly RouteId[]` (it only needs the keys). |
| `src/actors/engine.ts` | Actor engine | Update route extraction (`step.routes.keys()`) and validation (`step.routes.has()`). |
| `src/runtime/scheduler.ts` | Scheduler | Update `summarizePriorAttempt` (route display). No change to `followFailureOrTerminal` — it uses the edge map, not step.routes. |
| `src/render/plan-preview.ts` | Plan review rendering | Update `buildActionBlock` to iterate map entries. |
| `examples/sample-plan.json` | Example plan | Update routes format. |
| `plans/*.md` | Bundled templates (5 files) | Update YAML routes from array-of-objects to map. |
| `examples/autoresearch/autoresearch.md` | Example template | Update YAML routes. |
| `README.md` | Docs | Update example snippet. |
| `test/plan/draft.test.ts` | Schema tests | Update route fixtures. |
| `test/plan/compile.test.ts` | Compiler tests | Update route fixtures. |
| `test/runtime/scheduler.test.ts` | Scheduler tests | Update all action step fixtures (~20 route arrays). |
| `test/runtime/artifacts.test.ts` | Artifact tests | Update route fixtures. |
| `test/index.confirmation.test.ts` | Confirmation tests | Update route fixtures. |
| `test/replay.integration.test.ts` | Replay tests | Update YAML fixture and engine route access. |
| `test/templates/discovery.test.ts` | Template tests | Update YAML fixture. |
| `test/templates/substitute.test.ts` | Substitution tests | Update route fixtures and assertions. |
| `test/actors/complete-step.test.ts` | Completion tests | Update `CompletionInstructionInput` construction. |

### Architecture decisions

1. **Internal type is `ReadonlyMap<RouteId, StepId>`**, not a plain
   object. Maps are the idiomatic TypeScript choice for branded-key
   lookups and match the existing pattern in `Program` (edges,
   artifacts, writers all use `ReadonlyMap`).

2. **`RouteEdge` is deleted entirely.** No adapter, no compatibility
   type. The map replaces it.

3. **`CompletionInstructionInput.routes` stays `readonly RouteId[]`.**
   The completion instruction only needs route names (keys), not
   targets. The caller extracts keys from the map:
   `[...step.routes.keys()]`. This avoids threading map values into
   a module that doesn't need them.

4. **Schema uses `Type.Record` with `minProperties: 1`.** The key
   pattern matches the existing ID pattern
   (`^[a-zA-Z0-9_.:-]+$`). The value is an `IdField` (target
   step ID). `minProperties: 1` replaces the old `minItems: 1`
   on the array.

### Risks

- **TypeBox `Type.Record` + `minProperties`.** TypeBox supports
  `minProperties` as a schema option on `Type.Record`. Verified
  in TypeBox source. If TypeBox's `Value.Check` doesn't enforce
  it, the compiler's edge validation catches empty routes anyway
  (a step with no outgoing edges produces an incomplete plan).

- **Template YAML parsing.** YAML maps are the natural format for
  this change. `routes: { done: verify }` and multi-line
  `routes:\n  done: verify` both parse correctly. The YAML parser
  already handles object values in step fields.

## Implementation steps

Each step leaves the codebase compiling and tests passing.

### Step 1: Domain types (`src/plan/types.ts`)

Delete `RouteEdge` interface. Update `ActionStep`:

```typescript
// Before
readonly routes: readonly RouteEdge[];

// After
readonly routes: ReadonlyMap<RouteId, StepId>;
```

This breaks every downstream site that reads `step.routes` as an
array — the compiler flags them all.

**Verify:** Project will not compile. Downstream steps fix the
breakage.

### Step 2: TypeBox schema (`src/plan/draft.ts`)

Delete `RouteEdgeSchema`. Update the `routes` field in
`ActionStepSchema`:

```typescript
// Before
routes: Type.Array(RouteEdgeSchema, {
  minItems: 1,
  description: "Outgoing edges...",
}),

// After
routes: Type.Record(
  Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: "^[a-zA-Z0-9_.:-]+$",
  }),
  IdField("StepId the runtime transitions to when this route is emitted."),
  {
    minProperties: 1,
    description:
      "Map of route names to target step IDs. The actor must emit exactly one of these route names on completion.",
  },
),
```

**Verify:** Schema module self-consistent.

### Step 3: Compiler (`src/plan/compile.ts`)

Update `brandAction`:

```typescript
// Before
routes: doc.routes.map((edge) => ({
  route: RouteId(edge.route),
  to: StepId(edge.to),
})),

// After
routes: new Map(
  Object.entries(doc.routes).map(([route, to]) => [RouteId(route), StepId(to)]),
),
```

Update `buildEdges` action case:

```typescript
// Before
for (const edge of step.routes) {
  edges.set(edgeKey(step.id, edge.route), edge.to);
}

// After
for (const [route, target] of step.routes) {
  edges.set(edgeKey(step.id, route), target);
}
```

Target validation stays the same — check `steps.has(target)`.

**Verify:** Compiler module compiles.

### Step 4: Actor engine (`src/actors/engine.ts`)

Update route extraction for completion instruction:

```typescript
// Before
routes: step.routes.map((r) => r.route),

// After
routes: [...step.routes.keys()],
```

Update route validation:

```typescript
// Before
const routeAllowed = step.routes.some((r) => r.route === routeId);

// After
const routeAllowed = step.routes.has(routeId);
```

Update error message:

```typescript
// Before
step.routes.map((r) => unwrap(r.route)).join(", ")

// After
[...step.routes.keys()].map(unwrap).join(", ")
```

**Verify:** Engine module compiles.

### Step 5: Plan preview renderer (`src/render/plan-preview.ts`)

Update `buildActionBlock`:

```typescript
// Before
if (step.routes.length === 1) {
  lines.push(`→ ${step.routes[0]!.to}`);
} else if (step.routes.length > 1) {
  const branches = step.routes.map((r) => `${r.route} → ${r.to}`).join(", ");
}

// After
const routeEntries = Object.entries(step.routes);
if (routeEntries.length === 1) {
  lines.push(`→ ${routeEntries[0]![1]}`);
} else if (routeEntries.length > 1) {
  const branches = routeEntries.map(([r, to]) => `${r} → ${to}`).join(", ");
}
```

Note: `step` here is from `PlanDraftDoc` (wire format), so
`step.routes` is a plain object, not a Map.

**Verify:** Renderer compiles.

### Step 6: Remaining source files

- `src/runtime/scheduler.ts`: No changes needed. `summarizePriorAttempt`
  reads `attempt.route` (a `RouteId`), not `step.routes`. The
  scheduler uses the edge map for routing, not step.routes directly.
- `src/actors/complete-step.ts`: `CompletionInstructionInput.routes`
  is already `readonly RouteId[]` — no change needed, the caller
  (engine) extracts keys.

**Verify:** Full source compiles (`npx tsc --noEmit`).

### Step 7: Tests — completion protocol (`test/actors/complete-step.test.ts`)

No changes needed if `CompletionInstructionInput.routes` stays
`readonly RouteId[]`. Verify by compiling.

### Step 8: Tests — schema validation (`test/plan/draft.test.ts`)

Update `validPlan` and all action step fixtures:

```typescript
// Before
routes: [{ route: "success", to: "implement" }],

// After
routes: { success: "implement" },
```

Update the "rejects an action step without routes" test:

```typescript
// Before
routes: [],

// After
routes: {},
```

**Verify:** `npm test -- draft.test` passes.

### Step 9: Tests — compiler (`test/plan/compile.test.ts`)

Update `basicPlan` and all action step fixtures to map format.

**Verify:** `npm test -- compile.test` passes.

### Step 10: Tests — scheduler (`test/runtime/scheduler.test.ts`)

Update all ~20 action step fixtures. This is mechanical: every
`routes: [{ route: "X", to: "Y" }]` becomes `routes: { X: "Y" }`.

For multi-route steps (review loops):

```typescript
// Before
routes: [
  { route: "accepted", to: "done" },
  { route: "changes_requested", to: "fix" },
],

// After
routes: {
  accepted: "done",
  changes_requested: "fix",
},
```

**Verify:** `npm test -- scheduler.test` passes.

### Step 11: Tests — remaining test files

- `test/runtime/artifacts.test.ts`: Update ~3 route fixtures.
- `test/index.confirmation.test.ts`: Update ~2 route fixtures.
- `test/replay.integration.test.ts`: Update YAML fixture and
  engine's `request.step.routes[0]?.route` access → read from
  map keys: `[...request.step.routes.keys()][0]`.
- `test/templates/discovery.test.ts`: Update YAML fixture.
- `test/templates/substitute.test.ts`: Update route fixtures and
  the assertion `step.routes[0]!.to` → `step.routes.done` or
  `Object.values(step.routes)[0]`.

**Verify:** `npm test` — full suite green.

### Step 12: Templates and examples

Update all plan template YAML files:

- `plans/verified-edit.md`: `routes: [{ route: done, to: verify }]` → `routes: { done: verify }`.
- `plans/reviewed-edit.md`: Same pattern. Multi-route steps become multi-line maps.
- `plans/bug-fix.md`: Same pattern.
- `plans/multi-gate.md`: Same pattern.
- `plans/debate.md`: Multi-route steps become maps.
- `examples/autoresearch/autoresearch.md`: Same pattern.
- `examples/sample-plan.json`: Update JSON routes.
- `README.md`: Update example snippet.

**Verify:** `npm test` — full suite still green.

### Step 13: Final verification

```
npx prettier --write .
npx tsc --noEmit
npx vitest run
```

Commit with message:
```
refactor: change action step routes from array to map

Replace routes: [{ route: "done", to: "next" }] with
routes: { "done": "next" }. Fewer tokens, no route/to field
names, uniqueness by construction.

- Delete RouteEdge type
- ActionStep.routes becomes ReadonlyMap<RouteId, StepId>
- Schema uses Type.Record with minProperties: 1
- Update all templates, examples, tests
```
