# Verify Step Artifact Reads

## Problem

Verify command steps are blind to relay's artifact system. They run a
shell command and route on the exit code — but they cannot access the
structured state that action steps produce. This forces optimization
loops into a dual-write pattern: the actor writes to an artifact (for
relay bookkeeping) AND to a file on disk (for the verify command to
read). The template instruction must coordinate both sides, and if the
actor forgets the file write, the grader reads stale state.

Concrete example — a prompt optimization loop inspired by Hone (GEPA-
based prompt evolution):

```
propose (action: writes candidate prompt to artifact)
  → grade (verify_command: needs to read the candidate to evaluate it)
    → back to propose
```

Today the workaround is: the propose step writes `prompt.md` to disk
AND commits the artifact. The grader reads the file. The artifact
exists only for the run report. The file is the real state, and relay
is unaware of it.

## Solution

Let verify_command steps declare `reads`. The runtime injects each
read artifact into the command's environment as a plain env var whose
name is the artifact ID.

The actor writes to the artifact. The verify command reads it from
`$candidate`. One source of truth, no dual-write.

## Constraints

Artifact IDs become env var names. Env var names must be `[A-Za-z_][A-Za-z0-9_]*`.
Enforce snake_case on all artifact IDs: `^[a-z][a-z0-9_]*$`. This is
already the de facto convention — every artifact in the codebase uses
snake_case today. The constraint makes it an error to use hyphens,
dots, or colons in artifact IDs.

Step IDs and route IDs keep the current broader pattern. Only artifact
IDs are tightened, because only artifact IDs become env var names.

## What the verify command sees

Given a plan with:

```yaml
artifacts:
  - id: candidate
    description: The prompt being evaluated.
  - id: best_score
    description: Previous best score as a decimal string.
    fields: [score, iteration]
steps:
  - kind: verify_command
    id: grade
    command: "./grader.sh"
    reads: [candidate, best_score]
    onPass: propose
    onFail: propose
```

The runtime spawns `./grader.sh` with:

```
candidate=<serialized value of the candidate artifact>
best_score=<serialized value of best_score artifact>
```

The grader script accesses them directly:

```bash
echo "$candidate" | ./run-challenges.sh
current=$(echo "$best_score" | jq -r .score)
```

## Serialization

- Text artifacts (no fields): raw string value.
- Record artifacts (fields, no list): JSON object.
- Record list artifacts (fields + list): JSON array of objects.
- Accumulated entries: JSON array of `{ index, stepId, attempt, value, committedAt }`.

The command gets a string in every case. Text artifacts are directly
usable. Structured artifacts are parseable with `jq` or any JSON tool.

## Missing artifacts

If a declared read has not been committed yet (no prior step produced
it), the env var is not set. The command can check with
`[ -z "${candidate+x}" ]` if it needs to handle this case. This
parallels how action steps receive missing artifacts — they see them
as absent in the snapshot, not as errors.

## Write enforcement across verify readers

Today the scheduler enforces artifact writes when a route leads to an
action step that reads the artifact (scheduler.ts, `handleActionCompleted`):

> If the target step reads an artifact that this step declares in its
> writes, and this step didn't actually produce it, retry or fail.

This enforcement extends to verify steps with reads. If action step A
declares `writes: [candidate]` and routes to verify step V which
declares `reads: [candidate]`, then A must actually commit `candidate`
on completion. Otherwise the verify command runs without the data it
expects — a silent bug today, an explicit retry/failure with this
change.

The check is: for each artifact in the target verify step's reads, if
the completing action step has that artifact in its writes but did not
commit it, trigger the retry-or-fail path.

## Compile-time validation

The compiler gains two new checks:

1. **Artifact ID format.** Every artifact contract ID must match
   `^[a-z][a-z0-9_]*$`. Reject plans with hyphens, dots, colons, or
   uppercase in artifact IDs.

2. **Verify step reads reference existing contracts.** Same check
   action steps already get — every ID in a verify step's reads list
   must correspond to a declared artifact contract.

No new check for "every verify-read artifact has a writer." The
existing check ("every declared artifact has at least one writer")
already covers this — the artifact must have a writer to exist in the
plan at all.

## Schema changes

Add `reads` to `VerifyCommandStepSchema`:

```yaml
- kind: verify_command
  id: grade
  command: "./grader.sh"
  reads: [candidate]        # NEW — optional
  onPass: done
  onFail: propose
```

`reads` is optional, defaults to empty. Same semantics as on action
steps: an array of artifact IDs this step may access.

`VerifyFilesExistStep` does not gain reads. It checks file paths on
disk — there is no child process to inject env vars into.

## What this does NOT cover

- **Verify steps writing artifacts.** Verify commands remain read-only
  in the artifact system. Graders that produce structured output write
  to files on disk; the next action step reads those files with its
  tools.

- **Captured output in PriorCheckResult.** The existing
  CHECK_RESULT_FORWARDING design deliberately omits command output —
  the actor reruns cheap commands itself. For expensive graders, the
  grader writes results to a file and the template instructs the actor
  to read it. This design does not change that decision.

- **Scored verification or multi-exit routing.** Verify steps remain
  binary (pass/fail). Score-based routing is a separate concern.

- **Parallel evaluation.** The grader script handles its own
  concurrency internally. Relay remains sequential.

## What this enables

- **Prompt optimization loops.** Actor proposes a prompt variant →
  grader evaluates it via env var → actor reads grader's file output
  on the next iteration. No dual-write, no filesystem coordination in
  the template instructions.

- **Parameterized verification.** A verify command that checks
  "does the output match the spec" can read the spec from an artifact
  instead of hardcoding it in the command string or requiring a file
  path.

- **Conditional benchmarks.** A verify command that benchmarks
  different configurations can read the current config from an artifact
  written by a prior action step.

## Example: prompt optimization template

```yaml
task: "Optimize {{seed_file}} for {{goal}}"
artifacts:
  - id: candidate
    description: Current candidate prompt text.
  - id: experiment_log
    description: What each iteration tried and the score.
    fields: [approach, rationale, score]
    list: true

steps:
  - kind: action
    id: propose
    actor: worker
    instruction: |
      You are optimizing a prompt for {{goal}}.

      Read {{seed_file}} (the current candidate on disk).
      Read the experiment_log artifact for what has been tried.
      Read grading_results.json for the last evaluation's feedback.

      Propose one mutation. Edit {{seed_file}} with the new variant.
      Write an experiment_log entry with your approach and rationale.
    reads: [experiment_log]
    writes: [candidate, experiment_log]
    routes: { done: grade }
    maxRuns: "{{max_iterations}}"

  - kind: verify_command
    id: grade
    command: "{{grader}}"
    reads: [candidate]
    onPass: propose
    onFail: propose

  - kind: terminal
    id: done
    outcome: success
    summary: Optimization loop completed.
```

The grader script:

```bash
#!/bin/bash
# $candidate contains the prompt text to evaluate
echo "$candidate" > /tmp/eval-prompt.md
score=$(./run-challenges.sh /tmp/eval-prompt.md)
# Write structured results for the actor to read next iteration
echo "{\"score\": $score, ...}" > grading_results.json
# Exit 0 if improved, 1 if not
./compare-to-best.sh "$score"
```

## Implementation scope

1. Tighten artifact ID validation to `^[a-z][a-z0-9_]*$` in the
   schema and compiler.
2. Add optional `reads` to `VerifyCommandStepSchema`.
3. Brand and validate verify step reads in the compiler (same as
   action step reads).
4. Extend `buildArtifacts` in `compile.ts` to index verify step
   readers.
5. In the scheduler's `executeVerifyCommand`, snapshot reads from the
   artifact store, serialize, and pass as env vars to the child
   process.
6. Extend the write enforcement in `handleActionCompleted` to check
   verify step targets, not just action step targets.
7. Tests: compiler rejects bad artifact IDs, verify step reads
   resolve, env vars are set on spawned commands, write enforcement
   triggers for verify readers.
