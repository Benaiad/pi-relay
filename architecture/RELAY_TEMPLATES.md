# Replay — Saved Plan Templates

## What this is

`replay` is a second tool registered by the relay extension. It runs
saved, parameterized relay plans stored as markdown files. The model
calls `replay` with a template name and arguments; the extension
substitutes the arguments, validates the result, compiles it, and runs
it through the existing scheduler. The model never paraphrases or
reinterprets the plan body — the plan that runs is the plan the author
committed to disk.

Two tools, one runtime:

- **`relay`** — the model builds an ad-hoc `PlanDraftDoc` from scratch.
  For novel, one-off tasks.
- **`replay`** — the model invokes a saved plan by name with arguments.
  For recurring workflows whose structure is known in advance.

Both compile through the same compiler, run on the same scheduler, and
render with the same TUI components. The difference is who authors the
plan: the model (relay) or the human (replay).

This serves the core relay thesis: deterministic workflows. Today, relay
plans are ephemeral — the model synthesizes a fresh `PlanDraftDoc` on
every invocation. That works for novel tasks. For recurring workflows
(refactor-then-verify, review-and-fix loops, multi-module migrations),
the plan structure is known in advance and should not depend on the
model's paraphrasing fidelity.

## What this is not

- Not a prompt template. Pi's prompt templates expand into prose the
  model reads and interprets. Replay templates expand into a validated
  `PlanDraftDoc` that bypasses the model entirely.
- Not a macro system. No conditionals, no loops over parameters, no
  template composition. A template is a flat plan with string holes.
- Not a slash command (yet). v0.1 exposes templates only through the
  `replay` tool. Slash command invocation is deferred.

## Directory consolidation

The relay extension currently scatters its discoverable files:
`~/.pi/agent/relay-actors/` and `<cwd>/.pi/relay-actors/`. With
templates arriving as a second class of discoverable file, this grows
into a naming mess.

Consolidate under a single `relay/` parent:

```
~/.pi/agent/relay/          # user scope
  actors/
    worker.md
    reviewer.md
  plans/
    refactor-module.md
    review-fix-loop.md

<cwd>/.pi/relay/            # project scope
  actors/
    project-worker.md
  plans/
    deploy-pipeline.md
```

This is a breaking change for existing actor installations. The
migration is mechanical: move files from `relay-actors/` to
`relay/actors/`. The extension should check the old path, emit a
one-time warning to stderr, and ignore it. No backwards-compatibility
shim that loads from both paths indefinitely.

## Template file format

Markdown with YAML frontmatter, same convention as actors and pi's
prompt templates. Frontmatter declares identity and parameters. Body is
the plan in YAML.

```yaml
---
name: refactor-module
description: Rename a symbol across a module, verified by the test suite.
parameters:
  - name: module
    description: Path to the module directory.
    required: true
  - name: old_name
    description: Current symbol name.
    required: true
  - name: new_name
    description: New symbol name.
    required: true
---

task: "Rename `{{old_name}}` to `{{new_name}}` in `{{module}}`"
entryStep: rename
artifacts:
  - id: rename_notes
    description: Notes produced during the rename.
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: rename
    actor: worker
    instruction: |
      Rename `{{old_name}}` to `{{new_name}}` throughout {{module}}.
      Do not touch files outside {{module}}.
      Write a summary of what changed to rename_notes.
    reads: []
    writes: [rename_notes]
    routes: [{ route: done, to: verify }]
  - kind: check
    id: verify
    check: { kind: command_exits_zero, command: npm, args: [test] }
    onPass: success
    onFail: failed
  - kind: terminal
    id: success
    outcome: success
    summary: Rename verified.
  - kind: terminal
    id: failed
    outcome: failure
    summary: Tests failed after rename.
```

### Frontmatter fields

| Field         | Type                     | Required | Description                                  |
|---------------|--------------------------|----------|----------------------------------------------|
| `name`        | string                   | yes      | Template identifier, unique within its scope. |
| `description` | string                   | yes      | One-line summary shown in tool descriptions. |
| `parameters`  | `TemplateParameter[]`    | no       | Declared parameters. Empty = no substitution.|

### TemplateParameter

| Field         | Type    | Required | Description                              |
|---------------|---------|----------|------------------------------------------|
| `name`        | string  | yes      | Placeholder name (alphanumeric + `_`).   |
| `description` | string  | yes      | Shown in tool description for this param.|
| `required`    | boolean | no       | Default `true`. Optional params omitted from substitution leave no residue — the `{{name}}` is replaced with empty string. |

v0.1 parameters are strings only. Typed parameters (enum, path, integer)
land when a real template needs them.

### Body: YAML plan

The body is parsed as YAML into a plain JS object, then validated
against `PlanDraftSchema` after substitution. The YAML must produce an
object whose shape matches `PlanDraftDoc` — same fields, same
constraints. YAML is chosen over JSON for multi-line `instruction`
strings and human editability.

Dependency: `yaml` npm package. Lightweight, well-maintained, no
transitive deps.

## Substitution semantics

Substitution operates on the **parsed** object, not the raw YAML string.
After YAML parsing produces a JS object, a recursive walk visits every
string value and replaces `{{paramName}}` occurrences with the
corresponding argument value.

Why post-parse, not pre-parse string replacement:
- A parameter value containing YAML special characters (`"`, `:`, `\n`)
  cannot corrupt the document structure.
- Substitution targets are always leaf string values, never keys or
  structural elements.
- Unresolved placeholders are detectable by a second walk after
  substitution — any remaining `{{...}}` pattern is an error.

### Rules

1. `{{name}}` in a string value is replaced with `args[name]`.
2. Unknown args (keys in `args` not declared in `parameters`) are
   silently ignored. This lets templates evolve without breaking callers.
3. Missing required parameters are a hard error before substitution
   starts.
4. Optional parameters not supplied: `{{name}}` is replaced with `""`.
5. After substitution, a scan for residual `{{...}}` patterns catches
   typos in template files. Any match is a compile error pointing at the
   field path (e.g., `steps[0].instruction`).

## The `replay` tool

### Schema

```ts
{
  name: string,                          // template name
  args: Record<string, string>           // parameter bindings
}
```

Small, flat, no overlap with `relay`'s schema. The model cannot confuse
the two tools — `relay` asks for a full plan (task, steps, artifacts,
entryStep), `replay` asks for a name and args.

### Tool description

Built dynamically at extension load from discovered templates. Compact
format: one line per template with parameter signatures.

```
Run a saved relay plan by name with arguments.

Available plans:
  - refactor-module(module, old_name, new_name): Rename a symbol across a module.
  - review-fix-loop(target, criteria): Review/fix loop until approved.
```

Each template adds ~15-20 tokens. The description lists name, parameter
names, and the one-line description. Full parameter descriptions are
omitted from the tool description to keep it tight — they're available
in the error response if the model gets the args wrong.

If no templates are discovered, the tool description says so:

```
Run a saved relay plan by name with arguments.

NO PLANS ARE CURRENTLY INSTALLED. Drop plan markdown files into
~/.pi/agent/relay/plans/ and run /reload to enable this tool.
```

### Label and rendering

- `label: "Replay"` — shown in the TUI tool header.
- `renderCall` — shows the template name and bound arguments:
  `▸ replay  refactor-module  module=src/foo.ts old_name=Foo new_name=Bar`
- `renderResult` — reuses relay's existing `renderRunResult`,
  `renderCompileFailure`, `renderCancelled`, `renderRefined`. Same
  `RelayDetails` type, same TUI components.

### Execute flow

1. Look up template by name. Missing → `compile_failed` with available
   template list.
2. Validate `args` against declared parameters. Missing required →
   `compile_failed` listing which params are missing and what was
   provided.
3. Deep-clone the raw plan object.
4. Recursive string-walk: replace `{{name}}` → `args[name]`.
5. Scan for residual `{{...}}`. Found → `compile_failed` pointing at
   the field path.
6. Validate substituted object against `PlanDraftSchema`. Fail →
   `compile_failed` with TypeBox error.
7. `compile()` the validated `PlanDraftDoc` against the actor registry.
8. Plan review dialog (Run / Refine / Cancel) — same as relay. The
   user sees the fully substituted, concrete plan.
9. `Scheduler.run()` — same scheduler, same runtime.
10. Return `RunReport` with `templateName` and `templateArgs` for
    audit provenance.

Steps 7–10 are identical to relay's execute path. The only new code is
steps 1–6 (template resolution and substitution) and the `replay`-
specific `renderCall`.

## Data flow

1. **Extension load** — `discoverPlanTemplates(cwd, scope)` walks
   `~/.pi/agent/relay/plans/` and `<cwd>/.pi/relay/plans/`. Each `.md`
   file is parsed: frontmatter for identity/params, body parsed as YAML
   into a raw JS object. The raw object is NOT validated against
   `PlanDraftSchema` at this point (it contains `{{...}}` placeholders
   that would fail validation). Parameter declarations ARE validated
   (name format, no duplicates). Templates referencing unknown actors
   are flagged with a warning at load time.
2. **Tool registration** — two tools registered: `relay` (unchanged)
   and `replay` (new). `relay`'s description lists actors. `replay`'s
   description lists templates.
3. **Model calls `replay`** — execute handler runs steps 1–10 above.
4. **Plan review** — the three-option dialog fires on the substituted,
   concrete plan. The user sees the plan with all parameters filled in —
   exactly what will run. Refine returns feedback to the model, which
   can re-call `replay` with different args.
5. **Run report** — `RunReport` gains optional `templateName` and
   `templateArgs` fields. The text report header includes
   `(from template: refactor-module)` when present.

## Actor-reference validation at load time

When templates are discovered, their plan body (pre-substitution) can
reference actors by name. The extension cross-references these against
the currently discovered actor set and emits a warning for each
unresolved actor. This surfaces broken templates at `/reload` time, not
at invocation time.

This is best-effort, not a hard error: the actor set can change between
load and invocation (user installs an actor after loading templates).
The compiler's existing actor validation remains the authoritative gate.

## Error scenarios

| Scenario                               | Handler                              |
|----------------------------------------|--------------------------------------|
| Template not found at invocation       | `compile_failed`, list available     |
| YAML parse error at load time          | Skip template, warn to stderr        |
| Frontmatter missing `name`             | Skip template, warn to stderr        |
| Duplicate template names               | Later file wins (project > user)     |
| Missing required parameter             | `compile_failed`, list missing+provided |
| Unknown parameter in args              | Silently ignored                     |
| Residual `{{placeholder}}` after subst | `compile_failed`, field path in msg  |
| Substituted plan fails PlanDraftSchema | `compile_failed`, TypeBox error      |
| Substituted plan fails compile()       | Existing `formatCompileError` path   |
| Template references unknown actor      | Warning at load, compile error at run|

Every error path uses the existing `compile_failed` details variant and
`renderCompileFailure` renderer. No new render code for errors.

## What stays out

- Slash command invocation.
- Typed parameters beyond string.
- Default parameter values.
- Template composition (one template invoking another).
- Template versioning (the file on disk is the version).
- Conditional sections or loops in template bodies.

---

Implementation plan: see `RELAY_TEMPLATES_IMPL.md`.
