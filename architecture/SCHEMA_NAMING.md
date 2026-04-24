# Schema Naming Cleanup

## Problem

The relay tool schema uses naming conventions from TypeScript internals rather than names a model or human would naturally write. The model reads every field name and description as part of the tool prompt. Names that feel like implementation details create friction — the model has to learn the convention rather than following intuition.

Two specific issues:

1. **Field names leak TypeScript conventions.** `kind` is a TS discriminated-union idiom. `id` implies opaque identifiers. camelCase (`onSuccess`, `entryStep`, `timeoutMs`) is a JavaScript convention, not a JSON one. Most JSON APIs the model has trained on (OpenAI, Anthropic, GitHub, Stripe) use snake_case.

2. **Descriptions reference internal branded types.** "StepId", "ArtifactId", "ActorId" mean nothing to the model. The descriptions should use the same language as the field names.

## Wire format: snake_case

The schema is JSON — the wire format the model writes. snake_case is the dominant convention in JSON APIs. The internal TypeScript types stay camelCase; the compiler translates between the two (it already does this).

## Renames

### `kind` -> `type`

`kind` is a TypeScript idiom. `type` is the universal JSON discriminator name.

```json
{ "type": "action", "name": "review", ... }
```

### `id` -> `name` (steps and artifacts)

Steps and artifacts have human-authored labels: `"review"`, `"verify"`, `"actor_report"`. These are names, not IDs.

### `onSuccess` -> `on_success`

### `onFailure` -> `on_failure`

### `entryStep` -> `entry_step`

### `successCriteria` -> `success_criteria`

### `maxRuns` -> `max_runs`

### `timeoutMs` -> `timeout`

Milliseconds is an implementation detail. The model and plan author think in seconds. Change the field to accept seconds as a number. The runtime multiplies by 1000 internally. Default: 600 (10 minutes). Max: 7200 (2 hours).

### `files_exist` type value -> stays as-is

Already snake_case. No change.

### Descriptions: remove branded type names

| Current description | Proposed |
|---|---|
| "StepId transitioned to when the command exits 0." | "Step name to transition to when the command exits 0." |
| "An ArtifactId this actor may read." | "An artifact name this step may read." |
| "ActorId of the agent that will run this step." | "Actor name — must match one of the available actors." |
| "StepId where execution begins." | "Step name where execution begins." |

### `IdField` helper -> `NameField`

Internal rename to match the semantic change. Validation rules (1-128 chars, `^[a-zA-Z0-9_.:-]+$`) stay the same.

## Summary

| Current | Proposed | Scope |
|---------|----------|-------|
| `kind` | `type` | All step schemas |
| `id` | `name` | All step schemas + ArtifactContractSchema |
| `onSuccess` | `on_success` | CommandStep, FilesExistStep |
| `onFailure` | `on_failure` | CommandStep, FilesExistStep |
| `entryStep` | `entry_step` | PlanDraftSchema |
| `successCriteria` | `success_criteria` | PlanDraftSchema |
| `maxRuns` | `max_runs` | ActionStepSchema |
| `timeoutMs` | `timeout` | CommandStepSchema (unit changes to seconds) |

## Internal types

The domain types in `types.ts` stay camelCase — standard TypeScript. The compiler maps between wire (snake_case) and domain (camelCase).

Two domain fields do rename for semantic clarity (not convention):
- `kind` -> `type` — the discriminator, consistent across all unions
- `id` -> `name` — steps and artifacts

camelCase multi-word fields stay camelCase: `onSuccess`, `onFailure`, `maxRuns`, `entryStep`, `successCriteria`. The compiler maps `doc.on_success` -> `step.onSuccess`, etc.

`timeoutMs` -> `timeout` (seconds). The conversion to milliseconds happens at the point of use in the runtime.

Internal branded types (`StepId`, `ArtifactId`, `RouteId`, `ActorId`) keep their names — they're type-system machinery, not user-facing.

## What stays the same

- Single-word fields: `task`, `instruction`, `command`, `paths`, `description`, `summary`, `outcome`, `reads`, `writes`, `routes`, `fields`, `list`, `actor`.
- The name validation pattern `^[a-zA-Z0-9_.:-]+$`.
- Internal branded types and their names.
- All runtime behavior.

## Impact

Every layer that touches wire-format field names:

1. **Schema** (`draft.ts`) — field names and descriptions.
2. **Compiler** (`compile.ts`) — reads wire format, maps to domain types.
3. **Tool description** (`pi-relay.ts`) — `buildToolDescription` references field names.
4. **Templates** (`substitute.ts`, template YAML files) — use wire-format field names.
5. **Bundled plan templates** — YAML files under `plans/`.
6. **Tests** — every test that constructs a `PlanDraftDoc` or step literal.

Layers that use internal domain types (scheduler, events, report, artifacts) are mostly unaffected — the compiler absorbs the translation.

## What this does NOT cover

- Renaming internal branded types.
- Changing the name validation pattern.
- Any behavioral changes beyond the timeout unit (ms -> seconds).
