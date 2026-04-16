# Replay — Implementation Plan

This document sequences the build of the `replay` tool and the
directory consolidation described in `RELAY_TEMPLATES.md`. Each phase
produces a compiling, testable increment. The order is data-up:
directory migration first, then types, then the substitution engine,
then tool registration.

## What already exists

The codebase has 5.7k lines across four modules. The relevant pieces
this plan depends on:

- **`src/plan/ids.ts`** — branded ID constructors (`StepId`, `ActorId`,
  etc.) via `Brand<Tag, Base>` + `validate` + `unwrap`. New `TemplateId`
  follows the same pattern.
- **`src/plan/draft.ts`** — `PlanDraftSchema` (TypeBox) and
  `PlanDraftDoc` (Static). The `replay` tool reuses this schema for
  validating substituted plans; it does NOT modify it.
- **`src/plan/compile.ts`** — `compile(doc, actors, options)` returns
  `Result<Program, CompileError>`. Both `relay` and `replay` call this
  after producing a `PlanDraftDoc`.
- **`src/plan/result.ts`** — `Result<T, E>` with `ok`, `err`, `isOk`,
  `isErr`, `mapResult`, `flatMapResult`.
- **`src/actors/discovery.ts`** — `discoverActors(cwd, scope, options)`.
  Uses `ACTORS_SUBDIR = "relay-actors"` and `getAgentDir()` for user
  scope. `parseActorFile` reads frontmatter via pi's `parseFrontmatter`.
  `actorRegistryFromDiscovery` adapts discovery to the compiler's
  `ActorRegistry` interface. Template discovery will mirror this module.
- **`src/actors/types.ts`** — `ActorConfig`, `ActorDiscovery`,
  `ActorScope`, `ActorSource`. Template types parallel these.
- **`src/index.ts`** — extension entry. Discovers actors at load,
  builds tool description, registers `relay` with `execute`,
  `renderCall`, `renderResult`. The execute body handles compile,
  plan review (three-option select), scheduler construction, and
  `onUpdate` piping. The `replay` tool shares the tail of this flow
  (compile → review → schedule → return) so it needs to be extracted
  into a reusable helper.
- **`src/runtime/run-report.ts`** — `RunReport` interface and
  `buildRunReport(state, audit)`. Gains `templateName` and
  `templateArgs` fields.
- **`src/render/run-result.ts`** — `renderRunResult`, `renderCompileFailure`,
  `renderCancelled`, `renderRefined`. All reused by `replay`'s
  `renderResult`.
- **`src/render/plan-preview.ts`** — `renderPlanPreview`. Reused by
  `replay`'s `renderCall` after substitution produces a `PlanDraftDoc`.

Test structure: 155 tests across `test/{plan,runtime,actors,render}/`
plus three `test/index.*.test.ts` files for smoke, description, and
confirmation dialog.

## Dependency

Add `yaml` (npm) to `dependencies` in `package.json`. Used for parsing
the YAML plan body of template files. Lightweight, zero transitive deps.

---

## Phase 1 — Directory consolidation

**Goal:** Move actor discovery from `~/.pi/agent/relay-actors/` to
`~/.pi/agent/relay/actors/` (and the project-scope equivalent). No
functional change beyond the path.

**Files changed:**

- `src/actors/discovery.ts`
  - `ACTORS_SUBDIR`: change from `"relay-actors"` to `"relay/actors"`.
  - `findNearestProjectActorsDir`: walk up looking for
    `.pi/relay/actors/` instead of `.pi/relay-actors/`.
  - Add `warnLegacyPath(oldDir, newDir)`: if the old path exists and
    the new path does not, emit `console.error(...)` once with a
    migration message. Called from `discoverActors` before loading.
- `test/actors/discovery.test.ts` — update fixture directory names
  from `relay-actors/` to `relay/actors/`. Add one test confirming
  the legacy-path warning fires when old exists and new does not.
- `README.md` — update install path references.
- `actors/` sample directory at repo root — update the README's
  install command to `~/.pi/agent/relay/actors/`.

**Verify:** `npm test`. Move local actor files to the new path. Run
pi TUI, confirm relay discovers actors. Confirm warning message
appears when old path exists.

**Commit:** `refactor(actors): move discovery to ~/.pi/agent/relay/actors/`

---

## Phase 2 — Template domain types

**Goal:** The types that the rest of the template system speaks. Pure
data, no I/O.

**Files created:**

- `src/templates/types.ts`
  ```ts
  export type TemplateSource = "user" | "project";

  export interface TemplateParameter {
    readonly name: string;
    readonly description: string;
    readonly required: boolean;
  }

  export interface PlanTemplate {
    readonly name: string;
    readonly description: string;
    readonly parameters: readonly TemplateParameter[];
    readonly rawPlan: Record<string, unknown>;
    readonly source: TemplateSource;
    readonly filePath: string;
  }

  export interface TemplateDiscovery {
    readonly templates: readonly PlanTemplate[];
    readonly userDir: string;
    readonly projectDir: string | null;
    readonly warnings: readonly TemplateWarning[];
  }

  export interface TemplateWarning {
    readonly templateName: string;
    readonly message: string;
    readonly filePath: string;
  }
  ```

  `rawPlan` is the YAML-parsed body as a plain object. It is NOT a
  `PlanDraftDoc` — it contains `{{...}}` placeholders that would fail
  schema validation. It becomes a `PlanDraftDoc` only after
  substitution.

- `src/templates/errors.ts`
  ```ts
  export type TemplateError =
    | { readonly kind: "missing_template"; readonly name: string;
        readonly available: readonly string[] }
    | { readonly kind: "missing_required_param"; readonly missing: readonly string[];
        readonly provided: readonly string[] }
    | { readonly kind: "unresolved_placeholder"; readonly placeholder: string;
        readonly fieldPath: string }
    | { readonly kind: "invalid_plan"; readonly message: string };

  export const formatTemplateError = (error: TemplateError): string => { ... };
  ```

  Four variants, each carrying enough context for a useful error
  message. `formatTemplateError` is a single function like the
  existing `formatCompileError` in `src/plan/compile-error-format.ts`.

**Files changed:**

- `src/plan/ids.ts` — add `TemplateId` branded type and constructor,
  following the existing pattern: `export type TemplateId = Brand<"TemplateId", string>;`
  and `export const TemplateId = (value: string): TemplateId => ...`.
  Add to the `AnyBrand` union.

**Verify:** `npx tsc --noEmit`. No runtime tests yet — types only.

**Commit:** `feat(templates): domain types, TemplateId, error variants`

---

## Phase 3 — Template discovery

**Goal:** Load template `.md` files from `~/.pi/agent/relay/plans/`
and `<cwd>/.pi/relay/plans/`, parse frontmatter and YAML body.

**Files created:**

- `src/templates/discovery.ts`

  Mirrors `src/actors/discovery.ts` structurally:

  - `PLANS_SUBDIR = "relay/plans"`.
  - `discoverPlanTemplates(cwd, scope, options?)` — walks user and
    project dirs, reads `.md` files, calls `parseFrontmatter` for
    identity/params, calls `yaml.parse(body)` for the plan body.
  - `parseTemplateFile(filePath, source)` — validates:
    - `name` present and non-empty.
    - `description` present and non-empty.
    - `parameters` (if present) is an array; each entry has `name` and
      `description`; no duplicate param names.
    - YAML body parses without error.
    - Returns `PlanTemplate | null`. Null = skip with warning.
  - `DiscoveryOptions.userDir` override for tests, same as actor
    discovery.
  - Optional `actorNames: ReadonlySet<string>` for cross-validation
    (Phase 6). When provided, walks `rawPlan.steps`, extracts
    `step.actor` strings (skipping values that contain `{{`), warns
    for unrecognized actors. Warnings go into `TemplateDiscovery.warnings`.
  - Project-scope override: project templates shadow user templates
    of the same name, same as actors.

- `test/templates/discovery.test.ts`

  Fixture directory with `.md` files covering:
  - Valid template with 3 params → parsed correctly.
  - Missing `name` → skipped with warning.
  - Missing `description` → skipped with warning.
  - Bad YAML body (syntax error) → skipped with warning.
  - Duplicate param names within one template → skipped with warning.
  - Two templates, same name, project overrides user.
  - Template with no parameters → empty array, still loads.

**Verify:** `npm test`. New tests pass.

**Commit:** `feat(templates): discovery from relay/plans/ directories`

---

## Phase 4 — Substitution engine

**Goal:** Pure function: `PlanTemplate` + `args` → `PlanDraftDoc` or
`TemplateError`.

**Files created:**

- `src/templates/substitute.ts`

  ```ts
  export interface TemplateInstantiation {
    readonly plan: PlanDraftDoc;
    readonly templateName: string;
    readonly templateArgs: Record<string, string>;
  }

  export const instantiateTemplate = (
    template: PlanTemplate,
    args: Record<string, string>,
  ): Result<TemplateInstantiation, TemplateError> => { ... };
  ```

  Steps inside:
  1. **Validate required params.** Walk `template.parameters`, collect
     any where `required && !(name in args)`. If non-empty → `err({
     kind: "missing_required_param", ... })`.
  2. **Build substitution map.** For each declared parameter, map
     `name → args[name] ?? ""` (optional params default to empty
     string). Unknown args (keys in `args` not declared in
     `parameters`) are silently dropped from the map.
  3. **Deep-clone + substitute.** `structuredClone(template.rawPlan)`.
     Recursive walk: for every string value in the cloned object,
     replace all `{{name}}` occurrences using the substitution map.
  4. **Scan for residual placeholders.** Second recursive walk looking
     for `{{...}}` in any string value. If found → `err({ kind:
     "unresolved_placeholder", placeholder, fieldPath })`. `fieldPath`
     is a dot-path like `steps[0].instruction`.
  5. **Validate against PlanDraftSchema.** Use TypeBox `Value.Check`
     (and `Value.Errors` for message). If invalid → `err({ kind:
     "invalid_plan", message })`.
  6. **Return.** `ok({ plan: substituted as PlanDraftDoc, templateName:
     template.name, templateArgs: ... })`.

  The recursive walk is a standalone helper `substituteStrings(obj,
  map, path): string[]` returning any residual placeholder paths.
  Handles: plain objects, arrays, strings, and passes through numbers/
  booleans/null unchanged. Does not descend into non-plain-object
  prototypes.

- `test/templates/substitute.test.ts`

  Table-driven tests:
  - Happy path: 3 params, all provided → valid `PlanDraftDoc`.
  - Missing required param → `missing_required_param` with correct
    `missing` and `provided` lists.
  - Optional param omitted → `{{name}}` replaced with `""`.
  - Unknown arg silently ignored → plan still valid.
  - Residual placeholder (typo in template) → `unresolved_placeholder`
    with correct `fieldPath`.
  - YAML special characters in arg value (`"`, `:`, `\n`, `{`, `}`) →
    no structure corruption, plan valid.
  - Deeply nested string (inside `steps[].routes[].to`) → substituted.
  - Arg value containing `{{other}}` → NOT recursively substituted
    (single pass only).
  - Substituted plan fails `PlanDraftSchema` (e.g., empty `task` after
    substitution with `""`) → `invalid_plan`.

**Verify:** `npm test`. All substitution tests pass.

**Commit:** `feat(templates): substitution engine with validation`

---

## Phase 5 — Extract shared execute tail

**Goal:** Factor the compile → review → schedule → return sequence out
of `src/index.ts` so both `relay` and `replay` can call it.

Currently `src/index.ts` lines 85–217 contain:
1. `compile(plan, registry)` → handle compile failure
2. Plan review dialog (summarizePlanImpact → buildSelectTitle → select)
3. Scheduler construction and `run()`
4. `onUpdate` piping and final result assembly

This becomes a shared helper that both tools call after they have a
`PlanDraftDoc` in hand.

**Files created:**

- `src/execute.ts`

  ```ts
  export interface ExecuteInput {
    readonly plan: PlanDraftDoc;
    readonly discovery: ActorDiscovery;
    readonly signal: AbortSignal;
    readonly onUpdate?: OnUpdateFn;
    readonly ctx: ExtensionContext;
    readonly templateName?: string;
    readonly templateArgs?: Record<string, string>;
  }

  export const executePlan = async (
    input: ExecuteInput,
  ): Promise<AgentToolResult<RelayDetails>> => { ... };
  ```

  Body is a lift of the current execute logic from `src/index.ts`:
  - Build `actorsByName` map and `registry` from `discovery`.
  - `compile(plan, registry)` → on failure, return `compile_failed`.
  - Plan review dialog → on refine/cancel, return early.
  - Construct `Scheduler`, subscribe to events, `scheduler.run()`.
  - Build and return the final result with `RelayDetails`.

  `summarizePlanImpact`, `buildSelectTitle`, and the `CHOICE_*`
  constants move to this file (they are only used during execute).

**Files changed:**

- `src/index.ts` — `relay`'s execute body becomes:
  ```ts
  const discovery = discoverActors(ctx.cwd, "user");
  return executePlan({ plan, discovery, signal, onUpdate, ctx });
  ```
  Remove the moved helpers. Import `executePlan` from `./execute.js`.
  The tool registration, `buildToolDescription`, `renderCall`, and
  `renderResult` stay in `index.ts`.

**Verify:** `npm test` — all 155 existing tests pass. The three
`index.*.test.ts` files continue to work because the public API
(extension default export) is unchanged.

**Commit:** `refactor: extract shared executePlan from index.ts`

---

## Phase 6 — Register the `replay` tool

**Goal:** A working `replay` tool the model can call to run saved
templates.

**Files created:**

- `src/replay.ts`

  Registers the `replay` tool via `pi.registerTool`. Owns:

  - `ReplayParamsSchema` — TypeBox schema:
    ```ts
    Type.Object({
      name: Type.String({
        description: "Name of a saved plan template.",
        minLength: 1,
      }),
      args: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Parameter values for the template.",
        }),
      ),
    })
    ```
  - `buildReplayToolDescription(templates)` — one compact line per
    template: `- name(param1, param2): description`. When no templates
    are discovered, includes the "NO PLANS INSTALLED" message with
    the directory path.
  - `execute(_toolCallId, params, signal, onUpdate, ctx)`:
    1. Re-discover templates (fresh, same as relay re-discovers actors).
    2. Look up `params.name`. Missing → return `compile_failed` with
       available template list.
    3. `instantiateTemplate(template, params.args ?? {})`. On error →
       return `compile_failed` with `formatTemplateError`.
    4. Re-discover actors.
    5. `executePlan({ plan: instantiation.plan, discovery, signal,
       onUpdate, ctx, templateName, templateArgs })`.
  - `renderCall(params, theme, context)` — single `Text`:
    `▸ replay  <name>  key=value key=value`
    Visually distinct from relay's `renderCall` (which shows the full
    plan). The user sees what template was invoked and with what args.
    On expand, could show the substituted plan via `renderPlanPreview`
    — but v0.1 keeps it to the one-liner.
  - `renderResult` — delegates to the same render functions relay uses:
    `renderRunResult`, `renderCompileFailure`, `renderCancelled`,
    `renderRefined`. Same `RelayDetails` type.

- `test/replay.test.ts`

  Tests:
  - Smoke: registers a tool named `"replay"` with the extension API.
  - Tool description lists discovered templates with parameter
    signatures.
  - Tool description shows "NO PLANS" message when directory is empty.
  - `renderCall` output format: `▸ replay  name  key=value`.

**Files changed:**

- `src/index.ts` — in the default export function:
  - Call `discoverPlanTemplates(process.cwd(), "user")` at load time.
  - Pass discovered actor names into template discovery for
    cross-validation warnings (pipe warnings to stderr).
  - Import and call `registerReplayTool(pi, templates)` (exported
    from `src/replay.ts`) after the existing `relay` registration.
- `src/runtime/run-report.ts`:
  - Add optional `templateName?: string` and
    `templateArgs?: Readonly<Record<string, string>>` to `RunReport`.
  - In `buildRunReport`: accept optional template provenance from
    caller, pass through.
  - In `renderRunReportText`: when `report.templateName` is set,
    include `(from template: <name>)` in the header line.

**Verify:** `npm test`. New replay tests pass. Existing relay tests
still pass. Manual test with pi TUI: drop a sample template into
`~/.pi/agent/relay/plans/`, ask the model to use it, verify the plan
review dialog shows the substituted plan.

**Commit:** `feat: register replay tool for saved plan templates`

---

## Phase 7 — Integration tests

**Goal:** End-to-end test covering the full replay path with a fake
actor engine.

**Files created:**

- `test/replay.integration.test.ts`

  Uses the existing fake actor engine pattern from
  `test/runtime/scheduler.test.ts`. Sets up:
  - A fixture template `.md` file in a temp directory.
  - A fake actor engine that returns canned `completed` outcomes.
  - Calls `instantiateTemplate` → `compile` → `Scheduler.run()`.
  - Asserts the `RunReport` contains `templateName` and `templateArgs`.
  - Asserts the scheduler executed the correct steps in order.
  - Asserts the audit log records the same events as a relay run.

  Error-path tests:
  - Template not found → `compile_failed` with available list.
  - Missing required arg → `compile_failed` with param names.
  - Residual placeholder → `compile_failed` with field path.
  - Template references unknown actor → `compile_failed` with actor
    error from the compiler.

**Verify:** `npm test`.

**Commit:** `test: replay integration tests`

---

## Phase 8 — Documentation and samples

**Files created:**

- `plans/refactor-module.md` — sample template at repo root (alongside
  `actors/`). The example from the design doc: rename a symbol,
  verify with tests.
- `plans/review-fix-loop.md` — sample template demonstrating
  multiWriter artifacts and back-edges in a template.

**Files changed:**

- `README.md` — new section: "Replay — saved plan templates." Covers:
  - Two-tool model (`relay` for ad-hoc, `replay` for saved).
  - Directory layout under `~/.pi/agent/relay/`.
  - Template file format (frontmatter + YAML body).
  - Parameter substitution with `{{name}}`.
  - Example invocation.
- `CHANGELOG.md` — add `replay` tool entry and directory consolidation
  to `[Unreleased]`.

**Verify:** `npm test`, `npx tsc --noEmit`, `npx biome check .`

**Commit:** `docs: replay tool, sample templates, updated README`

---

## Risks

- **YAML parsing edge cases.** YAML is famously tricky (`"no"` becomes
  `false`, `1.0` becomes a number). Template bodies contain plan fields
  like `outcome: success` which YAML will parse as strings, and
  `maxAttempts: 3` which YAML will parse as a number. TypeBox
  validation after substitution will catch type mismatches, but
  template authors may be surprised. Mitigation: document that the
  YAML body must produce a value matching `PlanDraftSchema`, and use
  YAML 1.2 parsing mode (the `yaml` package defaults to 1.2, which
  does not convert `yes`/`no` to booleans).

- **structuredClone on rawPlan.** The raw plan object from YAML parse
  should be plain data (no Date, RegExp, etc.). `structuredClone`
  handles this correctly. If YAML produces custom types (timestamps),
  they would fail `structuredClone`. Mitigation: use `yaml.parse` with
  default schema (JSON-compatible), which produces only plain objects,
  arrays, strings, numbers, booleans, and null.

- **Template + actor discovery at every execute call.** Both `relay`
  and `replay` re-discover on every invocation. This means two
  `readdirSync` walks per tool call (actors + templates). For typical
  directory sizes (< 50 files) this is sub-millisecond. Not a concern
  unless someone has hundreds of templates.

- **Tool description growth.** Each template adds ~15-20 tokens to
  `replay`'s description. 30 templates ≈ 500 tokens. This is
  separate from `relay`'s description, so the two don't compound.
  If someone installs 100+ templates, the description becomes a
  context-window problem. Mitigation for later: cap listing at 30,
  add a `name: "list"` discovery mode.

## Out of scope

- Slash command invocation (`/template-name arg1 arg2`).
- Typed parameters (enum, path, integer).
- Default parameter values.
- Template composition.
- Template versioning.
- Conditional or loop constructs in template bodies.
