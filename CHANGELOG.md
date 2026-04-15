# Changelog

## [Unreleased]

### Added

- Repository scaffold with TypeScript, biome, vitest, and the `pi` manifest
  field in `package.json`.
- Architecture document (`architecture/RELAY_PI.md`) describing the goals,
  module boundaries, data flow, domain types, error scenarios, and explicit
  MVP scope.
- Implementation plan (`architecture/RELAY_PI_IMPL.md`) sequencing the v0.1
  build across eight phases.
- Plan IR with branded identifier types (`PlanId`, `RunId`, `StepId`,
  `ActorId`, `ArtifactId`, `RouteId`, `EdgeKey`), a `Result<T, E>` helper,
  and a TypeBox schema (`PlanDraftSchema`) used as the `relay` tool's
  parameter schema.
- Compiler (`compile()`) producing an immutable `Program` with indexed step,
  edge, writer, and reader maps. Rejects empty plans, duplicate step ids,
  missing entry, missing actor references, unresolved routes, duplicate or
  producerless artifacts, multi-writer ownership, and unsupported context
  policies with structured error variants and a human-readable formatter.
- Runtime:
  - `ArtifactStore` with snapshot reads and atomic, contract-validated commits.
  - Deterministic check engine covering `file_exists` and `command_exits_zero`.
  - Event model (`RelayEvent` discriminated union) and a pure reducer
    (`applyEvent`) mutating `RelayRunState`.
  - Append-only `AuditLog`.
  - Sequential ready-queue `Scheduler` with retries, artifact commits via
    the store, abort propagation, and terminal route handling.
  - Final `RunReport` derived purely from `RelayRunState`.
- Actor layer:
  - Markdown-with-frontmatter discovery from `~/.pi/agent/relay-actors/` and
    `<cwd>/.pi/relay-actors/` with `user`, `project`, and `both` scopes.
  - `<relay-complete>{...}</relay-complete>` completion protocol: builder for
    the system-prompt instruction and parser for the tagged JSON block.
  - `createSubprocessActorEngine` spawning pi with `--mode json -p
    --no-session --append-system-prompt --tools` and streaming live
    progress events through the scheduler.
- TUI rendering matching subagent's visual vocabulary:
  - `renderPlanPreview` for `renderCall` — collapsed and expanded views of
    a `PlanDraftDoc`.
  - `renderRunResult` for `renderResult` — collapsed status line with a
    step-icon strip, expanded per-step blocks with transcripts, routes,
    error reasons, and per-step usage.
  - Shared formatters for paths, tokens, cost, duration, truncation, and
    usage aggregation.
  - Single-source status icon palette in `render/icons.ts`.
- Extension entry in `src/index.ts` registering the `relay` tool with
  parameter schema, execute choreographer, `renderCall`, and `renderResult`.
- Two sample actor files (`worker`, `reviewer`) shipped with the repo.
  Deliberately no `planner`: the outer pi assistant is already the
  planner, and a separate planner actor inside the plan is just a second
  round of planning with no upside. See the README's "The assistant is
  the planner; actors execute" section.
- Test suite: 155 tests covering ids, result type, TypeBox schema
  validation, compiler (16 variants), artifact store, check engine,
  actor discovery, completion protocol, scheduler (sequential flows,
  retries, abort, audit replay, contract violations, terminal routing,
  multi-writer loops, re-entry caps), render formatters and icons, and
  extension registration smoke test.
