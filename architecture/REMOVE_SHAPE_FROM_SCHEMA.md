# Remove `shape` from the Model-Facing Schema

Kill `shape: { kind: "untyped_json" }` from the artifact declaration the model
sees. Every artifact carries this nested object with one possible value — it's
ceremony that adds noise to every plan and a failure mode when the model writes
the wrong string. The runtime keeps `shape` internally; the model stops
writing it.

## The problem

Every artifact declaration requires:

```json
{ "id": "notes", "description": "Worker notes", "shape": { "kind": "untyped_json" } }
```

The `shape` field:
- Has exactly one valid value
- Adds a nested object to every artifact
- Can be misspelled (`"json"`, `"untyped"`, `"any"`) causing validation failure
- Is validated at runtime by a JSON round-trip check that can never reject
  model-produced values
- Was explicitly provisional ("v0.2 shapes land later")

## The change

Remove `shape` from `ArtifactContractSchema` in the draft schema. The compiler
hardcodes `{ kind: "untyped_json" }` when building `ArtifactContract` values.

After:

```json
{ "id": "notes", "description": "Worker notes" }
```

The internal `ArtifactContract` type keeps `shape`. The runtime's
`validateShape()` is unchanged. Only the model-facing surface loses the field.

## Future: `fields` and `list`

When there's evidence that actors produce structurally wrong artifacts and
validation would help, add `fields` and `list` as optional flat fields on
the artifact contract — not inside a nested `shape` object:

```json
{
  "id": "diagnosis",
  "description": "Root cause analysis",
  "fields": ["root_cause", "file", "line", "fix"],
  "list": true
}
```

- `fields` absent → free-form text, validated as string
- `fields` present, `list` false/omitted → single object with those keys
- `fields` present, `list` true → array of objects, each with those keys

This is deferred. The model-facing schema should get simpler before it gets
richer. Observe whether actors actually get artifact structure wrong before
building the validation machinery.

## What changes

### Schema — `draft.ts`

Delete `ArtifactShapeSchema` entirely. Remove `shape` from
`ArtifactContractSchema`.

### Domain types — `types.ts`

`ArtifactShape` and `ArtifactContract` are unchanged. The internal IR keeps
`shape` — the compiler fills it in.

### Compiler — `compile.ts`

In `buildArtifacts()` (line 297-301), replace `shape: c.shape` with
`shape: { kind: "untyped_json" }`.

### Runtime — `artifacts.ts`

Unchanged. `validateShape` still switches on `contract.shape.kind`. It still
works because every contract gets the hardcoded shape from the compiler.

### Templates — `plans/*.md`

Remove `shape: { kind: untyped_json }` from every artifact declaration in all
5 bundled templates.

### Examples

Remove `shape` from `examples/sample-plan.json` and
`examples/autoresearch/autoresearch.md`.

### Tests

Remove `shape: { kind: "untyped_json" }` from every `PlanDraftDoc` artifact in
test fixtures. 26 occurrences across 8 test files.

### Docs

Regenerate `RELAY_TOOL_SCHEMA.md`.

## What does not change

- `ArtifactShape` type — stays in the internal IR
- `ArtifactContract.shape` — stays, compiler populates it
- `validateShape()` — stays, operates on compiled contracts
- Artifact store — unchanged
- Actor engine — unchanged (reads compiled contracts, not draft)
- Run report — uses `contract.description`, not `shape`
