# Run Report Redesign — Implementation Plan

References: `architecture/RUN_REPORT.md`

## What already exists

- **`src/runtime/run-report.ts`** — `renderRunReportText` produces the text the assistant reads. Walks `report.timeline` (chronological attempt entries) and calls `formatTimelineEntry` per attempt. Helper functions: `extractAttemptFinalText`, `describeCommandStep`, `oneLine`, `outcomeLabel`, `buildStepArtifactIndex`. Types: `RunReport`, `StepSummary`, `AttemptSummary`, `AttemptOutcome`.
- **`src/runtime/checks.ts`** — `runCommand` and `runFilesExist`. `CheckOutcome` is `pass` (no data) or `fail` (reason string). `truncateOutput` takes first 800 chars. `formatCommandFailure` joins command + exit code + truncated output on one line.
- **`src/runtime/events.ts`** — `check_passed` carries no output. `check_failed` carries a `reason` string. `action_completed` carries `route` and `usage` but no summary. Reducer `applyEvent` is the single source of truth.
- **`src/runtime/scheduler.ts`** — `executeCommand` captures output via `onOutput` callback into `checkOutputChunks` (ring buffer, ~16KB). On pass, emits `check_passed` with no data. On fail, emits `check_failed` with `outcome.reason` (which embeds truncated output).
- **`src/actors/completion-tool.ts`** — `turn_complete` tool schema has `route` + spread artifact properties. `CompletionDetails` is `{ route, artifacts }`.
- **`src/actors/sdk-engine.ts`** — Extracts `CompletionDetails` from session messages. `ActionOutcome.completed` carries `route`, `writes`, `usage`, `transcript`.
- **`src/render/format.ts`** — `formatToolCall` renders tool call one-liners. Bash commands truncated to 60 chars. Shared between TUI and text report via `plainTheme`.
- **`src/runtime/run-report.ts:buildAttemptTimeline`** — Walks audit log and produces chronological `AttemptTimelineEntry[]`. Each entry has `stepId` + `AttemptSummary`. The text renderer currently walks this timeline flat, producing one section per attempt — a step that runs 4 times produces 4 sections.
- **`describeCommandStep` exists in four variants:**
  - `scheduler.ts:70` — no truncation, used for `PriorCheckResult.description` passed to actors.
  - `run-report.ts:579` — 120-char truncation, used in the text report.
  - `run-result.ts:478` (`describeCommandStepInline`) — 120-char truncation, TUI expanded view.
  - `run-result.ts:569` (`describeCommandStepShort`) — 60-char truncation, TUI collapsed view.
  Only the `run-report.ts` variant is changed by this work. The scheduler and TUI variants are unaffected.

## Architecture decisions

**1. `assistant_summary` on `turn_complete`.** Add a mandatory `assistant_summary: string` field to the `turn_complete` tool. Thread it through `CompletionDetails` -> `ActionOutcome.completed` -> `action_completed` event -> `AttemptSummary`. The report renders it as the action step's text line. This is the only reliable text output from an actor.

**2. Command output on both pass and fail.** Change `CheckOutcome` to carry output and exit code on both outcomes. Currently `pass` has no data and `fail` bakes output into a `reason` string. The new shape: `{ kind: "pass" | "fail", exitCode: number | null, output: string }`. The `check_passed` event gains an `output` field. The report renderer uses these directly instead of parsing them out of a reason string.

**3. Tail-based output capture.** Replace `truncateOutput` (first 800 chars) with `tailLines` (last 20 lines, each line capped at 256 chars). Increase the ring buffer from ~3.2KB to ~32KB so 20 meaningful lines are always available.

**4. Route resolution in the report.** The report needs "Routed to -> <target_step_id>". The `AttemptSummary` already has `route: RouteId`. The `Program` has `edges: Map<EdgeKey, StepId>`. The renderer resolves `edgeKey(stepId, route) -> targetStepId` from the program. For command/files_exist steps, the route is always `success` or `failure`, mapping to `onSuccess`/`onFailure`.

**5. Loop compression.** Change `renderRunReportText` from walking the flat timeline (one section per attempt) to grouping by step. Each step gets one `##` section. If the step ran multiple times: prior attempts as one-liners (last 5), latest attempt in full. This replaces the current flat timeline walk.

**6. `formatToolCall` bash limit.** The 60-char limit on bash commands in `formatToolCall` is appropriate for the TUI (column-constrained) but not for the text report. Add an optional `bashLimit` parameter. The TUI path passes 60, the text report path passes no limit.

## Data flow changes

```
turn_complete tool
  ├── adds: assistant_summary (mandatory string field)
  └── CompletionDetails gains: assistant_summary

sdk-engine.ts
  └── ActionOutcome.completed gains: assistant_summary
      (extracted from CompletionDetails alongside route/artifacts)

scheduler.ts
  └── action_completed event gains: assistant_summary
      (threaded from outcome through handleActionCompleted)

events.ts
  ├── action_completed event type gains: assistant_summary: string
  └── applyEvent: no change needed (summary is in the audit log,
      report builder reads it from there)

run-report.ts
  ├── AttemptSummary gains: assistant_summary?: string
  ├── buildAttemptTimeline: populates assistant_summary from
  │   action_completed events
  └── renderRunReportText: renders it in the action step section

checks.ts
  ├── CheckOutcome becomes: { kind, exitCode, output }
  └── tailLines replaces truncateOutput

events.ts
  ├── check_passed gains: output: string, exitCode: number | null
  └── check_failed gains: exitCode: number | null
      (output is already in reason, but we separate them)

scheduler.ts
  └── executeCommand passes output + exitCode to both events

run-report.ts
  ├── AttemptSummary gains: exitCode?: number | null, output?: string
  ├── buildAttemptTimeline: populates from check events
  └── formatTimelineEntry: renders exit code + tail output
```

## Step-by-step implementation

Each step produces a compiling, testable increment. Run `npm run check && npm test` after each.

### Step 1: Add `assistant_summary` to `turn_complete`

**Files:** `src/actors/completion-tool.ts`, `test/actors/completion-tool.test.ts`

- Add `assistant_summary: Type.String({ minLength: 1, maxLength: 2000 })` as a required field in the parameters schema, before the artifact properties spread.
- Update `CompletionDetails` to include `assistant_summary: string`.
- In `execute`, extract `assistant_summary` from params alongside `route`.
- Update `buildDescription` to mention the field.
- Update `promptGuidelines` to instruct the model: `"In assistant_summary, describe what you did and why you chose this route. Be specific — this is the only text the caller sees."` This is the more impactful prompt surface — `promptGuidelines` are injected as tool-use guidance, while `description` is the tool's docstring.
- Update existing tests, add a test that `assistant_summary` is required.

### Step 2: Thread `assistant_summary` through the engine

**Files:** `src/actors/types.ts`, `src/actors/sdk-engine.ts`, `test/actors/sdk-engine.test.ts`

- Add `assistant_summary: string` to `ActionOutcome.completed`.
- In `sdk-engine.ts` `runAction`, extract `completion.assistant_summary` and include it in the returned outcome.
- Update tests that construct `completed` outcomes.

### Step 3: Thread `assistant_summary` through events and scheduler

**Files:** `src/runtime/events.ts`, `src/runtime/scheduler.ts`, `test/runtime/scheduler.test.ts`

- Add `assistant_summary: string` to the `action_completed` event variant.
- Add `assistant_summary` parameter to `handleActionCompleted`.
- Pass it from `outcome.assistant_summary` through the call at line 397.
- `applyEvent` does not need to store it — the audit log retains it and the report builder reads from there.
- Update scheduler tests that assert on `action_completed` events or construct `completed` outcomes via fake engines.

### Step 4: Restructure `CheckOutcome` and output capture

**Files:** `src/runtime/checks.ts`, `test/runtime/checks.test.ts`

- Change `CheckOutcome` to:
  ```typescript
  type CheckOutcome = {
      readonly kind: "pass" | "fail";
      readonly exitCode: number | null;
      readonly output: string;
  };
  ```
- Replace `truncateOutput` with `tailLines(text: string, maxLines: number, maxLineLength: number): string`.
- Replace `formatCommandFailure` — it no longer builds a reason string. Just return the structured outcome.
- `runCommand`: on exit 0, return `{ kind: "pass", exitCode: 0, output: tailLines(drainOutput(), 20, 256) }`. On non-zero, return `{ kind: "fail", exitCode, output: tailLines(drainOutput(), 20, 256) }`. On timeout/abort/spawn error, return `{ kind: "fail", exitCode: null, output: tailLines(drainOutput(), 20, 256) }` with a descriptive reason still needed — add a `reason?: string` field for non-exit failure modes.
- Increase `MAX_OUTPUT_BUFFER` from `COMMAND_OUTPUT_REASON_LIMIT * 4` (~3.2KB) to `32_000`.
- Update tests. The test at line 121 asserts `outcome.reason` contains "code 3" and "boom" — restructure to assert on `exitCode` and `output` fields.
- `runFilesExist` returns `{ kind: "pass" | "fail", exitCode: null, output: "" }` with reason for missing paths. Add `reason?: string` for the failure description.

Revised `CheckOutcome`:
```typescript
type CheckOutcome = {
    readonly kind: "pass" | "fail";
    readonly exitCode: number | null;
    readonly output: string;
    readonly reason?: string; // human description for non-exit failures (timeout, spawn error, missing files)
};
```

### Step 5: Thread output and exit code through events

**Files:** `src/runtime/events.ts`, `src/runtime/scheduler.ts`

- Add `output: string` and `exitCode: number | null` to `check_passed` event.
- Add `exitCode: number | null` and `output: string` to `check_failed` event (replacing the single `reason` that baked everything together). Keep `reason` for the human-readable failure description.
- Update `scheduler.ts` `executeCommand`: pass `outcome.output`, `outcome.exitCode` to both `check_passed` and `check_failed` events. For `check_failed`, use `outcome.reason` or construct one from exit code.
- Update `applyEvent` if needed (it stores `lastReason` from `check_failed` — this can stay as-is using the event's `reason`).
- Update scheduler tests.

### Step 6: Add `bashLimit` parameter to `formatToolCall`

**Files:** `src/render/format.ts`, `test/render/format.test.ts`

- Add optional `bashLimit?: number` parameter to `formatToolCall`.
- The bash case uses `bashLimit ?? 60` as the preview length.
- Existing callers (TUI in `run-result.ts`) pass no argument, keeping the 60-char default.
- The text report caller will pass `undefined` (no limit) in the next step.
- Update tests if any assert on the 60-char truncation.

### Step 7: Rewrite `renderRunReportText`

**Files:** `src/runtime/run-report.ts`

This is the main change. Replace the current flat-timeline renderer with a grouped-by-step markdown renderer.

- Add `assistant_summary?: string`, `exitCode?: number | null`, `output?: string` to `AttemptSummary`.
- Update `buildAttemptTimeline` to populate these from `action_completed` (summary) and `check_passed`/`check_failed` (exit code, output) events.
- Group timeline entries by step ID (preserving execution order for the step's first appearance).

New `renderRunReportText` structure:
1. Header: `# Relay: <OUTCOME>` + task.
2. For each step (in order of first activation):
   - `## <step_id> -- <kind-specific label>`
   - If multiple runs: prior attempts as one-liners (last 5), then `### Latest (run N)` with full detail.
   - If single run: full detail directly under the `##` header.
3. Artifacts section: `## Artifacts` with each artifact's rendered value. Use `ArtifactStore.all()` to iterate final artifact values instead of the current `buildStepArtifactIndex` (which maps artifacts to step:attempt keys for inline rendering). `buildStepArtifactIndex` becomes dead code.
4. No skipped steps. No usage stats. No `oneLine()` anywhere.

Detail rendering per step kind:
- **Action:** tool calls (using `formatToolCall` with no bash limit), `assistant_summary`, `Routed to -> <resolved target step>`.
- **Command:** `$ <full command>`, `Exit code: <N>`, tail output in a fenced code block, `Routed to -> <resolved target step>`.
- **Files exist:** `Paths: ...`, `Result: pass | fail (missing: ...)`, `Routed to -> <resolved target step>`. No exit code, no output — `files_exist` steps are a distinct branch in the renderer.
- **Terminal:** outcome + summary.

Command output must be wrapped in fenced code blocks (triple backticks). Raw output can contain markdown-significant characters (`#`, `*`, `|`, backticks) that would be accidentally interpreted without fences.

Route resolution: use `program.edges.get(edgeKey(stepId, route))` to resolve the target step ID. The `program` is available on `report.steps[*].stepId` -> `state.program`. Add `program` as a parameter to `renderRunReportText`, or access it via `report.planId` — actually, the simplest path: pass the edge map to the renderer, or resolve routes when building `AttemptSummary` so it carries `targetStepId?: StepId`.

Decision: resolve route to target step ID when building `AttemptSummary`. Add `readonly routedTo?: StepId` to `AttemptSummary`. `buildAttemptTimeline` looks up the edge using the program. This keeps the renderer pure — it just formats data it already has.

One-liner format for prior action attempts:
```
- run N: <assistant_summary truncated to 80 chars>, routed to -> <target>
- run N: failed: <reason truncated to 80 chars>
```

One-liner format for prior command attempts:
```
- run N: exit <code>, routed to -> <target>
- run N: failed: <reason truncated to 80 chars>
```

Remove:
- `GENERIC_ROUTE_NAMES_TEXT` and the route suppression logic.
- `extractAttemptFinalText` (replaced by `assistant_summary`).
- `oneLine` (no longer used in the report).
- `describeCommandStep` 120-char truncation — show full command.
- The skipped steps section.
- The usage/cost footer.

### Step 8: Update `execute.ts` to pass program to report renderer

**Files:** `src/execute.ts`

- Pass `program` (or its edge map) to `buildRunReport` / `renderRunReportText` so route resolution works.
- `buildRunReport` already receives `state` which has `state.program`. Check if `buildAttemptTimeline` has access — it currently takes `events: readonly RelayEvent[]`. Change its signature to also accept the `Program` so it can resolve routes.
- Update `buildAttemptTimeline` call sites (in `execute.ts` and in the `onUpdate` callback).

### Step 9: Update tests

**Files:** `test/runtime/checks.test.ts`, `test/runtime/scheduler.test.ts`, `test/actors/completion-tool.test.ts`, `test/actors/sdk-engine.test.ts`

- Mechanical updates: any test constructing `CheckOutcome`, `ActionOutcome.completed`, `action_completed` events, or `CompletionDetails` needs the new fields.
- Add tests for `tailLines`: empty input, input under limit, input over limit, long lines truncated.
- Add test for `renderRunReportText` with a multi-run step to verify loop compression and the last-5 prior runs cap.

### Step 10: Verify and clean up

- `npm run check && npm test`
- Read through the generated report text for a sample plan to verify it matches the design doc's format.
- Remove dead code in `run-report.ts`:
  - `GENERIC_ROUTE_NAMES_TEXT` — route suppression removed.
  - `extractAttemptFinalText` — replaced by `assistant_summary`.
  - `buildStepArtifactIndex` — artifacts moved to dedicated section using `ArtifactStore.all()`.
  - `oneLine` — no longer used in the report (keep the one in `format.ts`, it's used by the TUI).
  - `buildSummary` — summary removed from header, terminal step section carries it.
  - `RunReport.summary` field — if nothing else reads it after the header removal.
- Remove dead code in `checks.ts`:
  - `COMMAND_OUTPUT_REASON_LIMIT` constant.
  - `truncateOutput` function.
  - `formatCommandFailure` function.

## Dependency graph

```
Step 1 (completion-tool)
  └── Step 2 (sdk-engine)
        └── Step 3 (events + scheduler)

Step 4 (checks.ts)
  └── Step 5 (events + scheduler for check output)

Step 6 (formatToolCall bash limit) — independent

Steps 3, 5, 6 all feed into:
  └── Step 7 (rewrite renderRunReportText)
        └── Step 8 (execute.ts wiring)
              └── Step 9 (tests)
                    └── Step 10 (verify + cleanup)
```

Steps 1-3 and Steps 4-5 are independent chains and can be done in either order. Step 6 is independent of both. All three converge at Step 7.

## Risks

**1. Scheduler test volume.** `scheduler.test.ts` is 1395 lines. Many tests construct fake `ActionOutcome` values and assert on emitted events. Adding `assistant_summary` to `completed` and restructuring `CheckOutcome` will touch many of them. Delegate to a subagent.

**2. `applyEvent` and audit replay.** `events.ts` has a replay invariant (running scheduler then replaying audit log yields identical state). Adding fields to events must preserve this. The new fields (`assistant_summary`, `output`, `exitCode`) are informational — `applyEvent` doesn't need to store them in `StepRuntimeState` (the audit log retains them for the report builder). This keeps the reducer unchanged.

**3. `buildAttemptTimeline` needs program access.** Currently it takes only `events`. Adding `program` as a parameter changes its signature. Two call sites: `execute.ts:155` (in `emitUpdate`) and `execute.ts:170` (final report). Both have `program` in scope, so the wiring is straightforward.

**4. Backward compatibility of `check_passed` event.** If there's any audit log replay or persistence that depends on the current event shapes, adding fields to `check_passed` could break deserialization. Check if events are persisted — if not, this is safe. The current code constructs events in-memory only.

**5. `check_failed.reason` format change.** `applyEvent` stores `event.reason` in `StepRuntimeState.lastReason`. The TUI reads `lastReason` for display. Currently `reason` is the baked-together string from `formatCommandFailure` (command + exit code + truncated output on one line). After the change, `reason` becomes a cleaner message like `"cargo test exited with code 1"` without the output baked in (output moves to its own field). The TUI will show less in `lastReason` than before. This is acceptable — the TUI's expanded view has access to `AttemptSummary` via `AttemptTimelineEntry`, which will carry the new `output` and `exitCode` fields. The TUI can adopt those in a future change.

**6. `buildSummary` usage outside the text report.** Verify that `RunReport.summary` and `buildSummary` are only consumed by `renderRunReportText`. If the `onUpdate` streaming path or the TUI reads `report.summary`, removing it would break those paths. Check callers before deleting.
