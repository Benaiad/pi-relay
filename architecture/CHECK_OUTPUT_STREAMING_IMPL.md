# Check Output Streaming: Implementation Plan

Reference: `architecture/CHECK_OUTPUT_STREAMING.md`

## What already exists

- `src/runtime/checks.ts` — `runCheck` and `runCommandExitsZero`
  execute commands via `createLocalBashOperations()`. The `onData`
  callback accumulates output into a rolling buffer for the failure
  reason. No external streaming callback.
- `src/runtime/scheduler.ts` — `executeCheck` calls `runCheck`,
  emits `step_started` then `check_passed`/`check_failed`. No
  events during execution. No output buffer.
- `src/execute.ts` — subscribes to scheduler events, calls
  `emitUpdate` which rebuilds the run report and sends it via
  `onUpdate` to Pi's framework.
- `src/index.ts` — `renderResult` delegates to
  `renderRelayResult` which calls `renderRunResult`. No render
  state, no interval.
- `src/render/run-result.ts` — `renderRunResult` renders
  collapsed/expanded views. Checks show `$ command` and outcome.
  `describeActiveStep` shows the static check description for
  running checks. The elapsed timer in the footer uses `Date.now()`
  but only updates when `renderResult` is called — frozen during
  checks because no events fire.
- Both relay and replay tools share `renderRelayResult`.
- Pi exports `truncateToVisualLines`, `VisualTruncateResult` from
  `@mariozechner/pi-coding-agent`. Pi exports `truncateToWidth`
  from `@mariozechner/pi-tui`.
- `ToolRenderContext` has `state: TState`, `invalidate()`.
  `ToolRenderResultOptions` has `isPartial`. `registerTool`
  accepts `TState` as a third generic. `defineTool` also supports
  it.

## Steps

### Step 1: Add onOutput callback to checks.ts

Add an optional `onOutput` callback to `runCheck` and
`runCommandExitsZero`:

```
type CheckOutputCallback = (text: string) => void;

runCheck(spec, ctx, onOutput?) → Promise<CheckOutcome>
```

In `runCommandExitsZero`, the existing `onData` handler forwards
decoded text to `onOutput` after appending to the rolling buffer.
For `runFileExists`, `onOutput` is never called.

No behavior change when `onOutput` is not provided.

Verify: `npm test -- --run test/runtime/checks.test.ts` — all
existing tests pass unchanged (no callback supplied).

### Step 2: Scheduler output buffer and notification

Add to `Scheduler`:

- `private checkOutputBuffers: Map<StepId, string[]>` — per-step
  rolling buffer of output chunks.
- `private checkOutputLens: Map<StepId, number>` — byte count per
  buffer for rolling cap.
- `private outputHandlers: Array<() => void>` — output
  notification subscribers.
- `subscribeOutput(handler: () => void): SchedulerSubscription` —
  registers a handler called when check output arrives.
- `getCheckOutput(stepId: StepId): string | undefined` — returns
  the joined buffer for a step, or undefined if none.

In `executeCheck`:

1. Create an `onOutput` callback that appends to the step's
   buffer (rolling cap at `COMMAND_OUTPUT_REASON_LIMIT * 4`,
   matching `checks.ts`), then calls all output handlers.
2. Pass `onOutput` to `runCheck`.
3. After `runCheck` returns, delete the step's buffer.

The output handlers are separate from the event handlers. Output
notifications do not touch the audit log or the event-sourced
state.

Verify: `npm test` — all tests pass. Scheduler tests use a fake
actor engine and don't run real commands, so check output buffers
remain empty. No behavior change.

### Step 3: execute.ts subscribes to output notifications

In `executePlan`:

1. Subscribe to `scheduler.subscribeOutput()` alongside the
   existing event subscription. Both call `emitUpdate(false)`.
2. When building the `onUpdate` payload, read
   `scheduler.getCheckOutput()` for all currently running steps
   and include it in the details.

Add `checkOutput` to the `"state"` variant of `RelayDetails`:

```
| {
    readonly kind: "state";
    readonly state: RelayRunState;
    readonly attemptTimeline: readonly AttemptTimelineEntry[];
    readonly checkOutput?: ReadonlyMap<StepId, string>;
  }
```

Unsubscribe the output subscription in the `finally` block
alongside the event subscription.

Verify: `npm test` — existing tests pass. The new field is
optional, so all existing `RelayDetails` construction sites
remain valid.

### Step 4: Render state and elapsed timer in index.ts

Add render state to both relay and replay tool registrations.
Match Pi's bash tool pattern:

```
type RelayRenderState = {
  interval: NodeJS.Timeout | undefined;
};
```

Update `renderRelayResult` to accept the render context's `state`
and manage the interval:

1. When `options.isPartial` is true and no interval exists, start
   `setInterval(() => context.invalidate(), 1000)`.
2. When `options.isPartial` is false, clear the interval.

This makes the footer's `elapsed X.Xs` tick every second during
the entire relay run — fixing the frozen timer for both check
steps and quiet action steps.

Both relay and replay call `renderRelayResult`, so both get the
fix.

Verify: manual — start a relay run, observe the elapsed timer
ticking during a check step.

### Step 5: Pass check output to run-result.ts renderer

Update `renderRunResult` signature to accept check output:

```
renderRunResult(
  state, timeline, theme, expanded, lastComponent,
  checkOutput?: ReadonlyMap<StepId, string>
)
```

`renderRelayResult` extracts `details.checkOutput` and passes it
through.

No rendering changes yet — this step threads the data to where
the renderer can use it.

Verify: `npm test` — the new parameter is optional.

### Step 6: Collapsed view — live output line

Update `describeActiveStep` in `run-result.ts`:

For check steps, if `checkOutput` has content for the step, extract
the last non-empty line and display it in `toolOutput` color instead
of the static check description. Falls back to the description if
no output yet.

The check output map is threaded from `renderRunResult` →
`formatCollapsed` → `buildProgressDetail` → `describeActiveStep`.

Verify: manual — run a check step that produces output, observe
the collapsed progress line updating with the last output line.

### Step 7: Expanded view — bash-style output preview

Update `appendAttemptBlock` in `run-result.ts`:

For a running check step with output (status `"running"` and check
output present), render the output using Pi's bash tool pattern:

1. Show `$ command` header as today.
2. Add a child component with a `render(width)` function that:
   - Calls `truncateToVisualLines(output, 5, width)` for the
     tail preview.
   - Shows `... (N earlier lines, ⌘E to expand)` hint when lines
     were skipped, using `truncateToWidth`.
   - Caches layout per width, invalidates on width change.
   - Styles lines with `theme.fg("toolOutput", line)`.
3. If expanded, show full output as styled text (matching Pi's
   expanded bash view).
4. Show `Elapsed X.Xs` footer using the step's `startedAt`.

For completed check steps, keep the current rendering (command +
outcome).

New imports in `run-result.ts`:
- `truncateToVisualLines` from `@mariozechner/pi-coding-agent`
- `truncateToWidth` from `@mariozechner/pi-tui`

Verify: manual — run a relay plan with a check step that produces
output (e.g., `npm test`). Observe:
- Collapsed: last output line in progress detail
- Expanded: 5-line tail with skipped-lines hint
- Elapsed timer ticking
- After completion: output disappears, outcome shown

### Step 8: Full verify

Run full suite: `npm test` and `npm run check` (tsc + biome).

Manual verification with a real relay plan that has a
`command_exits_zero` check producing output.

## File change summary

| File | Change |
|---|---|
| `src/runtime/checks.ts` | Add optional `onOutput` callback to `runCheck` and `runCommandExitsZero` |
| `src/runtime/scheduler.ts` | Add output buffer, output subscription, `getCheckOutput`, thread `onOutput` into `executeCheck` |
| `src/execute.ts` | Subscribe to output notifications, include `checkOutput` in `RelayDetails` |
| `src/index.ts` | Add `RelayRenderState` with interval, manage timer in `renderRelayResult`, update `RelayDetails` type |
| `src/replay.ts` | Update `registerTool` call to include `RelayRenderState` generic |
| `src/render/run-result.ts` | Accept `checkOutput` param, update collapsed and expanded check rendering |

## Risks

1. **Rolling buffer cap mismatch.** The scheduler's display buffer
   and `runCommandExitsZero`'s failure-reason buffer are separate.
   The display buffer should be larger (it shows 5 visual lines of
   potentially wide output). Using a generous cap (e.g., 32KB)
   avoids truncating the display while keeping memory bounded.

2. **Output notification frequency.** `onData` can fire many times
   per second for chatty commands. Each notification calls
   `emitUpdate(false)`, which already throttles to 100ms. But the
   output handler invocation itself is unthrottled. If hundreds of
   handlers fire per second, the array iteration is cheap but worth
   monitoring. Pi's bash tool also re-renders on every chunk and
   relies on the framework's own coalescing.

3. **Render state initialization.** Pi's framework initializes
   `context.state` to `{}` for tools with no explicit default.
   The interval field starts as `undefined`, which is correct. But
   if the framework clones or resets state between renders, the
   interval reference could be lost, leaking timers. Pi's own bash
   tool uses the same pattern successfully, so this should be safe.

4. **Replay tool render state.** Both relay and replay need the
   same `RelayRenderState`. Since both call `renderRelayResult`,
   the interval logic is shared. The type just needs to be applied
   to both `registerTool` calls.
