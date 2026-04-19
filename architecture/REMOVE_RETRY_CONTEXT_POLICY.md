# Remove RetryPolicy and ContextPolicy

## Problem

`ActionStep` carries two configurable fields that add schema
complexity without providing value to the plan author:

### `retry: RetryPolicy`

```typescript
interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoffMs?: number;
}
```

`backoffMs` is declared but never read — the scheduler re-queues
immediately with no delay. Dead code.

`maxAttempts` is configurable per step, exposed in the tool schema,
and requires the model to reason about retry counts when writing
plans. But retry is not a plan design concern — it's infrastructure
resilience. The plan author should not need to decide whether a
step retries 1 or 3 times. The system should handle transient
failures transparently.

### `contextPolicy: ContextPolicy`

```typescript
type ContextPolicy = "fresh_per_run" | "persist_per_step" | "persist_per_actor";
```

Only `fresh_per_run` is supported. The compiler rejects the other
two values. The actor engine always spawns with `--no-session`,
creating a fresh subprocess with no conversation history. No
runtime code reads the `contextPolicy` field.

`persist_per_step` and `persist_per_actor` would require keeping a
pi subprocess alive across step activations — a fundamentally
different spawning model that does not exist and has no design.
The field is scaffolding for a feature that was never built.

## Design

Remove both fields from the action step type and schema. Retain
implicit retry as invisible infrastructure.

### Implicit retry

The scheduler retries `no_completion` and `engine_error` outcomes
up to 3 times automatically. This is hardcoded, not configurable,
and invisible to the plan author.

- **`no_completion`** — actor didn't emit the completion tag or
  emitted an invalid route. Common cause: the model forgot the
  protocol. A fresh attempt with prior attempt history often
  recovers this.
- **`engine_error`** — pi subprocess crashed, timed out, or failed
  to spawn. May be transient (resource pressure, race condition).

The retry count is a `const` in the scheduler, not a plan field.
The plan author sees a step that either succeeds or fails — not
a step that might retry 1, 2, or 5 times depending on what they
configured.

Retry behavior:
1. On `no_completion` or `engine_error`, re-queue the step
   immediately (no backoff).
2. Prior attempt history is injected so the actor sees what
   happened on the previous try.
3. After 3 failed attempts, follow the failure route or fail
   the plan.

### What is removed

| Concept | Where removed |
|---|---|
| `RetryPolicy` type | `types.ts` |
| `retry` field on `ActionStep` | `types.ts`, `draft.ts`, `compile.ts` |
| `RetryPolicySchema` | `draft.ts` |
| `ContextPolicy` type | `types.ts` |
| `contextPolicy` field on `ActionStep` | `types.ts`, `draft.ts`, `compile.ts` |
| `ContextPolicySchema` | `draft.ts` |
| `validateContextPolicies` compiler pass | `compile.ts` |
| `unsupported_context_policy` compile error | `compile-errors.ts`, `compile-error-format.ts` |
| Retry display in plan preview | `plan-preview.ts` |

### What changes

| Concept | Change |
|---|---|
| `applyRetryOrFail` in scheduler | Hardcode max attempts to 3 instead of reading `step.retry?.maxAttempts` |
| `DEFAULT_RETRY_MAX_ATTEMPTS` constant | Rename to `IMPLICIT_RETRY_ATTEMPTS`, set to 3 |

### What stays unchanged

- **`maxRuns`** on action steps. Loop cap for back-edge re-entry,
  unrelated to retry. The autoresearch template uses it.
- **`step_retry_scheduled` event.** Implicit retries still fire
  this event so the TUI and audit log show what happened.
- **`retrying` step status.** Steps still transition through
  `retrying` between implicit retry attempts.
- **`FAILURE_ROUTE_CANDIDATES`** in the scheduler. After implicit
  retries are exhausted, the scheduler probes for a "failure" or
  "error" route. If found, the plan continues. If not, the plan
  fails.
- **Prior attempt history.** Still injected on both implicit
  retries and back-edge re-entries.

### Schema simplification

Before:

```json
{
  "kind": "action",
  "id": "implement",
  "actor": "worker",
  "instruction": "...",
  "routes": { "done": "verify" },
  "retry": { "maxAttempts": 2 },
  "contextPolicy": "fresh_per_run"
}
```

After:

```json
{
  "kind": "action",
  "id": "implement",
  "actor": "worker",
  "instruction": "...",
  "routes": { "done": "verify" }
}
```

Two fewer fields in the schema. The model never sees retry
configuration or context policy options.

### Compile error changes

The `unsupported_context_policy` compile error variant is deleted.
The corresponding case in `compile-error-format.ts` is removed.

## What this does NOT cover

- **Configurable retry.** If per-step retry counts are needed
  later, a field can be reintroduced. The current change makes
  retry invisible, not impossible.
- **`maxRuns` changes.** The loop cap stays as-is.
- **Completion protocol changes.** The actor still emits
  `<relay-complete>` with a route and writes. Failure modes
  (`no_completion`, `engine_error`) still exist as `ActionOutcome`
  variants — they're just retried implicitly instead of
  configurably.
- **Backoff between retries.** Implicit retries re-queue
  immediately. If backoff is needed, it can be added to the
  scheduler internals without touching the schema.
