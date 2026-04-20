# Typed Artifact Shapes

Replace the single `untyped_json` artifact shape with three shapes that give
actors a clear structural contract for what to produce and readers a clear
expectation for what to consume.

## The problem

Every artifact today declares `shape: { kind: "untyped_json" }`. This tells the
actor nothing about what to produce — the instruction prose carries the entire
burden. The actor can commit `{ "yolo": true }` for a diagnosis artifact and the
runtime accepts it. The reader actor has no guarantee about what fields exist.

The instruction duplicates what the shape should express:

```yaml
instruction: |
  Write a diagnosis artifact:
  - root_cause: one sentence
  - file: the file containing the bug
  - line: approximate line number
  - fix: the minimal change that resolves it
```

These four fields ARE the artifact's contract. They belong in the shape
declaration, not buried in prose that the runtime can't validate.

## The design

Three shape kinds, discriminated on `kind`:

### `text`

A plain string. For summaries, verdicts, prose notes — artifacts where the value
is free-form text, not structured data.

```json
{ "kind": "text" }
```

**Validation:** value must be a `string`. Replaces `untyped_json` as the
simplest shape.

### `record`

A single object with named fields. Each field value is free-form (any JSON) —
the contract is about which fields exist, not what type each field holds.

```json
{ "kind": "record", "fields": ["root_cause", "file", "line", "fix"] }
```

**Validation:** value must be a non-null object containing every listed field
as a key. Extra keys are permitted (defensive — the actor may add context).

### `record_list`

An array of objects, each with the same named fields. For artifacts that
naturally hold multiple items: a list of issues, a set of findings, entries in
a debate log.

```json
{ "kind": "record_list", "fields": ["root_cause", "file", "line", "fix"] }
```

**Validation:** value must be an array. Every element must be a non-null object
containing every listed field as a key. An empty array is valid (no items found
is a valid result).

## What this looks like in templates

### Before (bug-fix diagnosis)

```yaml
artifacts:
  - id: diagnosis
    description: "Root cause analysis: what's wrong, where, and the minimal fix."
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: diagnose
    instruction: |
      Write a diagnosis artifact:
      - root_cause: one sentence
      - file: the file containing the bug
      - line: approximate line number
      - fix: the minimal change that resolves it
    writes: [diagnosis]
```

### After

```yaml
artifacts:
  - id: diagnosis
    description: "Root cause analysis: what's wrong, where, and the minimal fix."
    shape: { kind: record_list, fields: [root_cause, file, line, fix] }
steps:
  - kind: action
    id: diagnose
    instruction: |
      Investigate the bug. Identify every root cause — there may be more
      than one. For each issue found, include the root cause, the file,
      the line number, and the minimal fix.
    writes: [diagnosis]
```

The instruction no longer needs to specify the artifact's field names — the
shape declaration carries that contract and is surfaced to the actor in the
completion protocol prompt.

### Other template shapes

| Template | Artifact | Current | After |
|---|---|---|---|
| `bug-fix` | `diagnosis` | `untyped_json` | `record_list` with `[root_cause, file, line, fix]` |
| `bug-fix` | `fix_notes` | `untyped_json` | `text` |
| `verified-edit` | `change_notes` | `untyped_json` | `text` |
| `reviewed-edit` | `notes` | `untyped_json` | `text` |
| `reviewed-edit` | `spec_verdict` | `untyped_json` | `record` with `[compliant, gaps]` |
| `reviewed-edit` | `quality_verdict` | `untyped_json` | `record` with `[approved, issues, fixes]` |
| `debate` | `debate_log` | `untyped_json` | `record_list` with `[role, claims]` |

## What changes

### Schema — `draft.ts`

Replace `ArtifactShapeSchema` with a union of three schemas:

```
TextShapeSchema     = { kind: Literal("text") }
RecordShapeSchema   = { kind: Literal("record"),      fields: Array(String, minItems 1) }
RecordListSchema    = { kind: Literal("record_list"),  fields: Array(String, minItems 1) }
ArtifactShapeSchema = Union([TextShapeSchema, RecordShapeSchema, RecordListSchema])
```

Field names reuse the `IdField` pattern constraint (`^[a-zA-Z0-9_.:-]+$`) for
consistency with other identifiers.

### Domain types — `types.ts`

```typescript
type ArtifactShape =
  | { readonly kind: "text" }
  | { readonly kind: "record"; readonly fields: readonly string[] }
  | { readonly kind: "record_list"; readonly fields: readonly string[] }
```

`ArtifactContract` keeps `shape: ArtifactShape` — unchanged structurally, just
a wider union.

### Compiler — `compile.ts`

No changes. The compiler copies `shape` from the doc to the contract. The new
shape variants pass through. Field name validation (must be non-empty, must
match the pattern) is handled by the schema layer.

### Runtime validation — `artifacts.ts`

`validateShape` gains two new arms in the exhaustive switch:

```
case "text":
  value must be a string.

case "record":
  value must be a non-null object.
  every field in contract.shape.fields must be a key of value.

case "record_list":
  value must be an array.
  for each element:
    element must be a non-null object.
    every field in contract.shape.fields must be a key of element.
```

Remove the `untyped_json` arm. The exhaustive switch ensures a compile error if
any variant is unhandled.

### Actor prompt — `complete-step.ts`

`buildCompletionInstruction` currently lists writable artifacts with their
description only:

```
Writable artifacts:
  - diagnosis: Root cause analysis
```

With typed shapes, append the shape contract:

```
Writable artifacts:
  - diagnosis: Root cause analysis
    Shape: record_list with fields [root_cause, file, line, fix]
  - fix_notes: What was changed to fix the bug.
    Shape: text
```

This gives the actor a structural target in the completion protocol, not just
in the instruction prose. The shape line is derived from the contract — no
instruction duplication needed.

### Actor prompt — `engine.ts`

`buildTaskPrompt` renders input artifacts for reading actors. Currently it shows
the description and value. With typed shapes, it can also show the shape so the
reader knows what fields to expect:

```
### diagnosis (Root cause analysis) — 2 entries
Shape: record_list [root_cause, file, line, fix]

[1] by worker (step: diagnose):
  { "root_cause": "...", "file": "...", ... }
```

This is optional — the value itself is visible, so the reader can infer the
structure. But stating the shape explicitly reduces ambiguity when the value is
large or complex.

### Templates — `plans/*.md`

Update all artifact declarations. The mapping is in the table above. Remove
field enumeration from instruction prose where the shape now carries it.

### Tests

**`artifacts.test.ts`:**
- Existing `shape_mismatch` test (cyclic value) needs updating — the test plan's
  artifacts currently use `untyped_json`, which no longer exists. Change to
  `text` and commit a string value.
- Add: `text` shape rejects non-string value.
- Add: `record` shape accepts object with all fields, rejects missing field,
  permits extra fields.
- Add: `record_list` shape accepts array of conforming objects, rejects element
  missing a field, rejects non-array value, accepts empty array.

**`draft.test.ts`:**
- Add: schema accepts all three shape kinds.
- Add: schema rejects unknown shape kind.
- Add: `record` without `fields` is rejected.

**`compile.test.ts`:**
- Update test fixtures from `untyped_json` to the appropriate new shapes.

## Interaction with accumulation

The shape contract applies to the `value` inside each `AccumulatedEntry`, not
to the accumulated array itself. When an actor commits to a `record_list`
artifact, the committed value is an array of records. The accumulator wraps it:

```json
[
  { "index": 0, "stepId": "diagnose", "attempt": 1, "value": [
    { "root_cause": "...", "file": "a.ts", "line": 42, "fix": "..." },
    { "root_cause": "...", "file": "b.ts", "line": 88, "fix": "..." }
  ]},
  { "index": 1, "stepId": "diagnose", "attempt": 2, "value": [
    { "root_cause": "...", "file": "a.ts", "line": 42, "fix": "..." }
  ]}
]
```

The reader sees the accumulated entries. Each entry's `value` conforms to the
shape. This separation is clean — accumulation is a runtime concern, shape is a
contract concern.

## Backward compatibility

This is a breaking change to the shape field. `untyped_json` is removed, not
deprecated. Every artifact declaration must use one of the three new kinds.

**Bundled templates:** updated atomically with the code.

**User/project templates:** any template with `shape: { kind: untyped_json }`
will fail schema validation. Users must update to `text`, `record`, or
`record_list`. This is acceptable — the v0.1 shape was explicitly provisional
(the comments said "v0.2 shapes land later"), and user templates are expected
to be few at this stage.

**Ad-hoc relay plans:** models producing plans via the `relay` tool see the
updated schema. Old plans cached in conversation history will fail if replayed
verbatim, but this is transient.

## What this does not change

- **Artifact accumulation.** Entries still append with attribution. The
  shape validates each entry's value, not the accumulated array.
- **The completion protocol tag format.** Still
  `<relay-complete>{"route":"...","writes":{...}}</relay-complete>`.
- **Artifact store internals.** `commit()`, `snapshot()`, `all()` unchanged
  in signature. Only `validateShape` gains new arms.
- **The compiler.** It copies shape through. No new validation passes.
- **The run report.** Uses `contract.description`, not `shape`.

## Out of scope

- **Field-level types** (string, number, boolean per field). All field values
  are free-form. The contract is about field presence, not field type. This can
  be added later if validation failures show models producing wrong types.
- **Nested shapes** (a field whose value is itself a record). Flat fields cover
  the current templates. Nesting adds schema complexity for a use case that
  doesn't exist yet.
- **Optional fields.** All declared fields are required. If a field might not
  apply, the actor writes `"unknown"` or `null`. This avoids a second layer
  of optionality in the schema.
- **Making `shape` optional with a default.** Considered (default to `text`),
  but explicit is better — every artifact should state its contract. The model
  choosing between `text`, `record`, and `record_list` is a meaningful design
  decision, not boilerplate.
