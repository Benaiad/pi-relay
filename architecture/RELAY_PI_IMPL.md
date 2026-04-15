# Relay for pi — Implementation plan

This document sequences the v0.1 build. Each phase produces a compiling,
testable increment. The goal is to bring the project from empty to a
loadable pi extension that compiles a plan, runs it as a sequential DAG,
and renders live status, without taking any half-finished step along the way.

The order is data-up: build the things runtime depends on first, then the
runtime, then the rendering layer, then the extension entry that wires it all.

## Phase 0 — Repository scaffold + design docs

**Output:** A repo that compiles cleanly with no source files yet.

- `git init`, main branch.
- `package.json` with the `pi` manifest field, peer deps on
  `@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`,
  `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, `@sinclair/typebox`.
  Dev deps on the same plus typescript, vitest, biome, @types/node.
- `tsconfig.json` matching pi-mono's base (ES2022, Node16, strict, plus
  `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
  for extra discipline).
- `biome.json` matching pi-mono's formatter (tab indent width 3, line width 120).
- `vitest.config.ts` for a node test environment.
- `.gitignore` for node_modules, dist, vitest cache.
- `architecture/RELAY_PI.md` — design doc.
- `architecture/RELAY_PI_IMPL.md` — this document.
- `README.md` skeleton (full version lands in phase 8).

**Verification:** `tsc --noEmit` runs against an empty `src/` and prints
nothing. `git log` shows one commit.

**Commit:** `chore: scaffold repo + architecture docs`

## Phase 1 — Plan IR types and TypeBox schema

**Output:** The data model the rest of the system speaks. Pure types and
schema — no logic.

Files:

- `src/plan/ids.ts` — branded ID types and constructors. `PlanId`, `RunId`,
  `StepId`, `ActorId`, `ArtifactId`, `RouteId`. Each is a `Brand<string, K>`.
  Constructors take a `string` and return the branded type. Reading the
  string out goes through a single `unwrap` helper. There is no other way
  to construct an ID.
- `src/plan/types.ts` — TypeScript types for the plan IR. Discriminated
  union `Step = ActionStep | CheckStep | TerminalStep`. Supporting types:
  `Route`, `ArtifactContract`, `RetryPolicy`, `ContextPolicy`, `CheckSpec`.
  Every type uses branded IDs, never bare `string`.
- `src/plan/draft.ts` — TypeBox schema mirroring `types.ts`. This is what
  becomes the `relay` tool's parameter schema. Every field has a `description`
  written for the model's benefit. Schema and TS types are not derived from
  each other automatically — they are kept in sync by hand and verified by
  a `Static<typeof PlanDraftSchema> extends PlanDraftDoc ? true : false`
  type-level test.
- `src/plan/result.ts` — A small `Result<T, E>` discriminated union helper
  used everywhere in place of throws or `Either`. Three functions: `ok`,
  `err`, `isOk`.
- `test/plan/ids.test.ts` — confirms branded constructors prevent
  cross-assignment at the type level (compile-time check via `// @ts-expect-error`).
- `test/plan/draft.test.ts` — constructs a small plan, validates it
  against the TypeBox schema using `Value.Check`, asserts pass.

**Verification:** `tsc --noEmit` passes. `vitest --run` passes.

**Commit:** `feat(plan): IR types, branded IDs, TypeBox schema`

## Phase 2 — Compiler

**Output:** `compile(draft, actors): Result<Program, CompileError>`.

Files:

- `src/plan/program.ts` — `Program` type. Immutable. Holds an indexed step
  map keyed by `StepId`, an edge index keyed by `(StepId, RouteId)`, an
  artifact contract index, and the resolved entry step. The shape of
  `Program` is intentionally different from `PlanDraft`: `PlanDraft` is
  flat arrays for the model to fill in; `Program` is indexed maps for the
  runtime to look up. The conversion is the compiler's job.
- `src/plan/compile.ts` — the validator/compiler. Validation rules:
  - All step IDs are unique
  - Entry step exists in the step set
  - Every actor reference resolves
  - Every route's `to` resolves to a real step
  - Every step that declares `reads` references an artifact that some
    other step writes
  - At most one writer per artifact
  - Every check step has both `pass` and `fail` routes
  - Every action step has at least one route OR is followed only by a
    terminal (this is checked structurally; not a reachability analysis)
- `src/plan/compile-errors.ts` — discriminated union `CompileError`.
  Variants: `MissingActor`, `DuplicateStep`, `MissingEntry`, `MissingRouteTarget`,
  `MultipleArtifactWriters`, `MissingArtifactProducer`, `CheckMissingRoute`,
  `EmptyPlan`. Each variant carries the offending IDs and the available
  candidates so error messages can be helpful.
- `src/plan/compile-error-format.ts` — `formatCompileError(error): string`.
  One function, one place to control how compile errors look in the tool
  result text.
- `test/plan/compile.test.ts` — table-driven tests, one per error variant
  plus several happy-path plans (linear chain, branching check, retry
  configuration). Each row is `{ name, draft, expected: Ok | Err(variant) }`.

**Verification:** `tsc --noEmit` passes. All compile tests pass.

**Commit:** `feat(plan): compiler with structural validation and typed errors`

## Phase 3 — Artifact store and check engine

**Output:** Two modules the scheduler uses to manage state and verification.

Files:

- `src/runtime/artifacts.ts` — `ArtifactStore` class. In-memory `Map<ArtifactId, StoredArtifact>`.
  Public methods: `read(reads: ArtifactId[]): ArtifactSnapshot`, `commit(stepId, writes): Result<void, ContractViolation>`.
  Internal: `validateShape(value, contract)`. The store enforces single-writer
  by tracking `writerStep` per artifact and rejecting commits from other
  steps. Reads return a frozen object so consumers can't accidentally
  mutate it.
- `src/runtime/checks.ts` — `runCheck(spec: CheckSpec, artifacts: ArtifactSnapshot, ctx): Promise<CheckOutcome>`.
  Three `CheckSpec` variants: `FileExists`, `CommandExitsZero`, `JsonMatches`.
  `CheckOutcome` is `{ kind: "pass" } | { kind: "fail"; reason: string }`.
  `CommandExitsZero` shells out via `node:child_process`'s `spawn` (NOT
  `exec`) with a hard timeout, captured stdout/stderr in the failure reason.
- `test/runtime/artifacts.test.ts` — covers: write+read roundtrip, second
  writer rejection, read of unwritten artifact returns empty snapshot, frozen
  snapshot prevents mutation.
- `test/runtime/checks.test.ts` — covers each check kind with both pass
  and fail cases. Uses temp files for `FileExists` and a trivial command
  for `CommandExitsZero`.

**Verification:** `tsc --noEmit` passes. All artifact and check tests pass.

**Commit:** `feat(runtime): artifact store and deterministic check engine`

## Phase 4 — Actor discovery and execution engine

**Output:** Bridge between the scheduler and pi's LLM client.

Files:

- `src/actors/types.ts` — `Actor` (the discovered config) and `ActorRef`
  (just an `ActorId`). Plus `ActionRequest` (what the engine receives from
  the scheduler) and `ActionOutcome` (what the engine returns).
- `src/actors/discovery.ts` — `discoverActors(cwd, scope): ActorDiscovery`
  matching subagent's `agents.ts` shape. Reads `~/.pi/agent/relay-actors/*.md`
  and `<cwd>/.pi/relay-actors/*.md`. Frontmatter fields: `name`,
  `description` (required), `tools`, `model`, `contextPolicy` (optional).
  Body is the system prompt. Discovery is fresh on every invocation.
  Uses `parseFrontmatter` from `@mariozechner/pi-coding-agent`.
- `src/actors/engine.ts` — `runAction(req: ActionRequest, ctx): Promise<ActionOutcome>`.
  Builds the system prompt from actor preamble + step instruction +
  visible artifacts + route catalog. Builds a tool list: the actor's
  declared tools (looked up from pi's tool registry via `ctx.getAllTools`)
  plus a synthetic `complete_step` tool whose schema is generated from
  the step's allowed routes and writable artifacts. Calls `streamSimple`
  with the constructed context. When the model emits `complete_step`,
  parses the route choice and writes from the tool arguments and returns
  `{ kind: "completed", route, writes }`. If the model finishes without
  calling `complete_step`, returns `{ kind: "no_completion" }`. If the
  stream errors, returns `{ kind: "engine_error", message }`.

  MVP only handles `ContextPolicy::FreshPerRun`: every call constructs a
  fresh `Context` with no prior messages. Other policies throw a clear
  `not implemented in v0.1` error in the engine when encountered.

- `src/actors/complete-step-schema.ts` — given a step's routes and writable
  artifacts, produces a TypeBox schema for the `complete_step` tool. The
  schema enforces that exactly one route is picked and all required
  artifact shapes are filled.
- `test/actors/discovery.test.ts` — discovers a temp directory of fake
  actor markdown files, asserts parsed fields and scope merging.
- `test/actors/complete-step-schema.test.ts` — given a step config,
  builds the schema, validates a sample completion against it.

  Note: `engine.ts` itself is not unit-tested in MVP because it requires
  a real LLM. The scheduler tests use a fake actor engine.

**Verification:** `tsc --noEmit` passes. Discovery and schema tests pass.

**Commit:** `feat(actors): discovery and execution engine wired to streamSimple`

## Phase 5 — Runtime scheduler and event stream

**Output:** The DAG executor. The largest single phase.

Files:

- `src/runtime/events.ts` — `RelayEvent` discriminated union covering every
  state change. `RelayRunState` snapshot type. `applyEvent(state, event): RelayRunState`
  pure reducer.
- `src/runtime/run-state.ts` — helpers that build `RelayRunState` from a
  `Program` and progress it via events. Used by the scheduler internally
  and by the renderer to derive view state.
- `src/runtime/scheduler.ts` — the executor. Public surface:
  `class Scheduler` constructed with `{ program, actorEngine, checkEngine, artifactStore, signal, clock, random, maxConcurrency }`.
  One method: `run(): Promise<RunReport>`. The scheduler owns:
  - A ready queue
  - A set of running activations
  - A retry counter per step
  - The audit log (append-only)
  - An `EventEmitter`-ish observer pattern via `subscribe(handler)` so
    the extension's `execute` can pipe events to `onUpdate`
  
  The MVP scheduler is sequential: it picks one ready step, runs it,
  applies the result, picks the next. The concurrency cap is wired but
  unused. Parallel execution and joins land in v0.2.

  Action steps go through the actor engine. Check steps go through the
  check engine. Terminal steps emit `RunFinished` and stop the loop.
  Failed actions retry up to their `RetryPolicy.maxAttempts`; exhausted
  retries follow the step's `failure` route if declared, otherwise emit
  a terminal failure.

  Abort: the scheduler subscribes to the user's `signal` and stops
  scheduling new steps on abort. In-flight actor calls receive a child
  `AbortController` that fires when the parent fires. The scheduler waits
  up to 5 seconds for them to settle, then resolves the run as
  `outcome: "aborted"`.

- `src/runtime/audit.ts` — `AuditLog` class. Append-only `RelayEvent[]`.
  `entries(): readonly RelayEvent[]`. The single source of truth for run
  history. `RelayRunState` is recomputed from the audit log via
  `replay(events): RelayRunState` for tests.
- `src/runtime/run-report.ts` — `buildRunReport(program, audit, finalState): RunReport`.
  Pure function. Run report is what the model sees as the tool result text.
- `test/runtime/scheduler-sequential.test.ts` — covers: linear plan happy path,
  check pass+fail routing, action retries, retry exhaustion, terminal success,
  terminal failure, abort mid-run. All tests use a fake actor engine that
  returns canned outcomes so they're hermetic.
- `test/runtime/audit-replay.test.ts` — runs a scheduler, captures the
  audit log, replays it through `applyEvent`, asserts the resulting state
  equals the scheduler's final state.

**Verification:** `tsc --noEmit` passes. All scheduler tests pass.

**Commit:** `feat(runtime): sequential scheduler with retries, abort, audit`

## Phase 6 — Render layer

**Output:** TUI rendering for the plan preview and run result.

Files:

- `src/render/icons.ts` — status icon palette. Maps `StepStatus` to
  `{ glyph, themeKey }`. `pending → ▸ muted`, `ready → ▸ accent`,
  `running → ⏳ warning`, `succeeded → ✓ success`, `failed → ✗ error`,
  `retrying → ↻ warning`, `skipped → ∅ dim`.
- `src/render/format.ts` — `shortenPath`, `formatTokens`, `formatCost`,
  `formatDuration`, `truncate`. Lifted from subagent's helpers (with credit
  in a comment) so the visual output is consistent with built-in tools.
- `src/render/usage.ts` — `aggregateUsage(state): UsageStats` and
  `formatUsageStats(usage, model?): string`. Same shape as subagent's.
- `src/render/plan-preview.ts` — `renderPlanPreview(plan, theme, expanded): Component`.
  Collapsed: `relay <task summary> (<step count> steps, <actor count> actors)`
  plus a step-icon strip showing every step's kind in order.
  Expanded: per-step list with `id → kind [actor]` and route summaries.
- `src/render/run-result.ts` — `renderRunResult(state, theme, expanded): Component`.
  Branches on phase (`compiling`, `running`, `done`, `failed`, `aborted`).
  Running: status banner + step-icon strip + currently-running step name.
  Done: aggregate usage + step-icon strip + (Ctrl+O hint).
  Expanded done: full per-step breakdown matching subagent's parallel/chain
  expanded views — header per step with actor, route taken, artifact
  commits, and per-step usage.

  All rendering uses `Container`/`Text`/`Spacer`/`Markdown` from
  `@mariozechner/pi-tui`. All colors go through `theme.fg(semanticKey, text)`.

- `test/render/format.test.ts` — covers the formatters. The component
  builders themselves are not unit tested — they're verified by visual
  inspection during the smoke test in phase 7.

**Verification:** `tsc --noEmit` passes. Format tests pass.

**Commit:** `feat(render): plan preview and run result components`

## Phase 7 — Extension entry wiring

**Output:** A loadable pi extension.

Files:

- `src/index.ts` — default export factory. Calls `pi.registerTool({ name: "relay", ... })`.
  The `execute` function is the choreographer described in the design doc:
  discover actors, compile plan, build run state, construct scheduler,
  subscribe to events and pipe to `onUpdate`, run, build report, return result.
  `renderCall` delegates to `renderPlanPreview`. `renderResult` delegates
  to `renderRunResult`. Total file size target: under 200 lines.
- `actors/worker.md` — sample actor file shipped with the repo. A general-purpose
  worker with read/edit/write/bash tools, used by the smoke test.
- `test/index.smoke.test.ts` — smoke test that imports the default export,
  calls it with a stub `ExtensionAPI`, and asserts the tool was registered
  with a parameter schema, a renderCall function, and a renderResult
  function. Does not actually run the tool — that requires a full pi
  environment.

**Verification:** `tsc --noEmit` passes. Smoke test passes.

**Commit:** `feat: extension entry registers the relay tool`

## Phase 8 — README, install, CHANGELOG, sample plan

**Output:** A repo a user can clone and install.

Files:

- `README.md` — full install instructions for symlink-based dev install
  and (eventually) npm. Quick start with a sample task. Architecture pointer.
  Limitations section: web-ui rendering, MVP scope.
- `CHANGELOG.md` — `[Unreleased]` section under v0.1.0 with the feature
  list.
- `actors/reviewer.md` — second sample actor alongside `worker.md`. The
  assistant is already the planner, so we deliberately do not ship a
  `planner` actor — planning happens in the assistant's loop when it
  authors the plan, and a separate planner actor inside the plan is a
  second round of planning with no upside.
- `examples/sample-plan.json` — a hand-written PlanDraft for documentation
  purposes, illustrating the schema the model is expected to fill in.

**Verification:** `tsc --noEmit` and the full test suite pass.

**Commit:** `docs: README, CHANGELOG, sample actors and plan`

## Out of v0.1, planned for v0.2

- Parallel execution and `Join` step kind.
- `PersistPerStep` and `PersistPerActor` context policies.
- Named artifact shapes with TypeBox schemas.
- Step-level timeouts.
- A confirmation hook for plans that touch declared sensitive paths.
- Persistent run history written to `~/.pi/agent/relay-runs/`.

## Risks identified during planning

- **Models may struggle to fill in `PlanDraft`.** Mitigation: keep the
  schema minimal, lean heavily on field descriptions, ship example plans
  for in-context learning. The first time we test this end to end will
  reveal whether the schema is too wide.
- **`streamSimple` does not natively understand the `complete_step`
  contract — we have to enforce it ourselves.** Mitigation: the engine
  validates the model's tool call against the generated schema and treats
  schema mismatch as `{ kind: "no_completion" }` so retries can happen.
- **Live rendering frequency.** `onUpdate` fires every event. For long
  runs this could be hundreds of updates. Mitigation: throttle to
  10Hz max in the scheduler-to-extension bridge, matching bash's
  cadence.
- **Test isolation for the scheduler.** The scheduler depends on actor
  engine, check engine, time, and randomness. Mitigation: all four are
  injected as dependencies; tests substitute fakes.
- **`tc --noEmit` vs jiti drift.** TypeScript may catch errors that
  jiti's runtime loader silently allows or vice versa. Mitigation: the
  CI command runs both `tsc --noEmit` and the real test suite (which
  uses real imports, not jiti).
