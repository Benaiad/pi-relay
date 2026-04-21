# Verify Step Artifact Reads — Implementation Plan

This document sequences the implementation described in
`VERIFY_READS_ARTIFACTS.md`. Each phase produces a compiling, testable
increment.

## What already exists

- **`src/plan/draft.ts`** — `IdField` validates identifiers with
  pattern `^[a-zA-Z0-9_.:-]+$`. Used by step IDs, route IDs, actor
  IDs, and artifact IDs (all share the same validator).

- **`src/plan/compile.ts`** — `buildArtifacts` walks action steps to
  index readers and writers. Only action steps have `reads`/`writes`
  today. Returns `{ artifacts, writers, allowedWriters, readers }`.

- **`src/plan/types.ts`** — `VerifyCommandStep` has `id`, `command`,
  `timeoutMs`, `onPass`, `onFail`. No `reads` field.

- **`src/runtime/scheduler.ts`** — `executeVerifyCommand` calls
  `runVerifyCommand(step, { cwd, signal }, onOutput)`. In
  `handleActionCompleted`, enforces that the completing action step
  actually wrote artifacts needed by the target step — but only checks
  action step targets (`targetStep?.kind === "action"`).

- **`src/runtime/checks.ts`** — `runVerifyCommand` calls `ops.exec`
  which already accepts an `env?: NodeJS.ProcessEnv` option.

- **`src/runtime/artifacts.ts`** — `ArtifactStore.snapshot(reads)`
  returns an `ArtifactSnapshot` with `.get(id)` returning the stored
  value (raw for text, `AccumulatedEntry[]` for accumulated).

- **`src/plan/compile-errors.ts`** — structured compile error union.

## Phase 1: Tighten artifact ID validation

Artifact IDs must be valid env var names. Enforce snake_case.

**Files changed:**

- `src/plan/draft.ts`
  - Add a separate field builder for artifact IDs:
    ```ts
    const ArtifactIdField = (description: string) =>
      Type.String({
        description,
        minLength: 1,
        maxLength: 128,
        pattern: "^[a-z][a-z0-9_]*$",
      });
    ```
  - In `ArtifactContractSchema`, change the `id` field from
    `IdField(...)` to `ArtifactIdField(...)`.
  - In `ActionStepSchema`, change the `reads` and `writes` array items
    from `IdField(...)` to `ArtifactIdField(...)`.

- `src/plan/compile-errors.ts`
  - Add a new variant:
    ```ts
    | {
        readonly kind: "invalid_artifact_id";
        readonly artifactId: ArtifactId;
        readonly reason: string;
      }
    ```

- `src/plan/compile-error-format.ts`
  - Add case for `invalid_artifact_id`:
    ```
    Artifact ID '${id}' is invalid: ${reason}. Artifact IDs must be
    snake_case (lowercase letters, digits, underscores; must start
    with a letter).
    ```

- `src/plan/compile.ts`
  - In `buildArtifacts`, validate each artifact contract's ID matches
    `^[a-z][a-z0-9_]*$` before branding. Return
    `invalid_artifact_id` on mismatch.

**Verify:** Add test in `test/plan/compile.test.ts`:
- Plan with artifact ID `my_artifact` compiles.
- Plan with artifact ID `my-artifact` fails with `invalid_artifact_id`.
- Plan with artifact ID `MyArtifact` fails.
- Plan with artifact ID `123bad` fails.

Run `npm run check && npm test`.

**Commit:** `feat: enforce snake_case on artifact IDs`

## Phase 2: Add reads to verify_command schema and types

**Files changed:**

- `src/plan/draft.ts`
  - In `VerifyCommandStepSchema`, add:
    ```ts
    reads: Type.Optional(
      Type.Array(ArtifactIdField("An artifact ID this verify step may access."), {
        description: "Artifacts injected as environment variables when the command runs. Defaults to none.",
      }),
    ),
    ```

- `src/plan/types.ts`
  - Add `reads` to `VerifyCommandStep`:
    ```ts
    export interface VerifyCommandStep {
      readonly kind: "verify_command";
      readonly id: StepId;
      readonly command: string;
      readonly reads: readonly ArtifactId[];
      readonly timeoutMs?: number;
      readonly onPass: StepId;
      readonly onFail: StepId;
    }
    ```

- `src/plan/compile.ts`
  - In `brandVerifyCommand`, populate `reads`:
    ```ts
    reads: (doc.reads ?? []).map((r) => ArtifactId(r)),
    ```
  - In `buildArtifacts`, walk verify_command steps and index their
    reads into the `readers` map, same as action steps:
    ```ts
    for (const step of steps.values()) {
      if (step.kind === "verify_command") {
        for (const readId of step.reads) {
          if (!artifacts.has(readId)) {
            return err({ kind: "missing_artifact_contract", ... });
          }
          const set = readers.get(readId) ?? new Set<StepId>();
          set.add(step.id);
          readers.set(readId, set);
        }
      }
    }
    ```

**Verify:** Add tests in `test/plan/compile.test.ts`:
- Verify step with valid reads compiles.
- Verify step reading undeclared artifact fails with
  `missing_artifact_contract`.
- Verify step with empty reads compiles (defaults to `[]`).

Run `npm run check && npm test`.

**Commit:** `feat: add optional reads to verify_command steps`

## Phase 3: Inject artifacts as env vars in check execution

**Files changed:**

- `src/runtime/checks.ts`
  - Expand `CheckContext` interface:
    ```ts
    export interface CheckContext {
      readonly cwd: string;
      readonly signal?: AbortSignal;
      readonly env?: Record<string, string>;
    }
    ```
  - In `runVerifyCommand`, pass `ctx.env` to `ops.exec`:
    ```ts
    const { exitCode } = await ops.exec(step.command, ctx.cwd, {
      onData,
      signal: ctx.signal,
      timeout: timeoutMs / 1000,
      env: ctx.env ? { ...process.env, ...ctx.env } : undefined,
    });
    ```
    When `env` is undefined, `ops.exec` uses the default (inherits
    `process.env`). When provided, the artifact env vars are merged on
    top of the inherited environment.

- `src/runtime/scheduler.ts`
  - In `executeVerifyCommand`, build the artifact env vars before
    calling `runVerifyCommand`:
    ```ts
    let artifactEnv: Record<string, string> | undefined;
    if (step.reads.length > 0) {
      const snapshot = this.artifactStore.snapshot(step.reads);
      artifactEnv = {};
      for (const id of step.reads) {
        if (!snapshot.has(id)) continue;
        artifactEnv[unwrap(id)] = serializeForEnv(snapshot.get(id));
      }
    }
    ```
    Pass `env: artifactEnv` in the `CheckContext`.

  - Add `serializeForEnv` helper (module-private):
    ```ts
    const serializeForEnv = (value: unknown): string => {
      if (typeof value === "string") return value;
      return JSON.stringify(value);
    };
    ```
    Text artifacts pass through as raw strings. Everything else
    (records, lists, accumulated entries) becomes JSON.

**Verify:** Add test in `test/runtime/checks.test.ts`:
- Spawn a verify command `printenv candidate` with a text artifact
  `candidate` set to `"hello world"`. Assert stdout contains
  `hello world`.
- Spawn with a record artifact. Assert stdout contains the JSON
  representation.
- Spawn with a missing artifact (not yet committed). Assert the env
  var is absent (command `printenv candidate` exits non-zero).

Run `npm run check && npm test`.

**Commit:** `feat: inject read artifacts as env vars in verify commands`

## Phase 4: Extend write enforcement to verify step readers

**Files changed:**

- `src/runtime/scheduler.ts`
  - In `handleActionCompleted`, after the existing check for action
    step targets, add the same check for verify_command targets:
    ```ts
    if (targetStep?.kind === "verify_command" && targetStep.reads.length > 0) {
      const missingForTarget = targetStep.reads.filter(
        (readId) => step.writes.includes(readId) && !writes.has(readId),
      );
      if (missingForTarget.length > 0) {
        const names = missingForTarget.map(unwrap).join(", ");
        this.applyRetryOrFail(
          step,
          `route '${unwrap(route)}' leads to step '${unwrap(targetId)}' which reads [${names}], but this step did not write them`,
        );
        return;
      }
    }
    ```
    Or, refactor the existing action-step check into a shared helper
    that handles both action and verify_command targets:
    ```ts
    const targetReads: readonly ArtifactId[] | undefined =
      targetStep?.kind === "action" ? targetStep.reads :
      targetStep?.kind === "verify_command" ? targetStep.reads :
      undefined;
    ```

**Verify:** Add test in `test/runtime/scheduler.test.ts`:
- Plan: action step writes `[candidate]`, routes to verify step that
  reads `[candidate]`. Scripted engine returns completion WITHOUT
  committing `candidate`. Assert the scheduler retries or fails with
  the expected message.
- Same plan but the engine commits `candidate`. Assert the verify
  step runs and receives the artifact in its env.

Run `npm run check && npm test`.

**Commit:** `feat: enforce artifact writes when route leads to a verify reader`

## Phase 5: Update bundled templates (if any use verify reads)

No bundled templates need verify reads today. This phase is a no-op
unless we add the prompt-hone example template. Skip for now.

**Commit:** (none)

## Phase 6: Documentation

- Update `README.md` artifacts section to mention verify step reads.
- Add a short example showing a verify_command with reads.

**Commit:** `docs: document verify step artifact reads`

## Dependency graph

```
Phase 1 (artifact ID validation)
  ↓
Phase 2 (schema + compiler)
  ↓
Phase 3 (runtime env injection)    Phase 4 (write enforcement)
  ↓                                  ↓
Phase 6 (docs)
```

Phases 3 and 4 are independent of each other but both depend on
phase 2. They can be implemented in either order.

## Risks

- **`ops.exec` env handling.** Confirmed: `ops.exec` passes the `env`
  option directly to `spawn()` — it fully replaces the environment,
  it does not merge. When `env` is omitted, it falls through to
  `getShellEnv()` which is `{ ...process.env }` with pi's own bindir
  prepended to PATH. That bindir addition ensures recursive `pi`
  invocations work from within bash tool calls. Verify commands don't
  invoke `pi` recursively, so losing that PATH entry is harmless.
  Phase 3 merges as `{ ...process.env, ...artifactEnv }` — the child
  inherits the full user environment plus artifact vars. Acceptable.

- **Artifact ID migration.** If any user-created plans use non-
  snake_case artifact IDs, phase 1 breaks them. Mitigation: the
  schema validation in `PlanDraftSchema` rejects at the model input
  layer with a clear error message. No silent failures. The model
  re-submits with a valid ID.
