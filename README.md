# pi-relay

Graph-based planning and execution for the [pi coding agent](https://github.com/badlogic/pi-mono).

Two tools, one runtime:

- **`relay`** — the model builds an ad-hoc plan from scratch for novel tasks.
- **`replay`** — the model invokes a saved plan template by name with
  arguments for recurring workflows.

Both compile through the same compiler, run on the same scheduler, and
render with the same TUI components.

> Status: v0.1 in development. See [`architecture/RELAY_PI.md`](architecture/RELAY_PI.md)
> for the design and [`architecture/RELAY_PI_IMPL.md`](architecture/RELAY_PI_IMPL.md)
> for the implementation plan.

## Why

Pi handles single-step and short multi-step tasks well. It struggles with
workflows that need:

- **Deterministic verification gates.** Tests must pass before commit, and
  the runtime — not the model's interpretation of test output — decides.
- **Typed artifacts between steps.** One step's output reaches the next in
  a known shape, not a paraphrased transcript.
- **Replay and audit.** A run is a structured event log keyed by step,
  route, artifact, and retry attempt.

Relay is a specialist tool. Most pi sessions will not invoke it. The model
should call `relay` only for tasks with at least one of: multiple actors,
verification gates, parallel work that needs joining, or workflows where
partial success is unacceptable.

## The assistant is the planner; actors execute

The outer pi assistant is already a planner. When it calls `relay`, the
`PlanDraft` it produces IS the plan — step ids, instructions, routing,
artifact contracts. Do not add a "planner" actor inside the plan to do
more planning; that is a second planning round the assistant should have
done before writing the plan.

Actors exist to execute concrete work that doesn't fit inside the
assistant's loop: writing files and running commands in an isolated
subprocess (`worker`), reviewing another actor's output against success
criteria (`reviewer`), and any other role you curate. They are the
"hands" of the plan, not the "brain" — the brain already finished its
job when the `relay` tool call fired.

This project ships two sample actors (`worker`, `reviewer`) and no
planner. Roll your own roles freely, but resist the urge to put a
planner inside the plan.

## Install

```bash
pi install https://github.com/benaiad/pi-relay
```

On first load, the extension automatically copies sample actors
(`worker`, `reviewer`) and plan templates (`verified-edit`, `bug-fix`,
`reviewed-edit`, `multi-gate`, `autoresearch`) to
`~/.pi/agent/relay/`. Existing files are never overwritten.

The model will see `relay` and `replay` tools in its tool list.
Use `/relay` to browse installed actors and templates.

### Development install

```bash
git clone https://github.com/benaiad/pi-relay.git ~/repos/pi-relay
cd ~/repos/pi-relay
npm install
ln -sfn "$(pwd)/src" ~/.pi/agent/extensions/relay
```

The auto-seed runs on first load and skips any files that already
exist (including symlinks).
Ask pi for something that needs planning + implementation + verification
(for example: "plan the migration to adjust the auth flow, implement it,
and make sure the test suite still passes") and the model should call
`relay` with a structured plan.

## Writing an actor

Actors are markdown files with YAML frontmatter, dropped into
`~/.pi/agent/relay/actors/` (user scope) or `<project>/.pi/relay/actors/`
(project scope). The structure matches pi's existing subagent convention:

```markdown
---
name: worker
description: Applies code changes to the repo
tools: read, edit, write, grep, find, ls, bash
model: claude-sonnet-4-6
---

You are a coding worker executing one step of a Relay plan.

Responsibilities:
- Read the task instruction and input artifacts carefully before acting.
- Make the smallest changes that satisfy the task.
- ...
```

Fields:

- `name` (required) — the id steps reference in `step.actor`
- `description` (required) — shown to the model as part of the `relay` tool
  description so it knows which actor to pick for each step
- `tools` (optional, comma-separated) — restricts the actor to a subset of
  pi's registered tools. Omit to use pi's default tool list.
- `model` (optional) — overrides pi's active model for this actor
- body — the actor's system prompt

Two discovery phases with different cache semantics:

- **Tool description (model-visible)** is built ONCE at extension load from
  the actor set present at that moment. The list is embedded in the `relay`
  tool's description so the model sees it from turn 1 with zero per-turn
  cost and stable prompt caching. If you add or rename an actor mid-session,
  run pi's `/reload` command to rebuild the description.
- **Execute path (runtime)** re-discovers on every `relay` call, so
  *editing the body* of an existing actor (its system prompt or tool list)
  takes effect on the very next call without `/reload`. Only adding, renaming,
  or removing actors needs a reload.

## Replay — saved plan templates

For recurring workflows, save a plan as a markdown file with YAML
frontmatter. The `replay` tool lets the model invoke it by name with
arguments. The plan structure runs exactly as authored — the model
provides arguments, not the plan itself.

Templates live in `~/.pi/agent/relay/plans/` (user scope) or
`<project>/.pi/relay/plans/` (project scope). Four templates ship
with the repo:

- **verified-edit**(task, verify) — implement a change then verify with
  a shell command. The simplest template: one action step, one gate.
- **bug-fix**(bug, verify) — structured diagnosis then fix then verify.
  The diagnosis writes an artifact the fix step reads — root cause
  before code changes.
- **reviewed-edit**(task, criteria, verify) — implement, then two-stage
  fresh-context review (spec compliance then code quality), fix loop
  until both approve, then verify.
- **multi-gate**(task, gate1, gate1_name, gate2, gate2_name, gate3,
  gate3_name) — implement then run three sequential verification gates.
  Each gate reports independently so you see exactly which one failed.

The frontmatter declares `name`, `description`, and `parameters`. The
body is the plan in YAML with `{{param}}` placeholders. When the model
calls `replay`, the extension substitutes the arguments, validates
against the plan schema, compiles, and runs — no model reinterpretation
of the plan structure.

### Writing a template

```markdown
---
name: my-workflow
description: "What this does and when to use it."
parameters:
  - name: task
    description: What to implement.
    required: true
  - name: verify
    description: Shell command that must exit 0.
    required: true
---

task: "{{task}}"
entryStep: implement
artifacts:
  - id: notes
    description: Implementation notes.
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: implement
    actor: worker
    instruction: |
      {{task}}
      Write notes to the notes artifact.
    reads: []
    writes: [notes]
    routes: [{ route: done, to: verify }]
  - kind: check
    id: verify
    check: { kind: command_exits_zero, command: "{{verify}}" }
    onPass: done
    onFail: failed
  - kind: terminal
    id: done
    outcome: success
    summary: Done.
  - kind: terminal
    id: failed
    outcome: failure
    summary: Verification failed.
```

Check commands run through the platform shell (`/bin/sh` on Unix,
`cmd.exe` on Windows), so compound commands like
`npm test && npm run lint` work directly.

Use `/relay` to browse installed actors and templates.

## Writing a plan (JSON shape)

The model produces plans as the arguments of the `relay` tool call. A minimal
hand-written plan looks like this:

```json
{
  "task": "Add a feature flag to the user service and make sure tests pass.",
  "successCriteria": "Tests pass and the flag is wired to the canonical registry.",
  "artifacts": [
    { "id": "notes", "description": "Implementer notes", "shape": { "kind": "untyped_json" } }
  ],
  "steps": [
    {
      "kind": "action",
      "id": "implement",
      "actor": "worker",
      "instruction": "Add a boolean feature flag 'rollout_v2' to src/users/flags.ts, wire it to the canonical feature registry in src/features/registry.ts, and update src/users/service.ts to read it. Record your changes in notes.",
      "reads": [],
      "writes": ["notes"],
      "routes": [{ "route": "done", "to": "verify" }],
      "retry": { "maxAttempts": 2 }
    },
    {
      "kind": "check",
      "id": "verify",
      "check": { "kind": "command_exits_zero", "command": "npm test", "timeoutMs": 120000 },
      "onPass": "done",
      "onFail": "failed"
    },
    { "kind": "terminal", "id": "done", "outcome": "success", "summary": "Feature flag shipped and tests are green." },
    { "kind": "terminal", "id": "failed", "outcome": "failure", "summary": "Tests failed after implementation." }
  ],
  "entryStep": "implement"
}
```

Note that the plan's `implement` step carries a concrete instruction with
actual file paths — the assistant scouted the codebase BEFORE writing the
plan and baked the targets into the instruction. The plan's job is to
execute, not to re-discover what to do. If the assistant needs to scout,
it scouts with its own read/grep/find tools in the same turn and writes a
plan that knows exactly what to change.

Rules enforced by the compiler (every violation returns a structured error
to the model, which may resubmit a corrected plan in the same turn):

- Every step id is unique.
- The entry step exists.
- Every actor reference resolves against a discovered actor.
- Every route's `to` target is a real step.
- Every declared artifact has exactly one writer and at least one reference.
- Check steps have both `onPass` and `onFail` pointing at real steps.
- No step requests a context policy other than `fresh_per_run` in v0.1.

## Plan review (the TUI dialog)

When the model calls `relay` with a plan that can touch the filesystem or
run shell commands, pi's TUI fires a review dialog before the scheduler
runs. The user sees three options:

- **Run the plan** — execution proceeds as described.
- **Refine (tell the model what to change)** — opens a freeform editor.
  Whatever the user writes is returned to the model as the tool result
  with a clear instruction: *revise this plan, do not run the original*.
  The model produces a new `relay` call on its next turn incorporating the
  feedback. Iterate until the user accepts, refines again, or cancels.
- **Cancel** — execution is aborted and the model sees a cancelled result.

**Read-only plans skip the dialog entirely.** If no actor in the plan has
`edit`/`write`/`bash` in its tool list and no check step runs a shell
command, there's nothing destructive happening and the prompt is pure
friction. Q&A and exploration plans run unattended.

The dialog body is compact because the full plan is already rendered above
it in the chat via pi's normal tool call preview — title line surfaces only
the impact tags (`may edit files`, `runs shell`, `check: npm test`) and the
unknown-actor warning if any step references an actor that isn't installed.

**Important caveat:** the subprocess actors run with `pi -p --no-session`
which is non-interactive, so pi's built-in bash/edit/write confirmations
do NOT fire inside a relay run. Approving the review dialog authorizes
every step in the plan. There is no "approve each step" granularity in v0.1.

## Outcomes and the result view

Four things can happen when the model calls `relay`, each with its own
distinct result rendering:

- **Compile failure.** The plan references an unknown actor, an
  unresolvable route target, or a multi-writer artifact. Relay returns a
  structured compiler error naming the offending id and candidates, the
  model sees it and may resubmit a corrected plan in the same turn.
- **User cancelled.** Review dialog declined. Model sees a cancelled tool
  result and moves on.
- **User refined.** Review dialog returned a refinement request. Model
  sees the user's feedback and produces a revised plan.
- **Execution outcome.** The scheduler ran and reached a terminal:
  `success`, `failure`, `aborted`, or `incomplete` (no terminal reached).
  The collapsed view shows a 3-row summary with a glyph strip (one glyph
  per step), progress count, and timing/usage. Expanded view (Ctrl+O)
  shows per-step detail with actor transcripts, tool calls, and the
  actor's final reply rendered as Markdown.

Unreached branches of the DAG are marked `skipped` in the final render
with a dim `−` glyph, distinguished from steps that are still pending or
running.

## Architecture at a glance

```
pi-coding-agent (the assistant)
       │
       │  tool call: relay.submitPlan({ PlanDraftDoc })
       ▼
┌──────────────────────────────────────────────────┐
│ pi-relay extension                               │
│                                                  │
│   discover actors      (actors/discovery.ts)     │
│          │                                       │
│          ▼                                       │
│   compile plan         (plan/compile.ts)         │
│          │                                       │
│          ▼                                       │
│   scheduler.run()      (runtime/scheduler.ts)    │
│     ├─ action steps → subprocess actor engine    │
│     │                   (actors/engine.ts)       │
│     ├─ check steps  → deterministic verification │
│     │                   (runtime/checks.ts)      │
│     ├─ artifact store atomic commits             │
│     │                   (runtime/artifacts.ts)   │
│     └─ events → onUpdate → TUI renderer          │
│                           (render/*)             │
└──────────────────────────────────────────────────┘
       │
       ▼
tool result → pi-coding-agent transcript
```

## Writing a review/fix loop

A common pattern is review → fix → re-review until the reviewer accepts.
By default relay's compiler enforces **one writer per artifact** so plans
stay easy to reason about statically. For loops, opt an artifact into
multi-writer semantics by setting `multiWriter: true` on its contract:

```json
{
  "artifacts": [
    { "id": "notes",   "description": "implementation",
      "shape": { "kind": "untyped_json" }, "multiWriter": true },
    { "id": "verdict", "description": "review verdict",
      "shape": { "kind": "untyped_json" }, "multiWriter": true }
  ],
  "steps": [
    { "kind": "action", "id": "create", "actor": "worker",
      "instruction": "Create the initial implementation.",
      "reads": [], "writes": ["notes"],
      "routes": [{ "route": "done", "to": "review" }] },

    { "kind": "action", "id": "review", "actor": "reviewer",
      "instruction": "Review the implementation in notes.",
      "reads": ["notes"], "writes": ["verdict"],
      "routes": [
        { "route": "accepted",           "to": "done" },
        { "route": "changes_requested",  "to": "fix" }
      ] },

    { "kind": "action", "id": "fix", "actor": "worker",
      "instruction": "Apply the reviewer's feedback.",
      "reads": ["verdict", "notes"], "writes": ["notes"],
      "routes": [{ "route": "done", "to": "review" }] },

    { "kind": "terminal", "id": "done", "outcome": "success",
      "summary": "Review accepted." }
  ],
  "entryStep": "create"
}
```

Three things worth knowing:

- **Back-edges are how loops are expressed.** `fix` routes back to
  `review`, and the scheduler's ready queue re-enters `review` as many
  times as the routing demands. There's no loop keyword — it's just a
  cycle in the DAG.
- **Reads are latest-wins.** Every commit is atomic, but readers always
  see the most recently committed value. `review`'s second pass reads the
  fresh `notes` that `fix` just wrote.
- **`maxRuns`** (default 10, per action step) — any action step can run
    at most `maxRuns` times within one plan execution. The primary guard
    against actor ping-pong (`review ↔ fix` that never converges):
    whichever side spins first halts the run with `incomplete` and its
    id is named in the outcome summary. Set `maxRuns: 200` on action
    steps in long-running loops (e.g., experiment loops that run
    overnight).

The single-writer default stays for non-loop artifacts because it's what
makes plans reason about — you can statically verify the producer of any
value just by looking at the plan. Opting in to multi-writer is explicit
and visible in the plan, which is the right trade-off.

## Limitations (v0.1)

- **Sequential execution only.** Parallelism and `Join` steps land in v0.2.
- **`FreshPerRun` context policy only.** Per-step and per-actor caching
  land in v0.2.
- **Untyped JSON artifacts only.** Named TypeBox shapes land in v0.2.
- **Single writer per artifact by default.** Opt into multi-writer
  semantics with `multiWriter: true` on the artifact contract when you
  need review/fix loops (see "Writing a review/fix loop" above). The
  default stays single-writer because it makes plans easy to reason
  about statically — you can always tell who produced any value by
  reading the plan.
- **No step-level timeouts.** The scheduler's overall abort propagates from
  pi's signal, but individual steps cannot declare their own timeout yet.
- **No per-step approval inside a run.** Approving the review dialog
  authorizes every step in the plan. Subprocess actors run
  non-interactively and cannot prompt for per-call confirmation.
- **TUI rendering only.** The pi-mono web UI does not expose extension
  renderer hooks, so web users see a generic tool result.
- **Subprocess-per-action execution.** Each action step spawns a fresh pi
  subprocess. This is the only way the actor's inner tool calls can reach
  pi's registered tools. Expect ~200–500ms startup overhead per step.
- **No web tools in actors by default.** pi's built-in tool set is
  `read, bash, edit, write, grep, find, ls`. Actors that need web access
  use `bash + curl` until a web extension exists.

## Development

```bash
npm run check    # tsc --noEmit + biome check
npm run test     # vitest --run
npm run format   # biome format --write
```

## License

MIT
