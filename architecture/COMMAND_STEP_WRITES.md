# Command Step Artifact Writes

## Problem

Command steps can read artifacts (injected as env vars) but cannot
write them. A grader that evaluates a candidate prompt produces
structured output — scores, per-challenge results, failure analysis —
that the next action step needs. Today the grader writes to a file on
disk and the template instruction tells the actor where to find it.
This is the same filesystem coupling that artifact reads eliminated
for the input direction.

The pattern shows up in every optimization loop template: the
evaluate script produces data that the mutator actor needs on the
next iteration. Without command-step writes, the data flows outside
relay's artifact system — invisible in the run report, untracked,
and requiring path coordination in template instructions.

## Solution

Command steps gain an optional `writes` field. The runtime creates a
temp directory and sets `RELAY_OUT` as an env var pointing to it. The
command writes files named after artifact IDs into that directory.
After exit, the runtime reads the files back and commits them to the
artifact store.

The interface mirrors how reads work, but in the opposite direction:

| Direction | Interface | The command sees |
|-----------|-----------|-----------------|
| Relay → Command | Env vars | `$candidate` = the value |
| Command → Relay | Files in `$RELAY_OUT` | `$RELAY_OUT/score` = write here |

## What the command does

```bash
#!/bin/bash
# Read input artifact from env var
echo "$candidate" | ./run-challenges.sh > raw_results.json

# Parse and write output artifacts to $RELAY_OUT
jq .score raw_results.json > "$RELAY_OUT/best_score"
jq .details raw_results.json > "$RELAY_OUT/evaluation"

# Exit code controls routing
score=$(jq -r .score raw_results.json)
[ "$(echo "$score > 0.8" | bc)" -eq 1 ] && exit 0 || exit 1
```

No protocol, no special formatting. Write a file, name it after the
artifact. The runtime handles the rest.

## Precedent

Three production CI/CD systems solve this same problem:

- **GitHub Actions** — `$GITHUB_OUTPUT` file with `key=value` lines.
  Fragile for multi-line values (requires heredoc delimiters). GitHub
  deprecated their earlier stdout-based protocol (`::set-output`)
  due to log injection risks.
- **Tekton** — `/tekton/results/<name>` files. One file per result.
  Multi-line values just work. Hard 4KB limit from Kubernetes
  termination messages.
- **Concourse** — output directories pre-created by the runtime. The
  task writes files into them. Arbitrary size.

Relay's design follows Tekton's pattern (one file per artifact in a
runtime-managed directory) with Concourse's approach of a single
env var pointing to the output directory.

## Schema change

Add `writes` to `CommandStepSchema`:

```yaml
- kind: command
  id: grade
  command: "./grader.sh"
  reads: [candidate]
  writes: [evaluation, best_score]
  onSuccess: propose
  onFailure: propose
```

`writes` is optional, defaults to empty. Same semantics as on action
steps: an array of artifact IDs this step may produce.

`FilesExistStep` does not gain writes. It checks paths — there is no
child process that could write files.

## Runtime behavior

1. Before spawning the command, the scheduler creates a temp
   directory and adds `RELAY_OUT=<dir>` to the process environment
   (alongside the read env vars).

2. The command runs. It may write zero or more files to `$RELAY_OUT`.

3. After exit (regardless of pass/fail), the scheduler scans the
   directory for files whose names match declared write artifact IDs.

4. For each match, read the file contents and determine the value:
   - If the artifact contract has shape `text` → raw string
   - If the artifact contract has shape `record` or `record_list`
     → parse as JSON; reject if invalid JSON or shape mismatch

5. Commit all matched artifacts to the artifact store atomically
   (same contract validation as action step commits — writer
   authorization, shape checking).

6. Remove the temp directory.

Artifacts are committed on BOTH pass and fail exit codes. The exit
code controls routing; artifact writes are orthogonal. A benchmark
that fails the threshold check still produced a score worth recording.

## Missing and extra files

- **Missing:** A declared write artifact whose file was not created
  is not committed. Not an error — the command may conditionally
  produce output. Same as action steps that don't write all declared
  artifacts.

- **Extra:** Files in `$RELAY_OUT` that don't match any declared
  write artifact ID are ignored and cleaned up with the directory.

## Write enforcement

The existing write enforcement in `handleActionCompleted` checks
whether an action step that routes to a reader actually committed
the required artifacts. The same logic does not apply to command
steps because:

- Command steps don't have routes in the action-step sense. They
  have `onSuccess`/`onFailure` which fire based on exit code.
- The decision to write is made by the script at runtime, not by
  the orchestrator.

Command step writes are best-effort. The downstream step (action
or command) that reads the artifact handles the missing case through
its existing "artifact not yet committed" path.

## Accumulated artifacts

Command step writes go through the same `ArtifactStore.commit` path
as action step writes. If multiple steps (action or command) write
to the same artifact across loop iterations, the entries accumulate
with attribution metadata. The `stepId` on each `AccumulatedEntry`
identifies whether the entry came from an action step or a command
step.

## Compiler changes

1. Accept `writes` on command steps in the draft schema.
2. Brand and validate command step writes in the compiler (same as
   action step writes — check contracts, index writers and allowed
   writers).
3. Command steps with writes are included in the `allowedWriters`
   map so the artifact store permits their commits.

## What this does NOT cover

- **Writes from `files_exist` steps.** No child process, no output
  directory. `files_exist` remains read-only.

- **Stdout capture as artifacts.** The simpler "stdout IS the
  artifact" approach for single-write steps. Could be added later as
  a convenience on top of the directory mechanism.

- **Streaming writes.** The runtime reads files after exit, not
  during execution. No partial artifact visibility mid-run.

## What this enables

- **Clean optimization loops.** The grader writes scores and
  feedback as artifacts. The mutator actor reads them from the
  artifact snapshot. No filesystem path coordination.

- **Multi-step data pipelines.** A preprocessing command step
  transforms data and writes the result as an artifact. The next
  action step reads the transformed data without knowing where
  the intermediate file lived.

- **Full artifact traceability.** Every value that flows between
  steps is tracked in relay's artifact system — visible in the
  run report, attributed, and shape-validated.

## Example: prompt optimization template

```yaml
task: "Optimize {{seed_file}} for {{goal}}"
artifacts:
  - id: candidate
    description: Current candidate prompt.
  - id: evaluation
    description: Grader feedback.
    fields: [score, per_challenge, suggestions]
  - id: experiment_log
    description: History of attempts.
    fields: [approach, rationale, score]
    list: true

steps:
  - kind: action
    id: propose
    actor: worker
    instruction: |
      Read the evaluation artifact for what the grader said.
      Read the experiment_log for what has been tried.
      Propose one mutation to {{seed_file}}.
      Write an experiment_log entry.
    reads: [evaluation, experiment_log]
    writes: [candidate, experiment_log]
    routes: { done: grade }
    maxRuns: "{{max_iterations}}"

  - kind: command
    id: grade
    command: "{{grader}}"
    reads: [candidate]
    writes: [evaluation]
    onSuccess: propose
    onFailure: propose

  - kind: terminal
    id: done
    outcome: success
    summary: Optimization complete.
```

The grader script:

```bash
#!/bin/bash
echo "$candidate" | ./run-challenges.sh > raw.json

# Write structured evaluation for the actor to read
jq '{
  score: .overall_score,
  per_challenge: .challenges,
  suggestions: .improvement_hints
}' raw.json > "$RELAY_OUT/evaluation"

# Route on threshold
score=$(jq -r .overall_score raw.json)
[ "$(echo "$score > 0.9" | bc)" -eq 1 ] && exit 0 || exit 1
```

No file path coordination in the template. No instructions telling
the actor where to find the grader's output. The artifact system
carries the data in both directions.
