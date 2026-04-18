# Check Output Streaming

## Problem

When a check step runs a command like `npm test`, the user sees
nothing until it finishes. The collapsed TUI shows:

```
⏳ relay Build and test  — running
  ●●●○  2/4 done · verify
```

The `verify` label appears, but no output. If the test suite takes
30 seconds, the user stares at a static line with no indication of
progress — or whether the command is stuck. They may abort thinking
relay is frozen.

Action steps stream live because the actor subprocess emits
`action_progress` events with tool calls and narration. Check steps
have no equivalent.

## What the user should see

Collapsed (during check execution):

```
⏳ relay Build and test  — running
  ●●●○  2/4 done · verify · $ npm test
```

No change here — the `describeActiveStep` function already shows
the check description. The improvement is in the expanded view
and in the collapsed progress detail.

Collapsed (with output streaming):

```
⏳ relay Build and test  — running
  ●●●○  2/4 done · verify · PASS src/auth.test.ts
```

The collapsed progress line shows the last line of check output,
replacing the static command description once output starts
arriving. This tells the user the command is alive and progressing.

Expanded (during check execution):

```
─── ⏳ verify
  $ npm test
  PASS src/auth.test.ts (0.8s)
  PASS src/router.test.ts (1.2s)
  FAIL src/parser.test.ts (0.4s)
```

Live output lines appear as the command runs, matching how Pi's
bash tool shows streaming output.

Expanded (after completion):

```
─── ✗ verify
  $ npm test
  Failed: npm test exited with code 1; output: FAIL src/parser.test.ts...
```

The output collapses to the failure reason. Successful checks show
the command line and the pass icon — no output retained.

## Design

### Data flow

```
onData (Buffer)
  → runCommandExitsZero calls onOutput(text)
    → runCheck forwards to onOutput
      → scheduler emits check_output event
        → applyEvent appends to step transcript
          → execute.ts subscription fires emitUpdate
            → renderRunReportText / renderRunResult re-renders
```

### New event: `check_output`

```
{
  kind: "check_output",
  at: number,
  stepId: StepId,
  text: string
}
```

Emitted each time the check command produces output. The text is
the raw decoded chunk from `onData` — no accumulation or
truncation at the event level. The reducer appends a transcript
item so the TUI can render it.

### Transcript reuse

Check output is stored in the step's existing `transcript` field
as `TranscriptItem` entries with `kind: "text"`. This avoids
adding a new field to `StepRuntimeState` — checks produce text
output, which is what the transcript models.

The expanded view already knows how to render text transcript
items. The only adaptation is that check steps start rendering
their transcript the same way action steps do (interleaved text),
with the command line as a header instead of an actor name.

### Callback threading

`runCheck` and `runCommandExitsZero` gain an optional `onOutput`
callback:

```
runCheck(spec, ctx, onOutput?) → Promise<CheckOutcome>
```

`onOutput` receives decoded string chunks as they arrive. For
`file_exists` checks, it is never called. For
`command_exits_zero`, it forwards from the `onData` handler.

The scheduler passes its event emitter as the callback:

```
const onOutput = (text: string) => {
  this.emit({
    kind: "check_output",
    at: this.clock(),
    stepId: step.id,
    text,
  });
};

const outcome = await runCheck(step.check, ctx, onOutput);
```

### Collapsed progress line

`describeActiveStep` in `run-result.ts` currently returns the
check description (`command_exits_zero: npm test`) for running
checks. With streaming, it checks the step's transcript for the
last text item and shows its last non-empty line instead — same
pattern it uses for action steps. Falls back to the check
description if no output has arrived yet.

### Output volume

Check commands can produce large output (`npm test` on a big
project). The rolling buffer in `runCommandExitsZero` already caps
memory for the failure reason. For streaming, the concern is
transcript size in `StepRuntimeState`.

Mitigation: the reducer caps check transcript to the last N text
items (e.g., 50). Old entries are dropped. The expanded view
already caps action transcripts at `EXPANDED_TRANSCRIPT_LIMIT`
(15 tool calls) — a similar cap for check text items keeps the
state bounded.

The collapsed view only reads the last transcript item, so the cap
does not affect it.

### Audit log

`check_output` events are appended to the audit log like all other
events. For replay correctness, this means the audit log grows
with every output chunk. For commands that produce thousands of
lines, this could bloat the log.

Mitigation: batch output in the `onData` handler. Instead of
emitting one event per `data` chunk (which can be as small as a
few bytes), buffer and emit at most once per 100ms — matching the
throttle in `execute.ts`'s `emitUpdate`. This bounds the event
count regardless of output volume.

## What this does NOT cover

- **Streaming for `file_exists` checks.** No output to stream.
- **Persisting check output in the final run report text.** The
  report sent to the model keeps its current format: pass/fail
  with the truncated failure reason. Full output is a TUI concern.
- **Scrollback or paging.** The expanded view shows the last N
  lines. No scrollback — same limitation as Pi's bash tool.
