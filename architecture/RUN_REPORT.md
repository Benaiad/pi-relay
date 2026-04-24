# Run Report Redesign

## Problem

The text returned by the `relay` tool is the only thing the outer assistant reads to understand what happened inside a plan execution. It's also displayed to the user in the TUI. The current format has several problems that make it unreliable for both audiences:

1. **Failed command output is unreadable.** Three layers destroy it: `truncateOutput` takes the *first* 800 chars (errors are at the end), `formatCommandFailure` joins everything with `;`, and `oneLine()` collapses all newlines to spaces. A compiler error becomes a wall of text on one line.

2. **Successful commands are silent.** No output, no exit code, no confirmation beyond the command text itself. The model can't distinguish a passed step from a skipped one.

3. **Commands are truncated.** Command step descriptions are cut at 120 chars, bash tool calls in actor transcripts at 60 chars. The model can't see what actually ran.

4. **Routing is hidden.** The model doesn't see which step was routed to next unless the route has a non-generic name. This breaks its ability to follow the execution flow.

5. **Multi-line content is flattened.** Actor replies, failure reasons, and terminal summaries are all passed through `oneLine()`, destroying structure.

6. **Loops produce unbounded output.** A step that runs 100 times produces 100 full transcripts. No compression for repeated activations.

## Design

The report is markdown. Clean enough to display in a TUI, structured enough for a model to parse. One format serves both audiences.

### Report structure

```markdown
# Relay: SUCCESS

**Task:** <full task description, no truncation>

---

## <step_id> -- actor: <actor_name>

> <tool calls, one per line, no truncation>

<assistant_summary from turn_complete>

Routed to -> <target_step_id>

---

## <step_id> -- command

$ <full command, no truncation>

Exit code: <N>

<last 20 lines of stdout+stderr>

Routed to -> <target_step_id>

---

## <step_id> -- files_exist

Paths: <path1>, <path2>
Result: pass | fail (missing: <path>)

Routed to -> <target_step_id>

---

## <step_id> -- terminal: <success|failure>

<terminal summary>

---

## Artifacts

### <artifact_id>

<rendered value>

### <artifact_id>

<rendered value>

```

### Step details

**Action steps** show the actor's tool call transcript and summary. Tool calls are rendered as one line each. Bash commands are shown in full -- no 60-char truncation. The summary comes from a mandatory `assistant_summary` field on the `turn_complete` tool -- a short description of what the actor did and why it chose its route. This is the reliable text line per action step; free-form text blocks between tool calls are not included in the report.

**Command steps** show the full command, the exit code, and the last 20 lines of combined stdout+stderr in a fenced code block. This applies on both success and failure. On failure the exit code tells the model something went wrong; the tail output tells it what. On success the exit code confirms it passed; the tail output provides evidence (e.g. "42 tests passed"). Output is fenced to prevent accidental markdown interpretation of characters like `#`, `*`, or backticks in command output.

**Files-exist steps** show the paths checked, the result, and which paths were missing on failure.

**Terminal steps** show the outcome and summary.

**All non-terminal steps** show the routed-to step ID. No exceptions, no suppression of "generic" route names. The model needs to follow the execution graph.

### Handling loops

A step that runs multiple times gets one section, not N sections. Prior runs are compressed to one line each. Only the latest run shows full detail.

```markdown
## review -- actor: reviewer (4 runs)

- run 1: routed to -> fix
- run 2: routed to -> fix
- run 3: failed: actor did not produce a completion

### Latest (run 4)

> read src/lib.rs:1-200
> edit src/lib.rs

Fixed the remaining lifetime issue in the iterator impl.

Routed to -> done
```

When an action step has more than 5 runs, only the last 5 prior runs are listed:

```markdown
## review -- actor: reviewer (20 runs)

... 15 earlier runs omitted

- run 16: routed to -> fix
- run 17: routed to -> fix
- run 18: routed to -> fix
- run 19: routed to -> fix

### Latest (run 20)

> read src/lib.rs:1-200
> edit src/lib.rs

Fixed the remaining lifetime issue in the iterator impl.

Routed to -> done
```

Command steps follow the same pattern -- last 5 prior runs as one-liners, full detail for the latest:

```markdown
## verify -- command (3 runs)

- run 1: exit 1, routed to -> fix
- run 2: exit 1, routed to -> fix

### Latest (run 3)

$ cargo test && cargo clippy -- -D warnings

Exit code: 0

running 12 tests
test auth::login ... ok
test auth::logout ... ok
...
test result: ok. 12 passed; 0 failed

Routed to -> success
```

The one-line summaries for prior runs show the route taken and, for action steps, the failure mode. For command steps they show the exit code and route. This gives the model enough to understand the trajectory without the full output.

### Artifacts

Artifacts are shown in a dedicated section at the end of the report, after all steps. Each artifact shows its ID and rendered value.

For plain text artifacts, the value is shown as-is. For structured artifacts (fields), the value is rendered in the existing YAML-like format. For accumulated artifacts (list=true), all entries are shown, most recent last.

Artifact values are not truncated. If an artifact is large, that's a plan design issue, not a report formatting issue.

### What is removed

- **Skipped steps.** The "(N steps not reached: ...)" line is removed. The model doesn't need to know what didn't run.
- **One-line collapsing.** `oneLine()` is not applied to any content in the report. Multi-line text stays multi-line.
- **Character-based truncation.** No 60-char, 120-char, or 800-char limits. Commands, actor replies, and failure reasons are shown in full.
- **First-N-chars output capture.** Replaced with last-N-lines. Errors are at the end of output, not the beginning.
- **Generic route suppression.** The current code skips routes named "done", "next", "success", etc. All routes are shown.
- **Per-step duration.** Not useful for the model.

### Output tail length

Command step output is capped at the last 20 lines. This is enough to show a compiler error, a test failure summary, or a linter report. Individual lines longer than 256 characters are truncated with an ellipsis. This prevents a single minified JSON blob or base64 string from blowing up the report.

The buffer retains the last ~32KB of raw output so that 20 lines are available even for long-running commands.

If 20 lines proves too short for common failure modes (e.g. cargo test prints a backtrace that alone exceeds 20 lines), the constant can be raised. It should not be made configurable per-step -- that pushes formatting concerns into plan authoring.

## Scope

This redesign covers `renderRunReportText` (the text content the model reads) and its supporting functions in `checks.ts` and `format.ts`. The TUI widget renderer in `render/run-result.ts` is a separate concern and is not changed by this work, though it could adopt the same markdown format in the future.

## What this does NOT cover

- Streaming updates during execution (the `onUpdate` path). Those continue to use the existing format.
- The TUI's expanded/collapsed view. That renderer is independent.
- Artifact size limits or artifact truncation policy. If this becomes a problem it's a separate design question.
- Changes to the plan schema or step types.
