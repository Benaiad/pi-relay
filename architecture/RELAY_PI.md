# Relay for pi — Design

## What this is

Relay is a graph-based execution engine for multi-step coding workflows.
This package ports its core ideas to the pi coding agent as a native extension.

The pi assistant decides whether a task is simple enough for direct tool calls
or complex enough to delegate to Relay. When it delegates, it produces a
structured plan as the arguments of a single tool call (`relay`). Relay
compiles the plan into a validated executable program, runs it as a DAG of
typed steps, and returns a structured run report.

The plan is reviewable before execution. The runtime is deterministic —
the same compiled program with the same actor inputs takes the same path.
Verification gates (running tests, schema-checking outputs, file existence)
are first-class steps the runtime evaluates, not narrative interpretation
the model performs.

## Why pi needs this

The pi extensions that already exist reveal where pi's base experience falls
short on complex workflows: subagent (context isolation), plan-mode (review
before execution), todo (progress tracking), confirm-destructive and
permission-gate (per-tool safety), git-checkpoint (rollback), custom-compaction
(context bloat). Each is a workaround for a specific shape of multi-step pain.

Relay addresses three pains that no current extension cleanly solves:

1. **Deterministic verification gates.** The model runs tests, reads natural
   language output, decides "tests pass-ish." Relay's check steps run a command,
   evaluate its exit code, route to `pass` or `fail`. The runtime decides, not
   the model.
2. **Typed artifacts between steps.** Today, multi-step workflows pass strings
   through transcripts — each step paraphrases what the previous one said. Relay's
   artifacts have schemas, single-writer ownership by default, and compile-time
   producer/consumer enforcement. The plan does not run if a step reads an
   artifact no step writes.
3. **Audit and replay.** Pi sessions log transcripts. Relay records a structured
   audit log keyed by step, route, artifact, and retry attempt. A run can be
   replayed or inspected after the fact without parsing free text.

This is a specialist tool. Most pi sessions will not invoke it. The model
should call `relay` only for tasks with at least one of: multiple actors,
verification gates, parallel work that needs joining, or workflows where
partial success is unacceptable.

## User experience, end to end

A user types a request. The pi coding agent processes it as usual. Three
outcomes are possible:

1. **Direct reply.** No tool call. The model answers in text.
2. **Direct tool call.** Single bash, edit, read, etc. Same as today.
3. **Relay delegation.** The model calls the `relay` tool with a structured
   plan as the arguments.

When the model calls `relay`, pi shows the plan inline in the chat, the same
way it shows any tool call. Because the plan IS the tool's parameter schema,
pi's existing tool-call rendering works: the user sees the plan summary
(task, actors involved, step count, terminal outcomes) before execution starts.
If the plan looks wrong, the user can abort the tool with the same shortcut
they use for any other tool. No custom dialog framework, no separate plan
review widget.

If the user does not abort, the runtime executes the plan. Each step's
state updates live in the chat using pi's `tool_execution_update` channel:
the plan summary morphs into a DAG status strip showing per-step icons
(pending, ready, running, succeeded, failed, retrying). Cost and turn counts
aggregate as steps complete. When the run finishes, the strip becomes a
collapsed summary with `Ctrl+O` to expand into per-step details: the actor
that ran, the tool calls it made, the artifacts it committed, the route it
took, its usage. The expanded view is what subagent's parallel mode looks
like, generalized to a DAG.

The final run report is returned to the model as the tool result, in the
same shape every other pi tool returns. The model continues the conversation
with the result in context.

If the run fails — a check fails after exhausting its retries, an actor
errors, or the user aborts mid-run — Relay returns a partial report with
`isError: true`. The transcript shows the model what failed and why, and
the model decides how to respond.

## Module boundaries

Each module owns one responsibility. Boundaries are enforced by file
structure and the public exports of each module's index file.

### `plan/` — the data model

Owns: the shape of a plan as the user (and the model) writes it, and the
shape of a compiled program the runtime executes. Branded ID types
(`StepId`, `ActorId`, `ArtifactId`, `RouteId`, `PlanId`, `RunId`) live here
and are the only way to construct identifiers.

`plan/draft.ts` exposes `PlanDraftSchema`, the TypeBox schema that becomes
the `relay` tool's parameter schema. The model produces plans by filling
this schema in. The schema's field descriptions are the prompt: every
field tells the model what it means and when to use it.

`plan/compile.ts` is a pure function `compile(draft, actors): Result<Program, CompileError>`.
It validates that every referenced actor exists, every step ID is unique,
every route lands on a real step, every artifact has at most one writer,
the entry step exists, the graph is reachable from the entry, and joins
have at least one input. On failure it returns a structured `CompileError`
that names the offending step and the candidates it could have meant. The
compiler is the gate that says "invalid plans do not run."

`plan/program.ts` is the compiled output: an immutable `Program` with
resolved edges, indexed steps, and locked artifact contracts. The runtime
only ever sees `Program`, never `PlanDraft`. This is enforced by the type
system — `Program` has no public constructor, only `compile()` produces one.

### `runtime/` — execution

Owns: scheduling, artifact storage, deterministic checks, event streaming.

`runtime/scheduler.ts` is a ready-queue executor. It seeds the entry step,
tracks ready/running/done/failed/retry state, runs ready Action and Check
steps up to a concurrency cap, follows emitted routes, and stops when the
queue is empty or a Terminal step is reached. The scheduler is parameterized
by an actor engine and a check engine, so tests can substitute fakes for
both. Time is injected via a `clock: () => number` parameter; randomness is
injected via `random: () => number`. The scheduler itself is pure with
respect to wall-clock time and never reaches for `Date.now()` directly.

`runtime/artifacts.ts` owns the typed artifact store. Reads return a
snapshot keyed by the actor and the step's declared inputs. Writes are
batched per step and committed atomically only when the step succeeds. An
in-flight write is invisible to other workers until commit. The store
validates writes against the artifact's compiled shape before committing;
a shape mismatch is a runtime contract violation and fails the step.

`runtime/checks.ts` is the deterministic check engine. It handles three
check kinds: `file_exists` (a path test), `command_exits_zero` (run a
shell command, evaluate exit code), and `json_matches` (validate a JSON
artifact against a TypeBox schema). Checks return `pass` or `fail`; the
scheduler routes accordingly. Checks never call an LLM and never write
artifacts.

`runtime/events.ts` defines `RelayEvent`, a discriminated union of every
state change the scheduler emits, and `RelayRunState`, the snapshot the
renderer reads. `applyEvent(state, event)` is the only function that
mutates run state, which makes the event log the single source of truth.

### `actors/` — agent execution

Owns: actor discovery from disk and the bridge between Relay's scheduler
and pi's LLM client.

`actors/discovery.ts` reads markdown files with YAML frontmatter from
`~/.pi/agent/relay-actors/` (user scope) and `<cwd>/.pi/relay-actors/`
(project scope), the same convention subagent uses for its agents. An
actor file declares: name, description, allowed tool list, model,
context policy. The body is the actor's system prompt.

`actors/engine.ts` exposes one function: `runAction(actor, step, inputs, signal): Promise<ActionOutcome>`.
The engine builds a system prompt from the actor preamble, the step
instruction, the visible artifact inputs, and the schema of the
`complete_step` tool. It calls `streamSimple` from `@mariozechner/pi-ai`
with the actor's tool list plus `complete_step`. The actor must call
`complete_step` exactly once with the route it picked and the artifacts
it produced. The engine returns the outcome as a typed `ActionOutcome`
discriminated union.

The MVP only implements `ContextPolicy::FreshPerRun`. The other two
policies (per-step and per-actor caching) require holding a `pi-agent-core`
`Agent` instance across calls, which is post-MVP work.

### `render/` — TUI presentation

Owns: how the plan and run state look in the pi UI.

`render/plan-preview.ts` is the `renderCall` implementation. It receives
the raw `PlanDraft` from the tool call before execution begins, and renders
a compact summary: task, actor count, step count, terminal outcome
descriptions, and the first few steps. Expanded view shows the full DAG.
This is what the user reviews before deciding whether to let the run proceed.

`render/run-result.ts` is the `renderResult` implementation. It branches on
the run phase (running, done, failed, aborted) and renders the appropriate
view. While running, it shows a live status strip with one icon per step.
On completion, it shows aggregate cost, the route the run took, and per-step
details on expand.

`render/format.ts` holds the shared formatters for paths, tokens, durations,
truncation. These match the conventions in subagent and bash so Relay's
output looks visually identical to pi's built-in tools.

`render/icons.ts` defines the status icon palette and the theme keys to use
for each. There is one place in the codebase where colors and glyphs for run
state are decided.

### `index.ts` — extension entry

A single default export factory function that takes the `ExtensionAPI` and
calls `pi.registerTool(...)`. It is intentionally thin: its job is wiring,
not logic. All real work lives in the modules above.

## Data flow

A request enters pi's coding agent. The model decides to invoke `relay`
and emits a tool call whose arguments are a `PlanDraft`. Pi validates the
arguments against the TypeBox schema and calls `execute(toolCallId, plan, signal, onUpdate, ctx)`.

Inside `execute`:

1. Discover actors from disk (user scope by default, project scope on
   request, with a confirmation prompt for project-local actors on first
   use per session).
2. Compile the plan. On failure, return a structured error result; the
   model sees the compile error and may revise.
3. Build a `RelayRunState` and a `RelayDetails` object. The latter is what
   `onUpdate` carries to the renderer.
4. Construct a `Scheduler` with the compiled program, a `FreshPerRun` actor
   engine, the deterministic check engine, the artifact store, and the
   user's abort signal.
5. Subscribe to the scheduler's event stream. For each event, apply it to
   the run state and call `onUpdate({ content, details })`. Content is a
   short text summary of the current phase; details is the full
   `RelayDetails` object the renderer consumes.
6. Run the scheduler to completion or failure.
7. Build the final `RunReport` from the audit log, the artifact store
   snapshot, and the terminal step's outcome (if any).
8. Return `{ content: [final summary], details: full state, isError: true if failed }`.

The renderer never sees the scheduler directly. It consumes `RelayDetails`
snapshots delivered through `onUpdate` and the final result. The scheduler
never sees the renderer. The two are connected only through the event stream.

## Types as domain concepts

These are the names the codebase uses. A reader who understands the domain
should recognize them without reading the implementation.

- **`PlanDraft`** — what the model produces. Reviewable, not yet validated.
- **`Program`** — what the compiler produces. Validated, executable, immutable.
- **`Actor`** — a named role with a system prompt, tool list, and model. Discovered from markdown files.
- **`Step`** — one node in the DAG. A discriminated union: `Action`, `Check`, `Join`, or `Terminal`.
- **`Route`** — a named outgoing edge from a step. Routes are declared on the step and resolved at compile time.
- **`Artifact`** — a named typed value passed between steps. Has exactly one producer and zero or more consumers.
- **`ArtifactContract`** — the compile-time declaration of an artifact's shape, producer, and consumers.
- **`RetryPolicy`** — how many times a failed Action retries before its `failure` route fires.
- **`ContextPolicy`** — how an actor's conversation persists across step invocations. `FreshPerRun` (MVP), `PersistPerStep`, `PersistPerActor` (post-MVP).
- **`RelayEvent`** — every state change the scheduler emits: step-ready, step-started, action-tool-called, artifact-committed, route-taken, retry-scheduled, run-finished.
- **`RelayRunState`** — the snapshot the renderer reads; mutated only by `applyEvent`.
- **`RunReport`** — the final structured outcome of a run. Returned to the model as the tool result.

## Error paths as scenarios

- **Compile fails.** The model gave us a plan that references an actor
  that does not exist. We return `{ isError: true, content: [{ text: "compile failed: step `implement` references actor `coder`; available: scout, planner, worker" }], details: { phase: "compile_failed", error: ... } }`. The model sees the structured message in the next turn and may resubmit a corrected plan.
- **Actor exceeds retries.** A step's `Action` failed three times in a row.
  The scheduler stops retrying, follows the step's `failure` route if it
  has one, or emits a terminal failure if there is no fallback. The
  audit log records each attempt. The run report names the step.
- **Check fails.** A `command_exits_zero` check returned non-zero. The
  scheduler routes to the check's `fail` edge. The next step is whatever
  the plan declared for `fail` — typically a debug actor or a terminal
  failure.
- **User aborts.** The signal fires. The scheduler stops scheduling new
  steps, cancels in-flight actor LLM calls via their own `AbortController`
  derived from the user's signal, and waits up to 5s for them to stop. If
  any actor has not stopped, the scheduler force-rejects the promise.
  The run report's outcome is `aborted`.
- **Artifact contract violation.** An actor wrote an artifact whose JSON
  shape does not match the compiled contract. The store rejects the commit,
  the step is marked failed, retries apply.
- **Multiple writers compile-time.** Two different steps declare they write
  the same artifact. Compile rejects before any execution. Error message
  names both steps.
- **No path to terminal.** A step's emitted route lands on a step that has
  no outgoing routes. Scheduler emits `RunFinished` with `outcome: incomplete`.
  This is a model bug — the plan was compilable but did not specify what
  to do next. The compiler does NOT reject this in MVP because reachability
  analysis is expensive; the runtime catches it instead.

## Contracts as promises

These are the invariants the rest of the system relies on. Breaking any of
them is a bug.

- **Compile is total.** `compile(draft, actors)` either returns a valid
  `Program` or a typed `CompileError`. It never throws. It never mutates
  its inputs.
- **`Program` is immutable.** Once compiled, no field changes. The
  scheduler does not patch routes mid-run.
- **Steps only see what they declared.** An actor's input snapshot
  contains exactly the artifacts the step's `reads` field listed. Nothing
  else.
- **Writes commit atomically.** A failed step never leaves any of its
  writes visible to other steps. Either all writes commit or none do.
- **Same step never runs concurrently with itself.** If a step is
  ready twice (e.g., re-entered after a failure-route loop), the second
  activation waits for the first to finish.
- **The audit log is the truth.** The renderer's `RelayRunState` is
  derived from audit events via `applyEvent`. There is no other path to
  mutate run state. A test that replays the audit log produces an
  identical state.
- **The `relay` tool is idempotent in failure modes.** A compile failure
  returns a structured error result; it never throws to pi. A runtime
  failure does the same. Pi's tool call never sees an unhandled exception.

## What is in the MVP

- `PlanDraft` schema with `Action`, `Check`, and `Terminal` step kinds. No
  `Join` in MVP — joins require parallelism, which is post-MVP.
- Sequential scheduler with retries and abort propagation. Concurrency cap
  is wired but the cap is effectively 1 until `Join` lands.
- `FreshPerRun` actor engine via `streamSimple`.
- Three check kinds: `file_exists`, `command_exits_zero`, `json_matches`.
- `untyped_json` artifact shape only. Named shapes with TypeBox schemas
  come in v0.2.
- TUI renderer with collapsed and expanded views matching subagent's
  visual vocabulary. No web-ui renderer (pi-mono limitation).
- Actor discovery from `~/.pi/agent/relay-actors/*.md` and
  `<cwd>/.pi/relay-actors/*.md` with `user`, `project`, `both` scopes.
- A single sample actor file shipped with the repo (`actors/worker.md`)
  so the install flow has something to point at.

## What is explicitly NOT in the MVP

- Parallel execution and `Join` steps. Post-MVP because correctness of
  the join semantics requires careful test coverage that's better handled
  in its own phase.
- `PersistPerStep` and `PersistPerActor` context policies. Require holding
  a `pi-agent-core` `Agent` across step calls, which is a different
  integration shape than `streamSimple`.
- Named artifact shapes with TypeBox schemas. Untyped JSON works for v0.1
  and is what the existing Relay tests in the Rust codebase mostly use.
- Step timeouts. The Rust Relay has the same gap. Will land alongside join
  semantics.
- Durable artifact storage. Everything is in-memory per run.
- Web-ui rendering. Blocked on pi-mono not exposing renderer hooks to
  extensions on the web side.
- Plan review confirmation dialog. The MVP relies on pi's existing
  `tool_call` interception model: if a user wants to gate Relay plans, they
  add `confirm-destructive` or write a tiny extension that hooks `tool_call`
  for the `relay` tool. We do not invent a new dialog framework.

## What success looks like for v0.1

A user installs the extension, drops one or two `.md` actor files into
`~/.pi/agent/relay-actors/`, and runs pi. The model, prompted with a
multi-step task that has a verification gate, calls `relay.submitPlan`.
Pi renders the plan inline. The runtime executes the steps. Each step's
status updates live. The verification check runs deterministically and
routes correctly. The final report comes back to the model as a structured
tool result. The user can scroll back, hit Ctrl+O, and inspect every step.

If that works end to end, the architecture has earned its weight and v0.2
can land joins, persistent context policies, and named artifact shapes
without redesign.
