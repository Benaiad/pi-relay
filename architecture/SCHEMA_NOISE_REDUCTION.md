# Schema Noise Reduction

Remove three sources of boilerplate and ceremony from the relay tool schema.
These changes reduce the minimum viable plan from ~12 lines to ~8 and eliminate
the most common category of "got the structure wrong" compilation failures.

**Status: implemented.** Shape removal was descoped — keeping `shape` until v0.2
typed shapes land.

## Changes

### 1. First step is the entry step — make `entryStep` optional

**The problem.** `entryStep` is a field the model must fill in, and its value is
always the `id` of the first step in the `steps` array. In every bundled
template (`verified-edit`, `bug-fix`, `reviewed-edit`, `multi-gate`, `debate`)
and every ad-hoc plan observed, `entryStep` equals `steps[0].id`. The field
adds a cross-reference the model can get wrong (typo, stale id after
reordering) with no expressiveness gained — the model already controls step
ordering.

**The change.** Make `entryStep` optional in `PlanDraftSchema`. When absent, the
compiler uses `steps[0].id`. When present, the compiler validates it exists in
the steps map (the `missing_entry` error remains reachable). The `Program` type
retains `entryStep` as required — the runtime reads it as before.

Making it optional rather than removing it preserves backward compatibility:
user-authored templates that include `entryStep` continue to work.

**What changed:**

- `PlanDraftSchema` in `draft.ts`: `entryStep` wrapped in `Type.Optional`.
- `PlanDraftDoc` type: `entryStep` becomes `entryStep?: string`.
- `PlanDraft` in `types.ts`: `entryStep` becomes optional.
- `compile()` in `compile.ts`: uses `doc.entryStep ? StepId(doc.entryStep) :
  stepOrder[0]!`. The `empty_plan` check guarantees `stepOrder` is non-empty.
- All five bundled templates: `entryStep:` line removed.

**What did not change:** `Program.entryStep` stays required. The scheduler,
`initRunState`, error types, and error formatting are unaffected.

### 2. `artifacts` defaults to empty

**The problem.** `artifacts` is `required` in the schema and the model must
write `"artifacts": []` on every plan that has no intermediate state. Most
simple plans (verified-edit, single-step fixes) have no artifacts. The field is
noise.

**The change.** Make `artifacts` optional in `PlanDraftSchema`, defaulting to
`[]` in the compiler. The model can still declare artifacts when it needs them.

**What changed:**

- `PlanDraftSchema` in `draft.ts`: `artifacts` wrapped in `Type.Optional`.
- `PlanDraftDoc` type: `artifacts` becomes `artifacts?: ...`.
- `compile()` in `compile.ts`: uses `doc.artifacts ?? []` at the
  `buildArtifacts` call site. `buildArtifacts` parameter narrowed to
  `NonNullable<PlanDraftDoc["artifacts"]>`.
- `execute.ts`: guarded `plan.artifacts` access with `?? []`.
- Bundled templates unchanged — templates that declare artifacts keep them.

### 3. Default `reads`/`writes` to empty

**The problem.** Every action step must declare `reads: []` and `writes: []`
even when it uses no artifacts. Most steps in simple plans have empty arrays for
both. Two required fields of noise per action step.

**The change.** Make `reads` and `writes` optional in `ActionStepSchema`,
defaulting to `[]` in the compiler.

**What changed:**

- `ActionStepSchema` in `draft.ts`: both wrapped in `Type.Optional`.
- `PlanDraftDoc` type: action step gets `reads?: ...`, `writes?: ...`.
- `brandAction()` in `compile.ts`: uses `(doc.reads ?? []).map(...)` and
  `(doc.writes ?? []).map(...)`.
- `plan-preview.ts`: guarded `step.reads` and `step.writes` access.
- `ActionStep` in `types.ts`: **unchanged**. The compiled type still has
  `readonly reads: readonly ArtifactId[]` — never optional, just possibly
  empty.
- Bundled templates: empty `reads: []` removed where present. Non-empty arrays
  kept.

## What the model sees after all four changes

Before (simplest valid plan — verified-edit):

```json
{
  "task": "Add rate limiting to /api/search",
  "entryStep": "implement",
  "artifacts": [],
  "steps": [
    {
      "kind": "action",
      "id": "implement",
      "actor": "worker",
      "instruction": "Add rate limiting...",
      "reads": [],
      "writes": [],
      "routes": { "done": "verify" }
    },
    {
      "kind": "verify_command",
      "id": "verify",
      "command": "npm test",
      "onPass": "done",
      "onFail": "failed"
    },
    { "kind": "terminal", "id": "done", "outcome": "success", "summary": "Done." },
    { "kind": "terminal", "id": "failed", "outcome": "failure", "summary": "Failed." }
  ]
}
```

After:

```json
{
  "task": "Add rate limiting to /api/search",
  "steps": [
    {
      "kind": "action",
      "id": "implement",
      "actor": "worker",
      "instruction": "Add rate limiting...",
      "routes": { "done": "verify" }
    },
    {
      "kind": "verify_command",
      "id": "verify",
      "command": "npm test",
      "onPass": "done",
      "onFail": "failed"
    },
    { "kind": "terminal", "id": "done", "outcome": "success", "summary": "Done." },
    { "kind": "terminal", "id": "failed", "outcome": "failure", "summary": "Failed." }
  ]
}
```

Removed: `entryStep`, `artifacts`, `reads`, `writes`. Four fewer fields, one
fewer cross-reference to get wrong.

## What this does not change

- **The `Program` IR.** `entryStep`, `reads`, `writes` all remain in the
  compiled program. The runtime is untouched.
- **The `ActionStep` domain type.** `reads` and `writes` stay as
  `readonly ArtifactId[]` — never optional, just defaulted from the wire
  format.
- **Verification steps.** No changes to `verify_command` or
  `verify_files_exist`.
- **Terminal steps.** No changes.
- **The plan preview renderer.** It reads compiled `Step` objects, not the
  draft, so it's unaffected.
- **The template instantiation pipeline.** `instantiateTemplate` validates
  against `PlanDraftSchema` — it picks up the relaxed schema automatically via
  the `Static` type. Existing templates remain valid (optional fields can still
  be present).

## Risks

All three changes make fields optional rather than removing them. This is
fully backward-compatible: existing user templates that include `entryStep`,
`artifacts: []`, `reads: []`, or `writes: []` continue to pass schema
validation. The compiler respects the explicit value when present and defaults
when absent.

The `missing_entry` compile error remains reachable — it fires when an explicit
`entryStep` names a step that does not exist.

## Out of scope

- Killing `shape` from artifacts. Deferred — keeping until v0.2 typed shapes.
- Auto-generating terminal steps. Valuable but a separate design with its own
  edge cases (custom summaries, multiple failure terminals like `multi-gate`).
- Unifying routing (`routes` vs `onPass`/`onFail`). Wrong direction — see
  earlier analysis.
- Plan builder abstractions. That's what `replay` templates already are.
- Few-shot examples in the system prompt. Orthogonal and should be done
  regardless of schema changes.
