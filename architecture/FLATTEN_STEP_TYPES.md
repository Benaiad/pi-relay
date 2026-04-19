# Flatten Step Types

## Problem

When a model calls the `relay` tool, it writes a plan as JSON. The
step schema contains a nested discriminated union for check steps:
the model writes `kind: "check"`, then inside that writes
`check: { kind: "command_exits_zero", ... }`. Two discriminants for
one concept. This is the single largest source of unnecessary
cognitive load in the plan schema.

The problem compounds with the routing split: action steps route
via a `routes` array, check steps route via `onPass`/`onFail`.
A model writing a check step has to remember the step kind, the
nested check spec kind, AND that this step uses the binary routing
convention instead of the routes array. That's three things to get
right for a concept that should be one thing: "verify this command
passes."

Current check step (what the model writes):

```json
{
  "kind": "check",
  "id": "run-tests",
  "check": {
    "kind": "command_exits_zero",
    "command": "npm test",
    "timeoutMs": 120000
  },
  "onPass": "done",
  "onFail": "fix"
}
```

The `check.kind` field is redundant nesting. The outer `kind` tells
you it's a check, the inner `kind` tells you what kind of check.
These should be one field.

## Design

Eliminate `CheckStep` and `CheckSpec`. Each check kind becomes its
own top-level step type with a `verify_` prefix. The `kind` field
alone tells you everything: what the step does, what fields it has,
and how routing works.

### Step kinds

| Kind | Purpose | Routing |
|---|---|---|
| `action` | LLM runs an actor | `routes` (model-chosen, multi-way) |
| `verify_command` | Shell command, pass iff exit 0 | `onPass` / `onFail` |
| `verify_files_exist` | All listed paths must exist | `onPass` / `onFail` |
| `terminal` | Ends the run | none |

`action` and `terminal` are unchanged in structure. The two check
kinds replace `check` entirely.

### Why the routing split stays

Action steps and verify steps have different routing semantics.
An action step's route is chosen by the LLM — the actor decides
which exit to take. A verify step's route is determined by the
runtime — the outcome is binary and deterministic.

Unifying them into a single `routes` array would force every verify
step to carry `[{ route: "pass", to: "..." }, { route: "fail", to: "..." }]`
— fixed names, fixed count, pure ceremony. The `onPass`/`onFail`
convention reflects that verify steps always have exactly two
outcomes with known names. This is a meaningful distinction, not
accidental complexity.

Action steps keep the `routes` array because multi-way branching
is genuinely used — e.g. the debate template's judge step routes
to `resolved → done` or `unresolved → argue`.

### `verify_command`

```json
{
  "kind": "verify_command",
  "id": "run-tests",
  "command": "npm test",
  "timeoutMs": 120000,
  "onPass": "done",
  "onFail": "fix"
}
```

Fields lifted from `CheckSpec.command_exits_zero` to the step level:

- `command` (required) — shell command to execute
- `timeoutMs` (optional, default 600000) — execution timeout in ms

`cwd` is dropped. The current `CheckSpec` exposed it, but verify
commands run in the plan's working directory — there is no use case
for overriding it per step, and it's one more field the model has
to think about.

One nesting level removed. The `kind` field is the full description.

### `verify_files_exist`

```json
{
  "kind": "verify_files_exist",
  "id": "check-output",
  "paths": ["output/result.json", "output/summary.txt"],
  "onPass": "done",
  "onFail": "retry"
}
```

Changes from the current `file_exists` check:

- `path: string` becomes `paths: string[]` (array, min 1 item).
  The common case is "verify the agent created these output files"
  — often more than one. With a single path the model creates N
  verify steps for N files, which is graph noise.
- Semantics: all paths must exist for pass. Failure reason lists
  which paths are missing.

### Internal types

```
ActionStep       — unchanged
VerifyCommandStep {
  kind: "verify_command"
  id: StepId
  command: string
  timeoutMs?: number
  onPass: StepId
  onFail: StepId
}
VerifyFilesExistStep {
  kind: "verify_files_exist"
  id: StepId
  paths: string[]
  onPass: StepId
  onFail: StepId
}
TerminalStep     — unchanged

Step = ActionStep | VerifyCommandStep | VerifyFilesExistStep | TerminalStep
```

`CheckSpec` is deleted. `CheckStep` is deleted. No union type for
check kinds exists at any layer.

### Schema (what the model sees)

Each verify kind gets its own entry in the `StepSchema` union with
its own `description`. The model sees flat, self-contained step
types. No nested `check` object.

The `verify_` prefix groups verify steps visually in the schema and
communicates intent: these are verification gates, not side-effectful
actions.

### Compiler changes

- `brandStep` gains cases for `verify_command` and `verify_files_exist`,
  loses the `check` case.
- `buildEdges` handles verify steps the same way it handled check
  steps — `onPass` maps to the `pass` route, `onFail` maps to the
  `fail` route. The internal edge representation is unchanged.
- No changes to artifact validation (verify steps don't read/write
  artifacts).

### Runtime changes

- `executeCheck` splits into `executeVerifyCommand` and
  `executeVerifyFilesExist`. Each is a focused function with no
  internal dispatch.
- `runCheck` in `checks.ts` is deleted. The two check functions
  become standalone: `runVerifyCommand` and `runFilesExist`.
  Each takes its step type directly instead of a `CheckSpec`.
- `describeCheck` becomes `describeVerifyStep`, dispatching on the
  step kind.

### Events

`check_passed` and `check_failed` rename to `verify_passed` and
`verify_failed`. The event payload is unchanged — step ID, timing,
and failure reason.

### Extensibility

Adding a new verify kind (e.g. `verify_file_contains` for
grep-style checks) means:

1. New interface (`VerifyFileContainsStep`)
2. New variant in the `Step` union
3. New TypeBox schema object
4. New execution function
5. New case in the compiler's `brandStep` and `buildEdges`

No changes to existing step types, no changes to the routing model,
no changes to action steps or terminal steps. Each verify kind is
additive.

## What this does NOT cover

- **Action step routing.** The `routes` array on action steps is
  unchanged. Multi-way branching is used (e.g. debate template's
  judge step: `resolved → done`, `unresolved → argue`).
  Simplifying this is a separate concern.
- **Artifact ceremony.** The `shape: { kind: "untyped_json" }`
  field on artifact contracts is dead weight but out of scope here.
- **New verify kinds beyond the two.** `verify_file_contains`,
  `verify_json_path`, etc. are natural follow-ups but not part of
  this change. The design makes them easy to add.
- **Backward compatibility.** Existing plans using `kind: "check"`
  will not parse. This is a clean cut per Ben's direction.
