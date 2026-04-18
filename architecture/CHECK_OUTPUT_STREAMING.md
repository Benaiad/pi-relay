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
have no equivalent. There is also no ticking elapsed timer during
checks — the footer says `elapsed X.Xs` but the value only updates
when an event fires, and check steps emit no events between
`step_started` and `check_passed`/`check_failed`.

## How Pi's bash tool renders live output

Pi's bash tool is the reference for how command output should look.
It uses its own streaming pipeline entirely separate from any
event/transcript system:

1. **Rolling buffer in the execute closure.** A `Buffer[]` array
   capped at `DEFAULT_MAX_BYTES * 2` (100KB). Every `onData` chunk
   appends to it; old chunks shift off the front.

2. **`onUpdate` on every chunk.** The execute method calls
   `onUpdate({ content: [{ type: "text", text }], details })` on
   every `onData` callback with the current buffer content. Pi's
   framework calls `renderResult` with `isPartial: true`.

3. **Collapsed: last 5 visual lines.** `renderResult` uses
   `truncateToVisualLines(output, 5, width)` for width-aware
   wrapping. If lines were skipped, a hint shows:
   `... (N earlier lines, ⌘E to expand)`

4. **Expanded: full output.** All output as styled text.

5. **Live elapsed timer.** `renderResult` starts a `setInterval`
   every 1 second that calls `context.invalidate()`. This makes
   the `Elapsed X.Xs` footer tick even when no new output arrives.
   On completion, the interval clears and the label changes to
   `Took X.Xs`.

6. **Width-aware caching.** The collapsed preview caches its
   visual line layout per terminal width and invalidates on width
   change.

7. **Output is ephemeral.** The rolling buffer lives in the execute
   closure. It is not persisted in any event log. After the command
   finishes, the final `renderResult` call shows the last result.

## What the user should see

Matching Pi's bash tool behavior inside relay's per-step rendering.

Collapsed (while check runs):

```
⏳ relay Build and test  — running
  ●●●○  2/4 done · verify · PASS src/auth.test.ts
  [elapsed 4.2s]
```

The progress line shows the last line of check output instead of
the static command description. The elapsed timer ticks.

Expanded (while check runs):

```
─── ⏳ verify
  $ npm test

  ... (12 earlier lines, ⌘E to expand)
  PASS src/auth.test.ts (0.8s)
  PASS src/router.test.ts (1.2s)
  PASS src/db.test.ts (0.3s)
  FAIL src/parser.test.ts (0.4s)
  Tests: 1 failed, 3 passed, 4 total

  Elapsed 8.2s
```

Last 5 visual lines of output with the skipped-lines hint. Same
layout as Pi's bash tool collapsed view. The command header sits
above the output.

Expanded (after completion — pass):

```
─── ✓ verify
  $ npm test
```

Output cleared, just the command and the outcome icon.

Expanded (after completion — fail):

```
─── ✗ verify
  $ npm test
  Failed: npm test exited with code 1; output: FAIL src/parser...
```

Failure reason shown, same as today.

## Design

### Check output is ephemeral display data

Pi's bash tool keeps its rolling buffer in a closure variable. It
does not persist output in any event log or state snapshot. Relay
should follow the same pattern: check output exists only for live
display and disappears after the check completes.

This means check output does NOT go through the event-sourced
`RelayEvent` → `applyEvent` → `RelayRunState` pipeline. It is a
side channel on the scheduler, read by the renderer during
execution and discarded on completion.

### Data flow

```
onData (Buffer)
  → runCommandExitsZero calls onOutput(text)
    → scheduler accumulates into per-step rolling buffer
    → scheduler notifies subscribers (new notification, not an event)
      → execute.ts subscription fires emitUpdate
        → renderRunResult reads buffer from state supplement
          → renders with truncateToVisualLines (5 lines, width-aware)
```

### Scheduler: output buffer + notification

The scheduler holds a `Map<StepId, string>` of live check output,
separate from the event-sourced `RelayRunState`. When a check
runs:

1. `executeCheck` passes an `onOutput` callback to `runCheck`.
2. The callback appends to the step's buffer (capped with the
   same rolling-tail pattern as `runCommandExitsZero`).
3. The callback notifies subscribers — a separate subscription
   from the event subscription, so the audit log is not affected.

When the check completes, the buffer is cleared.

A public method `getCheckOutput(stepId): string | undefined`
exposes the buffer for the renderer.

### Callback threading

`runCheck` and `runCommandExitsZero` gain an optional `onOutput`
callback:

```
runCheck(spec, ctx, onOutput?) → Promise<CheckOutcome>
```

`onOutput` receives decoded string chunks. For `file_exists`, it
is never called. For `command_exits_zero`, it forwards from
`onData`.

### Notification throttling

The scheduler throttles output notifications to at most one per
100ms, matching `execute.ts`'s `emitUpdate` throttle. This bounds
re-render frequency regardless of how fast the command produces
output.

### execute.ts: reading the buffer

`execute.ts` subscribes to both the existing event subscription
(for state changes) and the new output notification (for check
output). Both call `emitUpdate`. The `emitUpdate` function
already throttles to 100ms.

The `onUpdate` payload gains an optional field for live check
output:

```
details: {
  kind: "state",
  state,
  attemptTimeline,
  checkOutput?: Map<StepId, string>
}
```

Or: the renderer receives it through a separate accessor passed
alongside the state. Exact threading TBD in the impl doc.

### Rendering: match Pi's bash tool components

**Expanded view** — `appendAttemptBlock` in `run-result.ts`:

For a running check step with output, render a child component
that matches Pi's `BashResultRenderComponent`:

- Use `truncateToVisualLines(output, 5, width)` for the tail
  preview (same 5-line count as Pi's `BASH_PREVIEW_LINES`).
- Show `... (N earlier lines, ⌘E to expand)` hint using
  `truncateToWidth` when lines were skipped.
- Style output lines with `theme.fg("toolOutput", line)`.
- Use a width-aware `render(width)` function with cached layout,
  same pattern as Pi's `BashResultRenderComponent`.

For a completed check step, render the current static output
(command + outcome).

**Collapsed view** — `describeActiveStep` in `run-result.ts`:

For a running check step, extract the last non-empty line from the
check output buffer and display it instead of the static command
description. Falls back to the command description if no output has
arrived yet.

**Elapsed timer:**

`renderResult` in `index.ts` starts a `setInterval` when a check
is running, calling `context.invalidate()` every second — same
pattern as Pi's bash tool. This makes the `Elapsed X.Xs` footer
tick during check execution. The interval clears when no check
step is running.

### Audit log

Check output does NOT appear in the audit log. It is ephemeral
display data, same as Pi's bash tool output buffer. The audit log
only records `step_started`, `check_passed`/`check_failed` — same
as today.

Replay through the audit log produces a state with no check output,
which is correct: replayed state represents the final state, not a
mid-execution snapshot.

## What this does NOT cover

- **Streaming for `file_exists` checks.** No output to stream.
- **Check output in the final run report text.** The report sent
  to the model keeps its current format: pass/fail with the
  truncated failure reason. Live output is a TUI concern only.
- **Scrollback or paging.** The expanded view shows the last 5
  visual lines, matching Pi's bash tool. No scrollback.
- **Per-check expand/collapse.** Pi's bash tool has its own expand
  toggle. Relay has one expand toggle for the entire result. A
  per-step toggle would require changes to relay's rendering
  model and is out of scope.
