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

## Next: `fields` and `list`

Add `fields` and `list` as optional flat fields on the artifact contract — not
inside a nested `shape` object:

```json
{
  "id": "diagnosis",
  "description": "Root cause analysis",
  "fields": ["root_cause", "file", "line", "fix"],
  "list": true
}
```

- `fields` absent → free-form text (no structural contract)
- `fields` present, `list` false/omitted → single object with those keys
- `fields` present, `list` true → array of objects, each with those keys

### Prompt injection of field names

When an artifact declares `fields`, the field names are surfaced to actors in
two places:

**Writing actors** — `buildCompletionInstruction` in `complete-step.ts`
appends field info to each writable artifact line. Currently:

```
Writable artifacts:
  - diagnosis: Root cause analysis
```

With fields:

```
Writable artifacts:
  - diagnosis: Root cause analysis
    Fields: root_cause, file, line, fix
    List: yes (produce an array of objects, one per item found)
```

The actor sees the exact field names it must use. This replaces the instruction
prose that currently carries the contract ("write root_cause, file, line,
fix"). The instruction can focus on *what* to investigate; the completion
protocol tells the actor *how* to structure the output.

**Reading actors** — `buildTaskPrompt` in `engine.ts` renders input artifacts
with their value. With fields, it also shows the expected structure so the
reader knows what fields to look for:

```
### diagnosis (Root cause analysis) — 2 entries
Fields: root_cause, file, line, fix

[1] by worker (step: diagnose):
  { "root_cause": "...", "file": "...", ... }
```

### Validation of committed values

When an artifact declares `fields`, `validateShape` in `artifacts.ts` checks
field presence at commit time:

- `list: false` — value must be a non-null object containing every listed
  field as a key. Extra keys are permitted.
- `list: true` — value must be an array. Every element must be a non-null
  object containing every listed field. Empty array is valid.

If a required field is missing, the commit fails, the step fails, and the
scheduler retries the actor. This catches genuine information loss (the actor
forgot to include a field) before it propagates to the reader.

### Prerequisite: artifact encoding

`fields`/`list` depends on actors reliably producing structured data. The
current completion protocol embeds artifact values as JSON inside a JSON
object inside XML-like tags:

```
<relay-complete>{"route":"done","writes":{"diagnosis": [{"root_cause": "...", "file": "..."}]}}</relay-complete>
```

This is fragile. `tryExtractJson` in `complete-step.ts` already exists to
recover from common model encoding errors (unescaped newlines, trailing text).
A `record_list` with multiple entries and free-form text in field values will
amplify this fragility.

The encoding mechanism must be improved before `fields`/`list` can be useful.
Options:

**A. Artifact writes via tool calls.** Add `write_artifact` as an actor tool.
The model provider handles JSON encoding natively — escaping, structure, and
validation are solved at the API level. The completion block shrinks to just
the route: `<relay-complete>{"route":"done"}</relay-complete>`. This is the
cleanest option.

**B. XML encoding for field values.** Actors write fields as tagged content
instead of JSON:
```xml
<artifact id="diagnosis">
<root_cause>null check missing</root_cause>
<file>src/auth.ts</file>
</artifact>
```
No escaping issues. Models produce XML-style tags more reliably than nested
JSON. But values become untyped strings.

**C. Separate artifact blocks from routing.** Keep the completion tag for
routing only. Artifact values go in separate tagged blocks outside the
completion JSON, parsed independently. A malformed artifact doesn't corrupt
the route.

The encoding decision should be made before implementing `fields`/`list`. Field
validation built on an unreliable transport wastes retries on encoding errors,
not structural errors.

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
