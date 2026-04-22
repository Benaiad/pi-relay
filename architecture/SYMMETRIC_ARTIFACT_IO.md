# Symmetric Artifact I/O for Command Steps

## Problem

Command step artifact I/O uses two different mechanisms:

- **Reads:** env vars. `$candidate` contains the value.
- **Writes:** files. `$RELAY_OUT/score` is a path to write to.

The model has to learn both, remember which direction uses which
interface, and handle their different quirks (env var size limits,
naming collisions with system vars, newline escaping). The confused
plan from the Pi assistant — adding defensive `mkdir -p $RELAY_OUT`
while simultaneously using `$greeting` as an env var — shows the
cognitive load of two mechanisms in one command.

The snake_case constraint on artifact IDs was introduced to ensure
valid env var names. With env vars removed, this constraint has no
technical justification and can be reverted.

## Solution

Replace env var reads with a `$RELAY_INPUT` directory, symmetric
with `$RELAY_OUTPUT` (renamed from `$RELAY_OUT`). Both directions
use the same interface: files named after artifact IDs in a
runtime-managed directory.

```bash
# Read
candidate=$(cat "$RELAY_INPUT/candidate")

# Write
echo "$score" > "$RELAY_OUTPUT/evaluation"
```

One concept, two instances. Same format rules for both directions.

## What changes

### Reads: env vars → input directory

Before:
```bash
echo "$candidate"  # env var containing the value
```

After:
```bash
cat "$RELAY_INPUT/candidate"  # file containing the value
```

The runtime creates `$RELAY_INPUT`, writes one file per read
artifact (serialized the same way env vars were — raw text for text
artifacts, JSON for structured), then sets `RELAY_INPUT=/path/to/dir`
on the child process. After exit, the directory is cleaned up.

### Writes: `$RELAY_OUT` → `$RELAY_OUTPUT`

Before:
```bash
echo "0.85" > "$RELAY_OUT/score"
```

After:
```bash
echo "0.85" > "$RELAY_OUTPUT/score"
```

Same mechanism, better name. `RELAY_OUTPUT` pairs with `RELAY_INPUT`.

### Artifact ID constraint: revert to broad pattern

The snake_case constraint (`^[a-z][a-z0-9_]*$`) was motivated by
env var naming rules. With file-based I/O, artifact IDs only need to
be valid file names. Revert to the original ID pattern
(`^[a-zA-Z0-9_.:-]+$`) shared by step IDs and route IDs.

This un-breaks artifact IDs with hyphens (`root-cause`,
`fix-notes`) that the snake_case constraint rejected.

## Format rules

Same for both directions, determined by the artifact contract:

| Contract shape | Format |
|----------------|--------|
| No fields | Plain text |
| Fields | JSON object |
| Fields + list | JSON array |

The runtime writes input files and reads output files using the same
serialization. Accumulated artifacts are serialized as the latest
entry's value (not the full history wrapper).

## What the command sees

Two env vars:

- `RELAY_INPUT` — directory of input artifact files (read-only)
- `RELAY_OUTPUT` — directory for output artifact files (write here)

Both directories are created by the runtime before the command runs.
Both are cleaned up after exit.

A command step with `reads: [candidate, config]` and
`writes: [score]` runs with:

```
RELAY_INPUT=/tmp/pi-relay-in-xxxxx/
  candidate    (file containing the candidate text)
  config       (file containing the config JSON)
RELAY_OUTPUT=/tmp/pi-relay-out-xxxxx/
  (empty, command writes score here)
```

The grader:

```bash
#!/bin/bash
candidate=$(cat "$RELAY_INPUT/candidate")
config=$(cat "$RELAY_INPUT/config")

echo "$candidate" | ./run-challenges.sh --config "$config" > raw.json
jq .score raw.json > "$RELAY_OUTPUT/score"

score=$(jq -r .score raw.json)
[ "$(echo "$score > 0.8" | bc)" -eq 1 ] && exit 0 || exit 1
```

## Missing artifacts

If a declared read artifact has not been committed by any prior step,
its file is not created in `$RELAY_INPUT`. The command can check:
`[ -f "$RELAY_INPUT/candidate" ]`. Same behavior as the env var
approach where the var was simply unset.

## What this removes

- **`CheckContext.env`** — no longer needed. The runtime doesn't
  inject env vars for artifacts.
- **`buildArtifactEnv`** — replaced by `writeArtifactInputDir`.
- **`serializeForEnv`** — replaced by `serializeForFile` (same
  logic, different name — writes to file instead of string).
- **Snake_case artifact ID validation** — the `ArtifactIdField`
  schema and the `ARTIFACT_ID_RE` compiler check revert to the
  standard `IdField` pattern.
- **`invalid_artifact_id` compile error variant** — no longer
  needed; artifact IDs use the same pattern as all other IDs.

## What this does NOT change

- **Action step artifact I/O** — unchanged. Actors read artifacts
  from the snapshot injected into their task prompt and write via
  the XML completion protocol.
- **Write enforcement** — the existing check in
  `handleActionCompleted` that ensures action steps commit required
  artifacts before routing to a reader still applies to both action
  and command step readers.
- **Accumulated entries** — command step writes still go through
  `ArtifactStore.commit` and accumulate with attribution metadata.
- **Plan preview** — still shows `Uses:` and `Produces:` for
  command step reads and writes.

## Trade-offs

**More verbose reads.** `$(cat "$RELAY_INPUT/candidate")` is noisier
than `$candidate`. In practice, a grader script assigns to a
variable at the top and uses it throughout — one extra line per
artifact.

**Two temp directories per command step.** Steps with both reads and
writes get `$RELAY_INPUT` and `$RELAY_OUTPUT`. Steps with only reads
or only writes get one. Steps with neither get none. The runtime
creates and cleans up both in a `finally` block.

**File I/O overhead.** Writing and reading artifact files adds disk
I/O compared to env vars. Negligible — artifacts are small (KB
range) and the command itself typically does far more I/O than the
artifact handoff.
