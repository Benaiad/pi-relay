# Tool-Based Completion: Implementation Plan

References: [TOOL_BASED_COMPLETION.md](./TOOL_BASED_COMPLETION.md)

## What already exists

- `ActorEngine` interface at `src/actors/types.ts:180-182` — `runAction(request): Promise<ActionOutcome>`. The scheduler calls this; the implementation is swappable.
- `createSubprocessActorEngine` at `src/actors/engine.ts:57-59` — current subprocess implementation.
- Scheduler tests (`test/runtime/scheduler.test.ts`) use `ScriptedActorEngine`, a fake that returns canned `ActionOutcome` values. Scheduler tests do not touch the real engine.
- `complete-step.test.ts` tests XML parsing and instruction generation. These tests will be deleted along with the code they test.
- `@mariozechner/pi-coding-agent ^0.69.0` is already a peer and dev dependency.
- `typebox ^1.1.24` is already a dependency.
- pi SDK exports `createAgentSession`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`, and `defineTool` from the package index.
- `ToolResultMessage.details` (from `@mariozechner/pi-ai`) carries the tool's structured `details` field.
- `AgentSessionEvent` includes `tool_execution_end` with `{ toolName, result }` and `message_end`/`message_update` for progress streaming.
- `ExtensionContext` (received in tool execute) exposes `modelRegistry: ModelRegistry` and `cwd: string`. It does NOT expose `AuthStorage` or `SettingsManager` — but `createAgentSession` creates both from `agentDir` (defaults to `~/.pi/agent`) when they're not passed, reading the same credentials and settings as the parent pi process.
- `execute.ts:32` already receives `ctx: ExtensionContext` and passes `ctx.cwd` to the scheduler. The `ctx.modelRegistry` is available but unused today.
- `execute.ts:124` creates the engine: `createSubprocessActorEngine()` — takes no arguments. The new engine needs `modelRegistry` from the context.

## Architecture decisions

**In-process over subprocess.** The `createAgentSession` SDK gives us `customTools` with `terminate: true` — exactly the completion mechanism we need. The subprocess model only existed because the extension API didn't expose tool invocation from inside another tool. The SDK has no such limitation.

**One session per actor invocation.** Each `runAction` call creates a fresh `AgentSession`, sends one prompt, reads the result, and disposes the session. No session reuse across steps — same isolation semantics as the subprocess model.

**Dynamic tool schema per step.** The `relay_complete` tool's `parameters` schema is constructed at runtime from the step's `RouteId[]` and `ArtifactContract[]`. TypeBox schemas are plain JSON Schema objects at runtime, so this is straightforward construction — no codegen.

**Resource loader configured for minimal overhead.** Actors don't need extension discovery, skill loading, prompt templates, or context files. A `DefaultResourceLoader` with `noExtensions`, `noSkills`, `noPromptTemplates`, `noContextFiles`, and `appendSystemPrompt` (actor preamble) minimizes startup cost.

**Model resolution via ModelRegistry from ExtensionContext.** `ExtensionContext.modelRegistry` is available in the tool's execute callback and provides `find(provider, modelId)` to resolve model strings to `Model` objects. The engine receives this at construction time from `execute.ts`, which already has access to `ctx: ExtensionContext`. `AuthStorage` and `SettingsManager` are not exposed by the extension API, but `createAgentSession` creates them automatically from `agentDir` (`~/.pi/agent`) — the same location the parent pi process uses.

## Data flow

```
Scheduler.executeAction(step)
  │
  ├─ Build ArtifactSnapshot from reads
  ├─ Build prior attempts from audit log
  │
  └─ actorEngine.runAction(request)
       │
       ├─ buildCompletionTool(step.routes, step.writes, contracts)
       │    → ToolDefinition with dynamic TypeBox schema + terminate: true
       │
       ├─ buildTaskPrompt(...)
       │    → same as today minus completion reminder paragraph
       │
       ├─ createAgentSession({
       │     cwd: request.cwd,
       │     model: resolvedModel,
       │     thinkingLevel: actor.thinking,
       │     tools: [...actor.tools, "relay_complete"],
       │     customTools: [completionTool],
       │     sessionManager: SessionManager.inMemory(request.cwd),
       │     resourceLoader: configured with actor system prompt,
       │   })
       │
       ├─ session.subscribe(event => {
       │     map events → TranscriptItem → onProgress
       │   })
       │
       ├─ await session.prompt(taskPrompt)
       │
       ├─ extractCompletion(session.messages)
       │    → find ToolResultMessage where toolName === "relay_complete"
       │    → read .details → { route, ...artifactValues }
       │
       ├─ session.dispose()
       │
       └─ return ActionOutcome
```

## File changes

| File | Action | Summary |
|------|--------|---------|
| `src/actors/completion-tool.ts` | **Create** | `buildCompletionTool` — constructs `ToolDefinition` from step metadata |
| `src/actors/sdk-engine.ts` | **Create** | `createSdkActorEngine` — in-process engine using `createAgentSession` |
| `src/actors/engine.ts` | Delete | Subprocess engine (keep during transition, delete at end) |
| `src/actors/complete-step.ts` | Delete | XML protocol — parsing, instruction generation, tag stripping |
| `src/execute.ts` | Modify | Wire `createSdkActorEngine` with `ctx.modelRegistry` instead of `createSubprocessActorEngine` |
| `test/actors/complete-step.test.ts` | Delete | Tests for deleted XML protocol |
| `test/actors/completion-tool.test.ts` | **Create** | Tests for schema construction |
| `test/actors/sdk-engine.test.ts` | **Create** | Tests for completion extraction from messages |

## Dependency graph

```
Step 1: completion-tool.ts        (no dependencies on engine)
Step 2: sdk-engine.ts             (depends on step 1)
Step 3: wire into pi-relay.ts     (depends on step 2)
Step 4: delete old code           (depends on step 3)
```

## Step-by-step implementation

### Step 1: Build completion tool constructor

**File:** `src/actors/completion-tool.ts` (new)

Construct a `ToolDefinition` from step metadata. This is pure data
transformation — no I/O, no session, independently testable.

**Input:** `RouteId[]`, `ArtifactId[]`, `ReadonlyMap<ArtifactId, ArtifactContract>`

**Output:** `ToolDefinition` with:
- `name: "relay_complete"`
- `description`: tells the model to call this when done
- `promptGuidelines`: "call exactly once, as your final action"
- `parameters`: TypeBox schema with `route` (union of literal strings) and one
  property per writable artifact
- `execute`: returns `{ content: [...], details: params, terminate: true }`

**Schema construction rules:**

```typescript
// Route parameter
route: Type.Union(routeIds.map(r => Type.Literal(unwrap(r))))

// Per artifact, based on shape:
// text       → Type.Optional(Type.String({ description }))
// record     → Type.Optional(Type.Object({ [field]: Type.String() }))
// record_list → Type.Optional(Type.Array(Type.Object({ [field]: Type.String() })))
```

All artifact properties are optional — the model may not write every artifact
on every invocation.

**Edge case:** If `routeIds` has exactly one entry, `Type.Union` with a single
literal is fine — TypeBox handles it. If zero routes (should not happen),
fall back to `Type.String()` with a description listing none.

**Test:** `test/actors/completion-tool.test.ts`
- Schema has correct route literals
- Schema has correct artifact properties for each shape kind
- Execute returns `terminate: true`
- Execute returns params as `details`

**Verify:** `npx vitest run test/actors/completion-tool.test.ts`

### Step 2: Build SDK actor engine

**File:** `src/actors/sdk-engine.ts` (new)

The replacement for `createSubprocessActorEngine`. Same `ActorEngine` interface,
different implementation.

**Factory signature:**

```typescript
export interface SdkEngineConfig {
  readonly modelRegistry: ModelRegistry;
  readonly defaultModel: Model<any> | undefined;
}

export const createSdkActorEngine = (config: SdkEngineConfig): ActorEngine => ({
  runAction: (request) => runAction(config, request),
});
```

The config carries the `ModelRegistry` from `ExtensionContext` for resolving
actor model strings, and the parent session's current model as a fallback when
the actor config doesn't specify one. `AuthStorage` and `SettingsManager` are
omitted — `createAgentSession` creates them from `~/.pi/agent` automatically.

**`runAction` implementation:**

```
1. Resolve model
   - If actor.model is set, resolve via ModelRegistry:
     - If it contains "/", split into provider + modelId → registry.find()
     - Otherwise, match bare id against registry.getAvailable()
   - If actor.model is unset, fall back to config.defaultModel (ctx.model)
   - If resolution fails → return engine_error outcome

2. Build completion tool
   - Call buildCompletionTool(step.routes, step.writes, artifactContracts)

3. Build task prompt
   - Reuse buildTaskPrompt from engine.ts (extract to shared module or copy)
   - Remove the "completion reminder" paragraph — the tool replaces it

4. Create resource loader
   - new DefaultResourceLoader({
       cwd: request.cwd,
       agentDir: getAgentDir(),
       settingsManager: SettingsManager.create(request.cwd),
       noExtensions: true,
       noSkills: true,
       noPromptTemplates: true,
       noContextFiles: true,
       appendSystemPrompt: [actor.systemPrompt],
     })
   - await resourceLoader.reload()

5. Create session
   - await createAgentSession({
       cwd: request.cwd,
       model: resolvedModel,
       thinkingLevel: actor.thinking ?? "medium",
       tools: [...(actor.tools ?? []), "relay_complete"],
       customTools: [completionTool],
       sessionManager: SessionManager.inMemory(request.cwd),
       modelRegistry: config.modelRegistry,
       resourceLoader,
     })
   - AuthStorage and SettingsManager are omitted — createAgentSession
     creates them from agentDir (~/.pi/agent), same as parent process

6. Subscribe to events
   - Map AgentSessionEvent → TranscriptItem → request.onProgress
   - Track usage from message_end events (assistant messages carry usage)

7. Run prompt
   - await session.prompt(taskPrompt) inside try/catch
   - On AbortError or signal.aborted → return aborted outcome
   - On other error → return engine_error outcome

8. Extract completion
   - Walk session.messages backward
   - Find ToolResultMessage where toolName === "relay_complete"
   - Read details → { route, ...artifacts }
   - If not found → return no_completion outcome

9. Validate route
   - Same logic as current engine: check step.routes.has(routeId)
   - If invalid → return no_completion

10. Build writes map
    - Same logic: filter to step.writes, construct Map<ArtifactId, unknown>

11. Dispose session
    - session.dispose() in finally block

12. Return ActionOutcome
```

**Prompt building:** Extract `buildTaskPrompt` and `renderArtifact` from
`engine.ts` into a shared module `src/actors/task-prompt.ts`. Both engines
(during transition) and the new engine (permanently) use the same prompt
builder. The only change: remove the "Completion reminder" section at the
end of `buildTaskPrompt`, since the tool's description and guidelines replace
it.

**Progress event mapping:**

| AgentSessionEvent | TranscriptItem |
|---|---|
| `message_update` with text content | `{ kind: "text", text }` |
| `tool_execution_start` where toolName !== "relay_complete" | `{ kind: "tool_call", toolName, args }` |
| `tool_execution_start` where toolName === "relay_complete" | skip (internal) |

Usage is accumulated from `message_end` events on assistant messages, same
fields as today (input, output, cacheRead, cacheWrite, cost, contextTokens,
turns).

**Abort handling:** Pass `request.signal` into the session. The agent loop
checks abort between turns. If `prompt()` rejects with an abort error, return
`{ kind: "aborted" }`. Wrap the entire flow in try/finally to guarantee
`session.dispose()`.

**Test:** `test/actors/sdk-engine.test.ts`

Testing the real engine requires API calls, so unit tests focus on the
extractable pure functions:
- Completion extraction from a mock message array
- Task prompt building (already tested by proxy through existing tests)
- Progress event mapping

Integration testing (with a real model) is covered by the existing
`test/index.smoke.test.ts` and `test/replay.integration.test.ts` which
exercise the full plan execution pipeline.

**Verify:** `npx vitest run test/actors/sdk-engine.test.ts`

### Step 3: Extract shared prompt builder

**File:** `src/actors/task-prompt.ts` (new, extracted from `engine.ts`)

Move `buildTaskPrompt`, `renderArtifact`, and `truncate` out of `engine.ts`
into their own module. The SDK engine imports from here. During transition,
`engine.ts` also imports from here (or we just delete the subprocess engine
in step 5).

The only change to `buildTaskPrompt`: remove the "Completion reminder"
section (lines 282-289 of current `engine.ts`). The tool's `promptGuidelines`
replace this.

`render-value.ts` stays where it is — `task-prompt.ts` imports it.

**Verify:** `npx vitest run` (all tests pass, nothing broken)

### Step 4: Wire SDK engine into pi-relay

**File:** `src/execute.ts`

Replace `createSubprocessActorEngine()` with `createSdkActorEngine(config)`.

The `ExecuteInput` already receives `ctx: ExtensionContext`. The wiring:

```typescript
// execute.ts, line ~124
const scheduler = new Scheduler({
  program,
  actorEngine: createSdkActorEngine({
    modelRegistry: ctx.modelRegistry,
    defaultModel: ctx.model,
  }),
  actorsByName,
  cwd: ctx.cwd,
  signal,
  clock,
  audit,
  artifactStore,
});
```

`ctx.modelRegistry` is available on `ExtensionContext` (confirmed in
`types.ts:303`). `ctx.model` provides the parent session's current model
as fallback.

No changes needed to `pi-relay.ts` itself — it already passes `ctx` through
to `executePlan`.

**Verify:** Manual smoke test — run a relay plan end-to-end with the new engine.
Run `npx vitest run` to confirm all automated tests pass.

### Step 5: Delete old code

**Files to delete:**
- `src/actors/engine.ts` — subprocess engine
- `src/actors/complete-step.ts` — XML protocol
- `test/actors/complete-step.test.ts` — XML protocol tests

**Files to update:**
- Remove imports of deleted modules from any remaining files
- Update `src/actors/index.ts` (if it exists) to export `createSdkActorEngine`
  instead of `createSubprocessActorEngine`
- Remove `stripCompletionTag` usage from any UI/rendering code

**Verify:** `npx vitest run && npx tsc --noEmit`

## Risks and mitigations

**SDK API stability.** `createAgentSession` is pi's public SDK entry point.
If it changes, the engine breaks. Mitigation: pi-relay already depends on
`@mariozechner/pi-coding-agent` as a peer dependency. Pin to a known-good
version. The SDK is more stable than CLI arg parsing.

**Resource loader overhead.** Creating a `DefaultResourceLoader` per invocation
may have startup cost (disk reads for extension discovery). Mitigation:
`noExtensions`, `noSkills`, `noPromptTemplates`, `noContextFiles` skip all
discovery. Measure the overhead — if significant, cache or share the loader
across invocations with the same `cwd`.

**Session leak on error.** If `prompt()` throws and `dispose()` is not called,
the session leaks event listeners and internal state. Mitigation: `finally`
block guarantees `dispose()` on all paths.

**Model resolution.** The current subprocess engine passes `--model` as a bare
string and lets pi CLI resolve it. The CLI supports `"provider/modelId"` format
(e.g. `"anthropic/claude-sonnet-4-5"`) and bare model ids (e.g.
`"claude-sonnet-4-5"`). The resolution logic lives in `model-resolver.ts` but
is not exported from the package.

`ModelRegistry` (available on `ExtensionContext`) exposes `find(provider,
modelId)` and `getAvailable()`. The SDK engine implements a thin resolver:
split on `/` if present to get provider + modelId, otherwise match bare id
against `getAvailable()`. This covers the formats actor configs actually use
without reimporting pi's full model-resolver machinery.

**System prompt composition.** The current engine uses `--append-system-prompt`
which goes through pi's resource loader. The SDK engine achieves the same via
`DefaultResourceLoader({ appendSystemPrompt: [actor.systemPrompt] })`. Verify
that the actor's system prompt ends up in the correct position in the composed
prompt — after pi's base system prompt, before tool descriptions.

**AuthStorage/SettingsManager not on ExtensionContext.** These are not exposed
by the extension API. `createAgentSession` creates them from `agentDir`
(`~/.pi/agent`) when omitted. This means each actor session reads auth and
settings from disk independently. The cost is small (file reads), but if
pi-relay runs many actors concurrently, the redundant I/O could add up. If
this becomes measurable, create them once and share across invocations.
