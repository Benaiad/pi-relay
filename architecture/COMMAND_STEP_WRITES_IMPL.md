# Command Step Artifact Writes — Implementation Plan

This document sequences the implementation described in
`COMMAND_STEP_WRITES.md`. Each phase produces a compiling, testable
increment.

## What already exists

- **`src/plan/draft.ts`** — `CommandStepSchema` has `reads` but no
  `writes`. Uses `ArtifactIdField` for artifact ID validation.

- **`src/plan/types.ts`** — `CommandStep` has `reads: readonly
  ArtifactId[]` but no `writes`.

- **`src/plan/compile.ts`** — `buildArtifacts` indexes action step
  writers and readers, and command step readers. Command steps are
  not indexed as writers.

- **`src/runtime/scheduler.ts`** — `executeCommand` calls
  `buildArtifactEnv(step.reads)` for read injection, runs the
  command, emits `check_passed`/`check_failed`, and follows the
  route. No artifact commit after command execution.

- **`src/runtime/checks.ts`** — `CheckContext` has `env?` for read
  injection. `runCommand` passes `ctx.env` to `ops.exec`.

- **`src/runtime/artifacts.ts`** — `ArtifactStore.commit(stepId,
  writes, attempt)` validates writer authorization against
  `program.allowedWriters` and shape against contracts.

- **`src/render/plan-preview.ts`** — `buildCommandBlock` shows
  `Uses:` for reads. No `Produces:` line.

## Phase 1: Add writes to command step schema and types

**Files changed:**

- `src/plan/draft.ts`
  - Add `writes` to `CommandStepSchema`:
    ```ts
    writes: Type.Optional(
      Type.Array(ArtifactIdField("An artifact ID this command step may produce."), {
        description:
          "Artifacts this step may write. The command writes files to the $RELAY_OUT directory, " +
          "named after the artifact ID. The runtime reads them back after exit. Defaults to none.",
      }),
    ),
    ```
  - Update the step description to mention writes.

- `src/plan/types.ts`
  - Add `writes` to `CommandStep`:
    ```ts
    readonly writes: readonly ArtifactId[];
    ```

- `src/plan/compile.ts`
  - In `brandCommand`, populate `writes`:
    ```ts
    writes: (doc.writes ?? []).map((w) => ArtifactId(w)),
    ```
  - In `buildArtifacts`, index command step writers alongside
    action step writers. The existing action step writer loop
    handles `writes` — extract the writer indexing into a shared
    helper or duplicate the block for `step.kind === "command"`:
    ```ts
    if (step.kind === "action" || step.kind === "command") {
      for (const writeId of step.writes) { ... }
    }
    ```
    Same for read indexing — command steps already have reads
    handled separately; merge the read loops:
    ```ts
    if (step.kind === "action" || step.kind === "command") {
      for (const readId of step.reads) { ... }
    }
    ```
    This collapses the two separate blocks (action reads/writes +
    command reads) into one that handles both kinds.

**Verify:** Add tests in `test/plan/compile.test.ts`:
- Command step with valid writes compiles.
- Command step writing an undeclared artifact fails with
  `missing_artifact_contract`.
- Command step writer is included in the program's `allowedWriters`.

Run `npm run check && npm test`.

**Commit:** `feat: add optional writes to command steps`

## Phase 2: Create RELAY_OUT directory and read back files

**Files changed:**

- `src/runtime/scheduler.ts`
  - In `executeCommand`, after building `env` from reads:
    1. If `step.writes.length > 0`, create a temp directory via
       `fs.promises.mkdtemp`.
    2. Add `RELAY_OUT=<dir>` to the env (merge with read env vars).
    3. Run the command (existing code).
    4. After exit, scan the directory for files matching declared
       write artifact IDs.
    5. For each match, read the file and determine the value:
       - Look up the artifact contract's shape.
       - Text → raw string (`fs.readFileSync` as utf-8).
       - Record/record_list → `JSON.parse` the file contents.
         If parsing fails, skip (don't commit malformed values).
    6. Commit all matched artifacts via `this.artifactStore.commit`.
    7. Emit `artifact_committed` events for each committed artifact.
    8. Remove the temp directory in a `finally` block.

  - Extract the file-reading and commit logic into a private method:
    ```ts
    private async commitCommandWrites(
      step: CommandStep,
      outDir: string,
    ): Promise<void>
    ```

  - The commit happens on BOTH pass and fail outcomes. The commit
    call is placed after the outcome is determined but before the
    check_passed/check_failed emit, so artifacts are available
    before routing continues.

  - Import `mkdtemp`, `readdir`, `readFile`, `rm` from
    `node:fs/promises` and `os.tmpdir` from `node:os`.

**Verify:** Add tests in `test/runtime/scheduler.test.ts`:
- Command step writes a text artifact: action writes candidate,
  command reads candidate and writes score (a grader script that
  echoes a value to `$RELAY_OUT/score`), next action reads score.
  Assert the plan succeeds and the score artifact is committed.
- Command step writes a JSON artifact with record shape: grader
  writes JSON to `$RELAY_OUT/result`. Assert shape validation
  passes and the artifact is committed with parsed value.
- Command step writes on failure: grader exits non-zero but still
  writes to `$RELAY_OUT/evaluation`. Assert the artifact is
  committed despite the fail route.
- Command step writes nothing: command declares writes but doesn't
  create files in `$RELAY_OUT`. Assert no artifact committed, no
  error.
- Command step writes invalid JSON for a record artifact: grader
  writes malformed text to `$RELAY_OUT/result` where `result` has
  `fields`. Assert the artifact is not committed (shape mismatch
  skipped).

Run `npm run check && npm test`.

**Commit:** `feat: command steps write artifacts via RELAY_OUT directory`

## Phase 3: Plan preview shows command step writes

**Files changed:**

- `src/render/plan-preview.ts`
  - In `buildCommandBlock`, after the `Uses:` line for reads,
    add a `Produces:` line for writes:
    ```ts
    if (step.writes && step.writes.length > 0) {
      lines.push(`     ${theme.fg("dim", `Produces: ${step.writes.join(", ")}`)}`);
    }
    ```
    Same label action steps already use.

**Verify:** Visual inspection — no automated test for render output.

Run `npm run check && npm test`.

**Commit:** `feat: show command step writes in plan preview`

## Phase 4: Update docs

**Files changed:**

- `src/runtime/checks.ts` — update doc comment: "Command steps may
  read artifacts (injected as env vars) and write artifacts (via
  $RELAY_OUT directory)."

- `README.md` — update the Artifacts section to mention command step
  writes. Update the command step kind description.

**Commit:** `docs: document command step artifact writes`

## Dependency graph

```
Phase 1 (schema + compiler)
  ↓
Phase 2 (runtime: RELAY_OUT + commit)
  ↓
Phase 3 (plan preview)    Phase 4 (docs)
```

Phases 3 and 4 are independent of each other but both depend on
phase 2.

## Risks

- **Temp directory cleanup on crash.** If the scheduler crashes
  mid-run, the temp directory leaks. Mitigation: directories are
  created under `os.tmpdir()` with a `pi-relay-out-` prefix. The
  OS cleans tmpdir on reboot. The `finally` block in
  `executeCommand` handles normal exit and abort.

- **JSON parse errors.** A command writes malformed JSON to
  `$RELAY_OUT/result` where the contract declares `fields`. The
  runtime should skip the artifact (not commit it) rather than
  failing the entire run. Log a warning. The downstream step sees
  the artifact as absent.

- **Race with the command.** The command could still be writing to
  `$RELAY_OUT` when the runtime reads it. Not possible — `ops.exec`
  resolves after the child process exits. The runtime reads files
  only after the process has terminated.

- **Large files.** A command writes a 100MB file to `$RELAY_OUT`.
  The runtime reads the entire file into memory as a string. This
  is the same risk as large artifact values from action steps — the
  artifact store holds everything in memory. No new risk introduced.
