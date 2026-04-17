# Attributed Artifacts

## Problem

When an actor receives input artifacts, it sees a raw JSON dump with no
context about who wrote it, when, or in what order. For single-writer
artifacts this is fine — there's only one source. For accumulated
artifacts written by multiple actors across loop iterations, the model
sees an anonymous array with no way to distinguish entries.

Current format the model sees:

```
## Input artifacts (current values)

- debate_log (Debate history):
```json
[
  {"position": "free will is an illusion", "argument": "..."},
  {"objection": "conflates determinism with fatalism"},
  {"response": "I accept the distinction but..."}
]
```
```

The model cannot tell which actor wrote which entry, what step produced
it, or what attempt it was. For debate, review/fix loops, or any
multi-actor workflow, this makes the artifact nearly useless as context.

## What the model should see

```
## Input artifacts

### debate_log (accumulated, 3 entries)

[1] by philosopher (step: argue):
  position: free will is an illusion
  argument: all decisions are determined by prior causes...

[2] by critic (step: counter):
  objection: conflates determinism with fatalism

[3] by philosopher (step: argue, attempt 2):
  response: I accept the distinction but maintain...
```

Each entry carries attribution (actor, step, attempt number) and is
rendered in a readable YAML-like format. The model sees a conversation
history, not a data dump.

## Store-level change

The artifact store currently holds accumulated entries as a flat array
of values: `[value1, value2, value3]`. Each commit appends the raw
value.

Change: for accumulated artifacts, each entry wraps the value with
metadata the store already has at commit time:

```ts
interface AccumulatedEntry {
  readonly index: number;
  readonly stepId: StepId;
  readonly value: unknown;
  readonly committedAt: number;
}
```

The `stepId` is already a parameter of `commit()`. The scheduler knows
which actor a step uses — it can pass that through or the presentation
layer can resolve it from the program.

The snapshot for accumulated artifacts returns the full
`AccumulatedEntry[]` instead of `unknown[]`. Non-accumulated artifacts
continue returning the raw value.

## Presentation-level change

The task prompt builder (`buildTaskPrompt` in `engine.ts`) currently
renders artifacts as:

```ts
`- ${id}${description}:\n${fenceJson(value)}`
```

For accumulated artifacts with attribution, render each entry with a
header line and YAML-formatted value:

```ts
`### ${id} (accumulated, ${entries.length} entries)\n\n${entries.map(renderEntry).join('\n\n')}`
```

Where `renderEntry` produces:

```
[1] by philosopher (step: argue):
  position: free will is an illusion
  argument: all decisions are determined by prior causes...
```

For non-accumulated artifacts, render the value as YAML instead of JSON
for consistency and token efficiency. YAML uses fewer tokens than JSON
(no braces, no quotes on simple strings) and is more natural for LLMs
to read.

## Actor resolution

The entry stores `stepId`. The actor name comes from the program's step
definition (`program.steps.get(stepId).actor`). The presentation layer
resolves this at render time — the engine already has access to the
step and actor config.

For attempt numbers: the scheduler tracks how many times each step has
run via `state.steps.get(stepId).attempts`. The entry's attempt number
is the attempt count at the time of commit. The store can capture this
if the scheduler passes it, or the presentation layer can infer it from
the entry sequence (entries from the same step are numbered
sequentially).

## Value rendering

Values are rendered as indented YAML-like key-value pairs for objects,
or inline for primitives. No dependency on a YAML library for output —
the renderer walks the value and produces indented text:

- Objects: one line per key, indented under the header
- Arrays: one line per element, prefixed with `-`
- Strings: unquoted unless they contain special characters
- Numbers, booleans, null: inline

This is simpler than full YAML serialization and covers the shapes
relay artifacts actually use. Edge cases (deeply nested objects, special
characters) fall back to JSON code fences.

## Actor self-identification

Currently the actor knows its role from the system prompt ("You are a
coding worker") but is never told its relay-level identity — actor
name and step ID. When the model sees attributed entries like
`[2] by critic (step: counter)`, it can't reliably distinguish its
own prior entries from another actor's.

The identity is injected implicitly by `buildTaskPrompt` in
`engine.ts` — no actor file or template changes. The engine already
has `actor.name` and `step.id`. It adds the identity at the top of
the task prompt, before the instruction:

```
You are: philosopher (step: argue)

Task: Review the opponent's position and counter it...

## Input artifacts
...
```

The identity goes in the task prompt, not the system prompt, because
it's step-specific. The same actor can run different steps with
different step IDs — the system prompt is the actor's persona (stable),
the task prompt is relay's per-step context (varies).

## Impact on templates

No template changes required. The artifact contract stays the same —
`accumulate: true` already triggers the accumulation behavior. The
change is in how the store records entries and how the engine renders
them. Existing templates work unchanged; they just get better context.

## What this enables

- **Debate templates**: two actors argue through an accumulated artifact,
  each seeing the full attributed history of the exchange.
- **Better review/fix loops**: the reviewer sees not just the latest
  notes but the full history of what the worker tried, with attribution.
- **Experiment logs in autoresearch**: each entry shows which iteration
  produced it, making it easier for the actor to avoid repeating
  approaches.

## Implementation scope

1. Add `AccumulatedEntry` type with `index`, `stepId`, `committedAt`.
2. Change `ArtifactStore.appendToAccumulator` to wrap values in
   `AccumulatedEntry`.
3. Update `buildTaskPrompt` to detect accumulated artifacts and render
   with attribution headers.
4. Add a simple YAML-like value renderer for artifact values.
5. Update tests for the new entry shape and rendering format.
