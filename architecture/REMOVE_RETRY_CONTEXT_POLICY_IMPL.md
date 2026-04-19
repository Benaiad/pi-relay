# Remove RetryPolicy and ContextPolicy — Implementation Plan

Implements [REMOVE_RETRY_CONTEXT_POLICY.md](./REMOVE_RETRY_CONTEXT_POLICY.md).

## What already exists

`ActionStep` has `retry?: RetryPolicy` (configurable per step) and
`contextPolicy?: ContextPolicy` (validated but never read at
runtime). The scheduler reads `step.retry?.maxAttempts` to decide
how many times to re-queue a failed step. The default is 1 (no
retry).

This refactoring removes both fields from the schema and type,
and hardcodes 3 implicit retry attempts in the scheduler.

### Files that change

| File | Role | Change |
|---|---|---|
| `src/plan/types.ts` | Domain types | Delete `RetryPolicy`, `ContextPolicy`. Remove `retry`, `contextPolicy` from `ActionStep`. |
| `src/plan/draft.ts` | TypeBox schema | Delete `RetryPolicySchema`, `ContextPolicySchema`. Remove `retry`, `contextPolicy` from `ActionStepSchema`. |
| `src/plan/compile.ts` | Compiler | Remove `retry`/`contextPolicy` from `brandAction`. Delete `validateContextPolicies` pass. Remove `ContextPolicy` import. |
| `src/plan/compile-errors.ts` | Error types | Delete `unsupported_context_policy` variant. Remove `ContextPolicy` import. |
| `src/plan/compile-error-format.ts` | Error formatting | Delete `unsupported_context_policy` case. |
| `src/runtime/scheduler.ts` | Scheduler | Rename `DEFAULT_RETRY_MAX_ATTEMPTS` to `IMPLICIT_RETRY_ATTEMPTS`, set to 3. Read from constant instead of `step.retry?.maxAttempts`. |
| `src/render/plan-preview.ts` | Plan preview | Remove retry display block from `buildActionBlock`. |
| `examples/sample-plan.json` | Example | Remove `retry` field. |
| `plans/verified-edit.md` | Template | Remove `retry: { maxAttempts: 2 }`. |
| `plans/reviewed-edit.md` | Template | Remove `retry: { maxAttempts: 3 }`. |
| `plans/bug-fix.md` | Template | Remove `retry: { maxAttempts: 2 }`. |
| `plans/multi-gate.md` | Template | Remove `retry: { maxAttempts: 2 }`. |
| `test/plan/draft.test.ts` | Schema tests | Remove `retry` from fixtures. |
| `test/plan/compile.test.ts` | Compiler tests | Remove `retry` from fixtures. Delete `contextPolicy` test. |
| `test/runtime/scheduler.test.ts` | Scheduler tests | Remove `retry` from fixtures. Update retry test to verify implicit 3-attempt behavior. |

### Architecture decisions

1. **Implicit retry is hardcoded at 3 attempts.** A `const` in the
   scheduler, not a plan field. The plan author sees steps that
   succeed or fail. The system handles transient failures silently.

2. **`step_retry_scheduled` event stays.** Implicit retries still
   emit this event so the TUI shows retry attempts and the audit
   log records them. The event is internal infrastructure, not tied
   to the removed schema field.

3. **`retrying` step status stays.** Steps still transition through
   `retrying` between implicit retry attempts. The icon `↻` and
   the `(retry)` tag in the expanded view remain — they show the
   user that the system is recovering, even though the plan author
   didn't configure it.

4. **Prior attempt history stays.** The scheduler still builds
   `priorAttempts` from the audit log and injects them into the
   actor's prompt on retry. This helps the model avoid repeating
   the same mistake.

5. **`FAILURE_ROUTE_CANDIDATES` stays.** After 3 failed attempts,
   the scheduler probes for a "failure" or "error" route in the
   step's routes map. If found, the plan continues down that path.
   If not, the plan fails.

### What does NOT change

- `maxRuns` on action steps (loop cap, different concept)
- `step_retry_scheduled` event and reducer case
- `retrying` status and its icon
- `FAILURE_ROUTE_CANDIDATES` probing
- Prior attempt history injection
- `SYNTHETIC_FAILURE_REASON_PREFIX`
- Retry display in expanded TUI view (`(retry)` tag)

## Implementation steps

Each step leaves the codebase compiling and tests passing.

### Step 1: Domain types (`src/plan/types.ts`)

Delete `RetryPolicy` interface (lines 18-22). Delete
`ContextPolicy` type (lines 13-16). Remove both fields from
`ActionStep`:

```typescript
// Remove these two lines:
readonly retry?: RetryPolicy;
readonly contextPolicy?: ContextPolicy;
```

This breaks downstream references to `step.retry` and
`step.contextPolicy`.

**Verify:** Project will not compile.

### Step 2: TypeBox schema (`src/plan/draft.ts`)

Delete `RetryPolicySchema` (lines 25-44). Delete
`ContextPolicySchema` (lines 47-59). Remove both fields from
`ActionStepSchema`:

```typescript
// Remove these two lines:
retry: Type.Optional(RetryPolicySchema),
contextPolicy: Type.Optional(ContextPolicySchema),
```

**Verify:** Schema module self-consistent.

### Step 3: Compiler (`src/plan/compile.ts`)

Remove from `brandAction`:

```typescript
// Remove these two lines:
retry: doc.retry,
contextPolicy: doc.contextPolicy,
```

Delete the `validateContextPolicies` function (lines 358-375).
Remove its call from `compile()` (line 98). Remove
`ContextPolicy` from the import of `types.js`.

**Verify:** Compiler module compiles.

### Step 4: Compile errors

**`src/plan/compile-errors.ts`:**
Delete the `unsupported_context_policy` variant from `CompileError`.
Remove the `ContextPolicy` import.

**`src/plan/compile-error-format.ts`:**
Delete the `case "unsupported_context_policy"` arm.

**Verify:** Compile-error modules compile.

### Step 5: Scheduler (`src/runtime/scheduler.ts`)

Rename `DEFAULT_RETRY_MAX_ATTEMPTS` to `IMPLICIT_RETRY_ATTEMPTS`
and change value from `1` to `3`:

```typescript
const IMPLICIT_RETRY_ATTEMPTS = 3;
```

Update `applyRetryOrFail` to read from the constant:

```typescript
// Before:
const maxAttempts = step.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;

// After:
const maxAttempts = IMPLICIT_RETRY_ATTEMPTS;
```

Update the scheduler docstring to reflect implicit retry.

**Verify:** Scheduler compiles.

### Step 6: Plan preview (`src/render/plan-preview.ts`)

Remove the retry display block from `buildActionBlock`:

```typescript
// Delete this block:
if (step.retry) {
  const plural = step.retry.maxAttempts === 1 ? "attempt" : "attempts";
  lines.push(
    `     ${theme.fg("dim", `Up to ${step.retry.maxAttempts} ${plural} on failure.`)}`,
  );
}
```

**Verify:** Full source compiles (`npx tsc --noEmit`).

### Step 7: Tests — compiler (`test/plan/compile.test.ts`)

Remove `retry: { maxAttempts: 2 }` from the `basicPlan` fixture.

Delete the `contextPolicy` test ("rejects context policy other
than fresh_per_run") — the compile error no longer exists.

**Verify:** `npm test -- compile.test` passes.

### Step 8: Tests — schema (`test/plan/draft.test.ts`)

Remove `retry: { maxAttempts: 2 }` from the `validPlan` fixture.

**Verify:** `npm test -- draft.test` passes.

### Step 9: Tests — scheduler (`test/runtime/scheduler.test.ts`)

Remove `retry: { maxAttempts: N }` from all action step fixtures.

Update the retry test ("retries an action step up to maxAttempts
before failing"):
- Rename to something like "implicitly retries a failing action
  step up to 3 times".
- The step no longer has `retry: { maxAttempts: 3 }`. The
  scheduler hardcodes 3 implicit attempts.
- The scripted engine provides 2 failures then 1 success (3 total
  calls). The test asserts success and 3 engine calls.

Update the "routes to a declared 'failure' edge when retries are
exhausted" test:
- Remove `retry: { maxAttempts: 2 }`. The scheduler now always
  allows 3 attempts.
- Adjust the scripted engine to fail 3 times instead of 2.
- Assert the engine was called 3 times and the plan routed to
  the failure terminal.

Update the artifact contract violation test:
- Remove `retry: { maxAttempts: 2 }`. Implicit retry covers the
  re-attempt after rejection.

**Verify:** `npm test -- scheduler.test` passes.

### Step 10: Templates and examples

Remove `retry: { maxAttempts: N }` from:
- `plans/verified-edit.md`
- `plans/reviewed-edit.md`
- `plans/bug-fix.md`
- `plans/multi-gate.md`
- `examples/sample-plan.json`

**Verify:** `npm test` — full suite green (template discovery
tests exercise these files).

### Step 11: Final verification

```
npx prettier --write .
npx tsc --noEmit
npx vitest run
```

Commit with message:
```
refactor: remove RetryPolicy and ContextPolicy from action step schema

- Delete RetryPolicy, ContextPolicy types
- Remove retry, contextPolicy fields from ActionStep and schema
- Delete unsupported_context_policy compile error
- Hardcode 3 implicit retry attempts in scheduler
- Remove retry display from plan preview
- Update all templates, examples, tests
```
