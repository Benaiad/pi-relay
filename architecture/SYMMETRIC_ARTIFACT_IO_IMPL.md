# Symmetric Artifact I/O — Implementation Plan

This document sequences the implementation described in
`SYMMETRIC_ARTIFACT_IO.md`. Each phase produces a compiling, testable
increment.

## What already exists

- **`src/plan/draft.ts`** — `ArtifactIdField` with snake_case
  pattern `^[a-z][a-z0-9_]*$`. Used for artifact contract IDs,
  action step reads/writes, and command step reads/writes.

- **`src/plan/compile.ts`** — `ARTIFACT_ID_RE` validates artifact
  IDs at compile time. `invalid_artifact_id` compile error variant.

- **`src/plan/compile-errors.ts`** — `invalid_artifact_id` variant.

- **`src/plan/compile-error-format.ts`** — format case for
  `invalid_artifact_id`.

- **`src/runtime/scheduler.ts`** — `executeCommand` creates a
  `RELAY_OUT` temp directory for writes, calls `buildArtifactEnv`
  for reads (sets env vars), and `commitCommandWrites` to read back
  output files. `serializeForEnv` and `parseCommandOutput` handle
  serialization in both directions.

- **`src/runtime/checks.ts`** — `CheckContext.env` carries env vars
  for artifact reads. `runCommand` passes `ctx.env` to `ops.exec`.

- **Tests** — `test/plan/compile.test.ts` has 3 tests for
  `invalid_artifact_id`. `test/runtime/scheduler.test.ts` has 5
  tests for command writes using `RELAY_OUT` and 3 for env var reads.
  `test/runtime/checks.test.ts` has 3 tests for env var injection.

## Phase 1: Revert artifact ID constraint

Remove the snake_case restriction. Artifact IDs use the same
`IdField` pattern as step IDs and route IDs.

**Files changed:**

- `src/plan/draft.ts`
  - Remove the `ArtifactIdField` helper entirely.
  - Replace all usages with `IdField`:
    - Artifact contract `id`
    - Action step `reads` and `writes` items
    - Command step `reads` and `writes` items

- `src/plan/compile.ts`
  - Remove `ARTIFACT_ID_RE` constant.
  - Remove the `invalid_artifact_id` check in `buildArtifacts`.

- `src/plan/compile-errors.ts`
  - Remove the `invalid_artifact_id` variant from `CompileError`.

- `src/plan/compile-error-format.ts`
  - Remove the `invalid_artifact_id` case.

- `test/plan/compile.test.ts`
  - Remove the three `invalid_artifact_id` tests (hyphens,
    uppercase, leading digit).
  - Add a test confirming artifact IDs with hyphens now compile.

**Verify:** `npm run check && npm test`.

**Commit:** `refactor: revert artifact ID constraint to standard ID pattern`

## Phase 2: Replace env var reads with RELAY_INPUT directory

**Files changed:**

- `src/runtime/scheduler.ts`
  - Replace `buildArtifactEnv` with `writeArtifactInputDir`:
    ```ts
    private async writeArtifactInputDir(
      reads: readonly ArtifactId[],
    ): Promise<string | undefined>
    ```
    Creates a temp directory (`pi-relay-in-`), writes one file per
    read artifact using `serializeForFile` (renamed from
    `serializeForEnv`, same logic). Returns the directory path, or
    `undefined` if reads is empty.

  - Rename `serializeForEnv` → `serializeForFile`.

  - In `executeCommand`:
    - Replace `buildArtifactEnv(step.reads)` call with
      `writeArtifactInputDir(step.reads)`.
    - Build env as `{ RELAY_INPUT: inputDir, RELAY_OUTPUT: outDir }`
      (only include each key if the corresponding dir was created).
    - Pass env to `runCommand` via `CheckContext`.
    - Clean up BOTH directories in the `finally` block.

  - Rename `RELAY_OUT` → `RELAY_OUTPUT` in the outDir env key.
  - Rename `pi-relay-out-` prefix → `pi-relay-output-` for
    consistency.

- `src/runtime/checks.ts`
  - `CheckContext.env` stays as-is — it still carries env vars, but
    now only `RELAY_INPUT` and `RELAY_OUTPUT` paths instead of
    artifact values. The `{ ...process.env, ...ctx.env }` merge
    in `runCommand` works unchanged.

- `src/plan/draft.ts`
  - Update command step reads description:
    ```
    "Artifacts available as files in the $RELAY_INPUT directory. "
    "Each read artifact is a file named after the artifact ID: "
    "cat $RELAY_INPUT/artifact_id. "
    "Format: plain text (no fields), JSON object (fields), "
    "JSON array (fields + list). Defaults to none."
    ```
  - Update command step writes description:
    ```
    "Artifacts this step may write. The runtime creates $RELAY_OUTPUT "
    "directory. Write: echo value > $RELAY_OUTPUT/artifact_id. "
    "Format: plain text (no fields), JSON object (fields), "
    "JSON array (fields + list). "
    "Do NOT mkdir — it already exists. Defaults to none."
    ```

**Verify:** `npm run check && npm test`.

**Commit:** `feat: replace env var reads with RELAY_INPUT directory`

## Phase 3: Update tests

**Files changed:**

- `test/runtime/checks.test.ts`
  - Remove `CheckContext.env`-specific tests ("passes env vars from
    context to the child process", "preserves standard env vars when
    custom env is set"). These tested the env var injection mechanism
    which no longer carries artifact values — it now carries only
    directory paths.
  - Add a test confirming `RELAY_INPUT` and `RELAY_OUTPUT` are
    passed as env vars (command can read `$RELAY_INPUT` and
    `$RELAY_OUTPUT`).

- `test/runtime/scheduler.test.ts`
  - Update the "verify step artifact reads" tests:
    - Change commands from reading `process.env.candidate` to
      reading from `$RELAY_INPUT/candidate` via
      `require('fs').readFileSync`.
    - Change `RELAY_OUT` → `RELAY_OUTPUT` in write tests.
  - Update test names and descriptions to reference
    `RELAY_INPUT`/`RELAY_OUTPUT` instead of "env vars" / `RELAY_OUT`.

**Verify:** `npm run check && npm test`.

**Commit:** `test: update tests for RELAY_INPUT/RELAY_OUTPUT`

## Phase 4: Update docs

**Files changed:**

- `src/runtime/checks.ts` — update doc comment to reference
  `$RELAY_INPUT` and `$RELAY_OUTPUT` directories instead of env vars.

- `README.md` — update the Artifacts section to show the symmetric
  directory interface with `$RELAY_INPUT` and `$RELAY_OUTPUT`.

**Commit:** `docs: update README and comments for symmetric artifact I/O`

## Dependency graph

```
Phase 1 (revert artifact ID constraint)
  ↓
Phase 2 (RELAY_INPUT directory + RELAY_OUTPUT rename)
  ↓
Phase 3 (tests)    Phase 4 (docs)
```

Phase 1 can be done independently but is sequenced first because
the snake_case constraint was introduced alongside env var reads —
removing both in order keeps the history coherent.

## Risks

- **Two temp directories per step.** Steps with both reads and
  writes get two directories. Mitigated by cleanup in `finally`.
  Could share one directory with `input/` and `output/` subdirs,
  but two separate directories is simpler — each has a clear
  lifecycle and no risk of the command accidentally reading from
  the output dir or writing to the input dir.

- **Test churn.** Scheduler tests that verified env var injection
  need rewriting. The commands change from `process.env.candidate`
  to `fs.readFileSync(path.join(process.env.RELAY_INPUT, 'candidate'))`.
  More verbose but the test logic is the same.
