# pi-relay

Graph-based planning and execution for the [pi coding agent](https://github.com/badlogic/pi-mono).

The pi assistant decides whether a task is simple enough for direct tool
calls or complex enough to delegate to Relay. When it delegates, it produces
a structured plan as the arguments of a single `relay` tool call. Relay
compiles the plan into a validated executable program, runs it as a DAG of
typed action, check, and terminal steps, and returns a structured run report.

> Status: v0.1 in development. See [`architecture/RELAY_PI.md`](architecture/RELAY_PI.md)
> for the design and [`architecture/RELAY_PI_IMPL.md`](architecture/RELAY_PI_IMPL.md)
> for the implementation plan.

## Why

Pi handles single-step and short multi-step tasks well. It struggles with
workflows that need:

- **Deterministic verification gates.** Tests must pass before commit, and
  the runtime — not the model's interpretation of test output — decides.
- **Typed artifacts between steps.** A planner's output reaches the
  implementer in a known shape, not a paraphrased transcript.
- **Replay and audit.** A run is a structured event log keyed by step,
  route, artifact, and retry attempt.

Relay is a specialist tool. Most pi sessions will not invoke it. The model
should call `relay` only for tasks with at least one of: multiple actors,
verification gates, parallel work that needs joining, or workflows where
partial success is unacceptable.

## Install (development)

```bash
git clone https://github.com/badlogic/pi-relay.git ~/repos/pi-relay
cd ~/repos/pi-relay
npm install

# Symlink the whole src/ directory as the extension. jiti follows the symlink
# and resolves relative imports against the real src/ tree, so this single
# symlink is enough — do NOT also symlink individual files inside it.
ln -sfn "$(pwd)/src" ~/.pi/agent/extensions/relay

# Drop the sample actor files into pi's actor directory
mkdir -p ~/.pi/agent/relay-actors
for actor in actors/*.md; do
  ln -sf "$(pwd)/$actor" ~/.pi/agent/relay-actors/$(basename "$actor")
done
```

Launch pi as usual. The model will see a `relay` tool in its tool list.
Ask pi for something that needs planning + implementation + verification
(for example: "plan the migration to adjust the auth flow, implement it,
and make sure the test suite still passes") and the model should call
`relay` with a structured plan.

## Writing an actor

Actors are markdown files with YAML frontmatter, dropped into
`~/.pi/agent/relay-actors/` (user scope) or `<project>/.pi/relay-actors/`
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
- `description` (required) — surfaced in the `/relay` command list and errors
- `tools` (optional, comma-separated) — restricts the actor to a subset of
  pi's registered tools. Omit to use pi's default tool list.
- `model` (optional) — overrides pi's active model for this actor
- body — the actor's system prompt

Discovery is fresh on every invocation, so editing an actor file takes
effect on the next `relay` call without restarting pi.

## Writing a plan (JSON shape)

The model produces plans as the arguments of the `relay` tool call. A minimal
hand-written plan looks like this:

```json
{
  "task": "Plan, implement, and verify a new feature flag.",
  "successCriteria": "Tests pass and the flag is wired to the canonical registry.",
  "artifacts": [
    { "id": "requirements", "description": "Parsed requirements", "shape": { "kind": "untyped_json" } },
    { "id": "notes", "description": "Implementer notes", "shape": { "kind": "untyped_json" } }
  ],
  "steps": [
    {
      "kind": "action",
      "id": "plan",
      "actor": "planner",
      "instruction": "Identify the files that need to change and record them in requirements.",
      "reads": [],
      "writes": ["requirements"],
      "routes": [{ "route": "next", "to": "implement" }]
    },
    {
      "kind": "action",
      "id": "implement",
      "actor": "worker",
      "instruction": "Apply the changes described in requirements.",
      "reads": ["requirements"],
      "writes": ["notes"],
      "routes": [{ "route": "done", "to": "verify" }],
      "retry": { "maxAttempts": 2 }
    },
    {
      "kind": "check",
      "id": "verify",
      "check": { "kind": "command_exits_zero", "command": "npm", "args": ["test"], "timeoutMs": 120000 },
      "onPass": "done",
      "onFail": "failed"
    },
    { "kind": "terminal", "id": "done", "outcome": "success", "summary": "Feature flag shipped and tests are green." },
    { "kind": "terminal", "id": "failed", "outcome": "failure", "summary": "Tests failed after implementation." }
  ],
  "entryStep": "plan"
}
```

Rules enforced by the compiler (every violation returns a structured error
to the model, which may resubmit a corrected plan in the same turn):

- Every step id is unique.
- The entry step exists.
- Every actor reference resolves against a discovered actor.
- Every route's `to` target is a real step.
- Every declared artifact has exactly one writer and at least one reference.
- Check steps have both `onPass` and `onFail` pointing at real steps.
- No step requests a context policy other than `fresh_per_run` in v0.1.

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
Relay's compiler enforces **one writer per artifact**, so if the reviewer
writes an artifact on the first pass and again after the fix, you cannot
reuse the same artifact id — the compiler rejects the plan with
`multiple_artifact_writers`.

The v0.1 workaround is to duplicate the artifact across iterations:

```
review         writes: [review_verdict]
  route changes_requested → fix
fix            reads: [review_verdict]  writes: [implementation_notes]
  route done → re_review
re_review      writes: [re_review_verdict]    ← new id
  route accepted → done
```

Each iteration gets its own artifact id and its own writer step. The
review-loop tests caught this correctly during the early dogfood runs.
v0.2 will add plan-level loop annotations so the model can express
"retry this review sub-DAG until accepted" without duplicating step ids.

## Limitations (v0.1)

- **Sequential execution only.** Parallelism and `Join` steps land in v0.2.
- **`FreshPerRun` context policy only.** Per-step and per-actor caching
  land in v0.2.
- **Untyped JSON artifacts only.** Named TypeBox shapes land in v0.2.
- **No step-level timeouts.** The scheduler's overall abort propagates from
  pi's signal, but individual steps cannot declare their own timeout yet.
- **TUI rendering only.** The pi-mono web UI does not expose extension
  renderer hooks, so web users see a generic tool result.
- **Subprocess-per-action execution.** Each action step spawns a fresh pi
  subprocess. This is the only way the actor's inner tool calls can reach
  pi's registered tools. Expect ~200–500ms startup overhead per step.

## Development

```bash
npm run check    # tsc --noEmit + biome check
npm run test     # vitest --run
npm run format   # biome format --write
```

## License

MIT
