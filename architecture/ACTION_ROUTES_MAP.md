# Action Routes as Map

## Problem

Action step routes are an array of `{ route, to }` objects:

```json
"routes": [
  { "route": "resolved", "to": "done" },
  { "route": "unresolved", "to": "argue" }
]
```

This is three layers of structure for a simple key-value mapping.
The model writing a plan must remember the field names `route` and
`to`, wrap each pair in an object, and wrap the whole thing in an
array. Route name uniqueness is not enforced by the structure — the
compiler catches duplicates, but the schema allows them.

In YAML templates, the verbosity is worse:

```yaml
routes:
  - { route: approved, to: quality_review }
  - { route: changes_requested, to: fix }
```

## Design

Replace the array of `RouteEdge` objects with a plain map where
keys are route names and values are target step IDs.

```json
"routes": {
  "resolved": "done",
  "unresolved": "argue"
}
```

In YAML:

```yaml
routes:
  approved: quality_review
  changes_requested: fix
```

### What changes

**Wire format (schema):** `routes` goes from `Type.Array(RouteEdgeSchema)`
to `Type.Record(IdPattern, IdField)` with `minProperties: 1`.
`RouteEdgeSchema` is deleted.

**Domain type:** `ActionStep.routes` goes from `readonly RouteEdge[]`
to `ReadonlyMap<RouteId, StepId>`. The `RouteEdge` interface is
deleted.

**Completion protocol:** Unchanged. The instruction builder already
extracts route names from the step — it just reads map keys
instead of `.map(r => r.route)`.

### Benefits

- Fewer tokens for the model to write.
- No `route`/`to` field names to remember — just `name: target`.
- Route name uniqueness by construction (JSON object keys are
  unique).
- YAML templates read naturally as key-value pairs.
- `RouteEdge` type eliminated — one less concept.

### Route validation

The engine validates that the actor's emitted route is in the
declared set. With an array: `step.routes.some(r => r.route === routeId)`.
With a map: `step.routes.has(routeId)`. Simpler.

The compiler validates that every route target exists as a step.
With an array: iterate and check `edge.to`. With a map: iterate
values and check each. Same complexity.

## What this does NOT cover

- **Action step routing model.** The routes concept (multi-way
  actor-chosen branching) is unchanged. This is purely a
  representation change from array-of-objects to map.
- **Verify step routing.** `onPass`/`onFail` on verify steps is
  unaffected.
- **Backward compatibility.** Plans using the old array format
  will not parse.
