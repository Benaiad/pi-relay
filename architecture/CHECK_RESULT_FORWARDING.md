# Check Result Forwarding

## Problem

When a check step fails and routes to an action step (e.g., back to
a fix step for retry), the action step has no idea what failed. The
actor starts fresh with no context about the check outcome. It can't
see the command that was run, whether it passed or failed, or what
file was missing.

The check's failure reason is in the audit log and TUI, but invisible
to the next actor.

## Solution

Inject a short check result into the next action step's task prompt.
No output capture, no truncation. Just tell the actor WHAT failed —
the actor has tools and can rerun the command itself to see the
actual errors.

## What the actor sees

On failure:

```
## Prior check result

step: verify failed
  command: npm test
```

```
## Prior check result

step: file_check failed
  file not found: output/report.json
```

On success:

```
## Prior check result

step: verify passed
  command: npm test
```

## Design

1. **Always inject.** Both pass and fail. One or two lines. No flags.
2. **No captured output.** The actor can rerun the command with its
   own tools to see the full error. Fresh output is better than a
   stale snapshot.
3. **Describe the check, not the result details.** For
   `command_exits_zero`: show the command. For `file_exists`: show
   the path. The actor knows what to investigate.

## Where it goes

The scheduler tracks the most recent check outcome when routing to
the next step. The engine's `buildTaskPrompt` receives it and renders
the section between the identity line and the task instruction:

```
You are: worker (step: fix)

## Prior check result

step: verify failed
  command: npm test

Task: Read the test failures and fix...
```

## Implementation

1. Add `priorCheckResult` to `ActionRequest`:
   ```ts
   readonly priorCheckResult?: {
     readonly stepId: StepId;
     readonly outcome: "passed" | "failed";
     readonly description: string; // "npm test" or "output/report.json"
   };
   ```

2. The scheduler sets `priorCheckResult` when routing from a check
   step to an action step. Cleared when routing from an action step
   (not carried across multiple hops).

3. `buildTaskPrompt` in `engine.ts` renders the section if
   `priorCheckResult` is present.

4. No schema changes. No artifact changes. No template changes.
