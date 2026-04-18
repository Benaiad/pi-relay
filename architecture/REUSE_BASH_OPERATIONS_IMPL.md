# Reuse BashOperations: Implementation Plan

Reference: `architecture/REUSE_BASH_OPERATIONS.md`

## What already exists

- `src/runtime/checks.ts` — `runCommandExitsZero` manually spawns
  a child process (~75 lines of spawn + event wiring). Also has
  `runFileExists` (unchanged), `runCheck` dispatch (unchanged),
  `formatCommandFailure` and `truncateOutput` (adapting).
- `test/runtime/checks.test.ts` — 7 tests covering pass, non-zero
  exit, spawn error, timeout, abort, and compound commands.
- `@mariozechner/pi-coding-agent` is already a peer dependency.
  `createLocalBashOperations` and `BashOperations` are exported
  from the main barrel.

## BashOperations error contract

`createLocalBashOperations().exec()` has three outcomes:

- **Normal completion:** resolves `{ exitCode: number | null }`.
- **Timeout:** rejects with `Error("timeout:<seconds>")`.
  Kills the process tree before rejecting.
- **Abort:** rejects with `Error("aborted")`.
  Kills the process tree before rejecting.
- **Spawn failure:** rejects with the spawn error (e.g., cwd
  does not exist).

Timeout is in **seconds** (float). The current checks.ts uses
milliseconds — the call site must convert.

## Signature change: formatCommandFailure

Current signature takes separate stdout/stderr:

```
formatCommandFailure(command, code, signal, stdout, stderr) → string
```

New signature takes merged output:

```
formatCommandFailure(command, code, output) → string
```

The `signal` parameter is dropped — `BashOperations` does not
surface which signal killed the process. The format changes from
`stderr: ... | stdout: ...` to `output: ...`.

The test at line 55 asserts `outcome.reason` contains `"boom"`.
This still passes because the merged output includes stderr
content. The test does not assert the `stderr:` label.

## Steps

### Step 1: Adapt formatCommandFailure

Change `formatCommandFailure` to accept merged output instead
of separate stdout/stderr and a signal. Drop the signal parameter
since `BashOperations` absorbs signal handling internally.

Verify: `npm test -- --run test/runtime/checks.test.ts` — all
tests still pass because `formatCommandFailure` is only called
from `runCommandExitsZero`, which is being changed in the same
step.

### Step 2: Replace runCommandExitsZero with BashOperations

Replace the manual spawn wiring with a call to
`createLocalBashOperations().exec()`.

Data flow:
1. Create ops once at module level (no per-call overhead).
2. Accumulate output via `onData` into a string buffer.
3. Convert `spec.timeoutMs` to seconds for the `timeout` param.
4. On resolve: check `exitCode === 0` → pass, else fail with
   `formatCommandFailure`.
5. On reject: match `err.message` against `"aborted"` and
   `"timeout:"` prefix, map to `CheckOutcome` failures.
   Spawn errors (e.g., cwd doesn't exist) fall through to a
   generic failure.

Deleted code:
- `spawn` import from `node:child_process` (no longer used in
  this file; `runFileExists` doesn't need it).
- The manual timeout timer and SIGKILL escalation.
- The abort signal listener setup/teardown.
- The `proc.on("close")` / `proc.on("error")` handlers.
- The `settled` guard pattern (not needed — promise resolves
  once from `ops.exec`).

Verify: `npm test -- --run test/runtime/checks.test.ts`.

All 7 existing tests should pass without modification:
- Pass on exit 0 ✓ (same behavior)
- Fail on non-zero with output in reason ✓ (merged output
  still contains "boom")
- Spawn error ✓ (`BashOperations` rejects, caught as generic
  failure)
- Timeout ✓ (`BashOperations` rejects with `timeout:` prefix)
- Abort ✓ (`BashOperations` rejects with `aborted`)
- Compound commands ✓ (shell interpretation via `getShellConfig`)

### Step 3: Full verify

Run full suite: `npm test` and `npm run check` (tsc + biome).

## Risks

1. **Timeout unit mismatch.** `BashOperations` takes seconds,
   checks.ts uses milliseconds. A wrong conversion would make
   every timeout 1000x too short or too long. The existing
   timeout test (200ms → should fail) catches this: if we
   pass 200 instead of 0.2, the test hangs for 200 seconds.

2. **Shell resolution change.** The current code uses
   `shell: true` (OS default). `createLocalBashOperations`
   uses `getShellConfig()` which prefers `/bin/bash` over
   `sh`. On systems where `/bin/bash` exists (most), the
   behavior is equivalent for the commands checks run. On
   minimal containers without bash, `getShellConfig` falls
   back to `sh`, same as today.

## Files changed

| File | Change |
|---|---|
| `src/runtime/checks.ts` | Replace spawn wiring with `BashOperations`, adapt `formatCommandFailure` |
