# Actor Model and Thinking Validation — Implementation Plan

References: [ACTOR_VALIDATION.md](./ACTOR_VALIDATION.md)

## What already exists

- **Actor discovery** (`src/actors/discovery.ts`): Scans directories, parses `.md` frontmatter into `ActorConfig` objects. The `model` field is a raw string, `thinking` is an optional `ThinkingLevel`. Invalid thinking levels are silently dropped (return `undefined`).

- **Model resolution** (`src/actors/sdk-engine.ts:257-278`): The `resolveModel` function takes a model string + `SdkEngineConfig`, tries `provider/modelId` format via `modelRegistry.find()`, then exact/partial match against `modelRegistry.getAvailable()`, falls back to `config.defaultModel`. Returns `Model<Api> | undefined`.

- **Thinking default** (`src/actors/sdk-engine.ts:107`): Hardcoded `actor.thinking ?? "medium"` passed to `createAgentSession`.

- **Execute pipeline** (`src/execute.ts:43-183`): `executePlan` builds an `actorsByName` map from discovery, compiles the plan, runs the scheduler. No validation step between discovery and compilation.

- **Scheduler** (`src/runtime/scheduler.ts:326-337`): Looks up actors by name from the `actorsByName` map. Passes the `ActorConfig` directly to the engine via `ActionRequest.actor`.

- **Both tools** (`src/pi-relay.ts:100-117`, `src/replay.ts:58-103`): Both `relay` and `replay` call `discoverActors` → `filterActors` → `executePlan`. Both have access to `ctx` (ExtensionContext) and `pi` (ExtensionAPI, via closure).

- **`supportsXhigh`**: Exported from `@mariozechner/pi-ai`, which pi-relay already depends on.

- **`pi.getThinkingLevel()`**: Available on `ExtensionAPI`. Returns the assistant's current `ThinkingLevel`.

## Architecture decisions

1. **`ValidatedActor` extends `ActorConfig` with a resolved model.** The `model` field on `ActorConfig` is a `string | undefined`. `ValidatedActor` adds a `resolvedModel: Model<Api> | undefined` field and a guaranteed `thinking: ThinkingLevel` (no longer optional — defaulted and clamped during validation). The raw `ActorConfig` fields are preserved for display and diagnostics.

2. **`resolvedModel` is optional.** When no model is available at all (actor specified an unknown model and no assistant model exists), the actor stays in the validated set with `resolvedModel: undefined`. The SDK engine preserves its existing `engine_error` return for this case. This keeps the compiler's actor registry and the validated actor map consistent — actors are never excluded during validation.

3. **Model resolution uses plain control flow, not a discriminated return type.** Validation already knows whether the actor specified a model string — it doesn't need `resolveModel` to encode that in its return value. The logic is: if the actor has a model string, try to find it in the registry; if not found, fall back to the default and warn. If no model string, use the default silently. A helper `findModel` (extracted from the existing `resolveModel`) handles the registry lookup and returns `Model<Api> | undefined`. The fallback and warning logic lives in `validateActors` as straightforward if/else.

4. **The `actorsByName` map type changes from `ActorConfig` to `ValidatedActor`.** This ripples into `execute.ts`, `scheduler.ts`, and `types.ts`. The change is mechanical — `ValidatedActor` is a superset of `ActorConfig`, so most consuming code works without modification. The scheduler's `ActorConfig` import switches to `ValidatedActor`.

5. **Validation is a pure function with a notify callback.** The `validateActors` function takes concrete dependencies (actors, registry, default model, assistant thinking level, notify function) rather than the extension context object. This keeps it testable without mocking extension APIs.

6. **Warnings use `ctx.ui.notify(message, "warning")`.** The `notify` callback is `(message: string) => void` — the caller wraps `ctx.ui.notify` to bind the `"warning"` severity. This keeps the validation module decoupled from the notification API shape.

## Data flow

```
pi-relay.ts / replay.ts
  ↓ discoverActors() → ActorConfig[]
  ↓ filterActors()   → ActorConfig[]
  ↓
execute.ts
  ↓ validateActors(actors, modelRegistry, defaultModel, assistantThinking, notify)
  ↓   → ValidatedActor[] (model resolved or undefined, thinking defaulted + clamped, warnings emitted)
  ↓
  ↓ actorsByName = Map<ActorId, ValidatedActor>
  ↓ compile(plan, registry)  ← registry built from raw discovery (same actor names)
  ↓ Scheduler({ actorsByName, actorEngine, ... })
  ↓
scheduler.ts
  ↓ executeAction(step) → actor = actorsByName.get(step.actor)
  ↓ actorEngine.runAction({ actor, ... })
  ↓
sdk-engine.ts
  ↓ runAction(config, request)
  ↓   if (!actor.resolvedModel) → return engine_error (existing path)
  ↓   thinkingLevel = actor.thinking  (already validated, non-optional)
  ↓ createAgentSession({ model, thinkingLevel, ... })
```

## File change summary

| File | Change |
|------|--------|
| `src/actors/types.ts` | Add `ValidatedActor` interface |
| `src/actors/validate.ts` | **New file.** `validateActors` function + `findModel` helper (lookup logic extracted from sdk-engine's `resolveModel`) |
| `src/actors/sdk-engine.ts` | Remove `resolveModel`. Change `runAction` to read model and thinking from `ValidatedActor`. Remove `SdkEngineConfig.defaultModel`. |
| `src/execute.ts` | Add `validateActors` call between discovery and compilation. Pass `ValidatedActor` to scheduler. Accept `pi: ExtensionAPI` in `ExecuteInput`. |
| `src/pi-relay.ts` | Pass `pi` into `executePlan`. |
| `src/replay.ts` | Pass `pi` into `executePlan`. |
| `src/runtime/scheduler.ts` | Change `actorsByName` type from `ActorConfig` to `ValidatedActor`. |
| `test/actors/validate.test.ts` | **New file.** Tests for validation logic. |
| `test/runtime/scheduler.test.ts` | Update actor fixtures to include `resolvedModel` and required `thinking`. |

## Step-by-step implementation

### Step 1: Add `ValidatedActor` type to `types.ts`

**File:** `src/actors/types.ts`

Add a new interface after `ActorConfig`:

```typescript
export interface ValidatedActor extends ActorConfig {
  readonly resolvedModel: Model<Api> | undefined;
  readonly thinking: ThinkingLevel; // narrowed from optional to required
}
```

Import `Model` and `Api` from `@mariozechner/pi-ai`.

**Verify:** `npx tsc --noEmit` — no consumers use `ValidatedActor` yet, so this is additive.

### Step 2: Create `validate.ts` with `findModel` and `validateActors`

**File:** `src/actors/validate.ts` (new)

Extract the registry lookup logic from `resolveModel` in `sdk-engine.ts` into a `findModel` helper. This function takes a model string and a registry, tries `provider/modelId` format via `modelRegistry.find()`, then exact ID match, then partial match against `modelRegistry.getAvailable()`. Returns `Model<Api> | undefined`. No fallback to a default — that's the caller's job.

Add `validateActors`:

```
validateActors(
  actors: readonly ActorConfig[],
  modelRegistry: ModelRegistry,
  defaultModel: Model<Api> | undefined,
  assistantThinkingLevel: ThinkingLevel,
  notify: (message: string) => void,
): ValidatedActor[]
```

For each actor:

1. **Resolve the model.**
   ```
   if actor has no model string:
     resolvedModel = defaultModel       (silent — no warning)
   else:
     found = findModel(actor.model, modelRegistry)
     if found:
       resolvedModel = found            (no warning)
     else:
       resolvedModel = defaultModel     (may be undefined)
       notify("Actor '<name>': model '<model>' not available (provider not configured). Using assistant's model.")
   ```
   If `defaultModel` is also undefined in the fallback case, `resolvedModel` ends up `undefined`. Emit an additional warning: `Actor '<name>': no model available. Will fail at runtime.`

2. Determine effective thinking level: `actor.thinking ?? assistantThinkingLevel`.

3. If `resolvedModel` exists and `resolvedModel.reasoning === false` and effective thinking is not `"off"`:
   - Emit: `Actor '<name>': model '<id>' does not support thinking. Thinking level set to 'off'.`
   - Set effective thinking to `"off"`.

4. If `resolvedModel` exists and `resolvedModel.reasoning === true` and effective thinking is `"xhigh"` and `!supportsXhigh(resolvedModel)`:
   - Emit: `Actor '<name>': model '<id>' supports up to 'high' thinking. Clamped from 'xhigh' to 'high'.`
   - Set effective thinking to `"high"`.

5. If `resolvedModel` is undefined, skip thinking capability checks — there's nothing to check against, and the engine will error before it uses the value.

6. Return `{ ...actor, resolvedModel, thinking: effectiveThinking }`. Every actor produces a `ValidatedActor` — none are excluded.

**Verify:** `npx tsc --noEmit` — the module is not imported yet, but must compile.

### Step 3: Write tests for `validateActors`

**File:** `test/actors/validate.test.ts` (new)

Test cases:

**`findModel` tests:**

- Model string found by exact ID → returns the model.
- Model string found by partial match → returns the model.
- Model string with `provider/id` format, found → returns the model.
- Model string not found → returns `undefined`.

**`validateActors` tests:**

- **No model specified, no explicit thinking** → inherits default model and assistant thinking level. No warnings.
- **No model specified, explicit thinking** → inherits default model, uses actor's thinking level. No warnings.
- **Model specified and found** → uses resolved model. No warnings.
- **Model specified but not found** → falls back to default model. Warning emitted about provider not configured.
- **Model specified, not found, no default model** → `resolvedModel: undefined`. Warning emitted. Actor still in result.
- **Thinking on non-reasoning model (explicit thinking)** → clamped to `"off"`. Warning emitted.
- **Thinking on non-reasoning model (inherited thinking)** → clamped to `"off"`. Warning emitted.
- **xhigh on model without xhigh support** → clamped to `"high"`. Warning emitted.
- **xhigh on model with xhigh support** → kept as `"xhigh"`. No warnings.
- **off on non-reasoning model** → kept as `"off"`. No warnings.
- **No model available, thinking set** → `resolvedModel: undefined`, thinking preserved without capability check. Warning about missing model only.
- **Multiple actors, mixed warnings** → each actor validated independently, correct warnings for each.

Build a minimal `ModelRegistry` fake or use the real one with in-memory models. Build `Model<Api>` fixtures with `reasoning: true/false` and known IDs for `supportsXhigh` matching.

**Verify:** `npx vitest run test/actors/validate.test.ts`

### Step 4: Wire validation into `execute.ts`

**File:** `src/execute.ts`

Add `pi: ExtensionAPI` to the `ExecuteInput` interface (alongside the existing `ctx: ExtensionContext`).

After the existing actor discovery and filtering block, before `compile()`:

```typescript
const assistantThinking = pi.getThinkingLevel();
const validatedActors = validateActors(
  discovery.actors,
  ctx.modelRegistry,
  ctx.model,
  assistantThinking,
  (msg) => ctx.ui.notify(msg, "warning"),
);
```

Change the `actorsByName` map from `Map<ActorId, ActorConfig>` to `Map<ActorId, ValidatedActor>`.

The `actorRegistryFromDiscovery` call for the compiler still works on the raw `discovery` (it only needs actor names for `has` checks, not resolved models).

Pass `validatedActors`-based `actorsByName` to the `Scheduler`.

Update imports: add `validateActors`, `ValidatedActor` from `./actors/validate.js`; add `ExtensionAPI` from `@mariozechner/pi-coding-agent`.

**Verify:** `npx tsc --noEmit`

### Step 5: Update `pi-relay.ts` and `replay.ts` to pass `pi`

**File:** `src/pi-relay.ts`

The `executePlan` call at line 109 adds `pi`:

```typescript
return executePlan({ plan, discovery, signal, onUpdate, ctx, pi, toolName: "Relay" });
```

`pi` is already in scope — it's the parameter of the default export function.

**File:** `src/replay.ts`

The `registerReplayTool` function receives `pi` as its first argument (it already does). Inside the `execute` callback, pass it through:

```typescript
return executePlan({ plan: instantiation.value.plan, discovery: actorDiscovery, signal, onUpdate, ctx, pi, toolName: "Replay" });
```

`pi` is in scope via the closure.

**Verify:** `npx tsc --noEmit`

### Step 6: Update the scheduler to use `ValidatedActor`

**File:** `src/runtime/scheduler.ts`

Change the import from `ActorConfig` to `ValidatedActor` (from `../actors/types.js`). Update `SchedulerConfig.actorsByName` and the private field type. This is a find-and-replace of the type name — the scheduler reads `.name`, `.tools`, `.systemPrompt` from the actor, all of which exist on `ValidatedActor`.

The `ActionRequest.actor` field in `types.ts` also changes from `ActorConfig` to `ValidatedActor`.

**Verify:** `npx tsc --noEmit`

### Step 7: Simplify `sdk-engine.ts`

**File:** `src/actors/sdk-engine.ts`

1. Remove the `resolveModel` function (lines 257-278).

2. Remove `SdkEngineConfig.defaultModel` — the engine no longer needs a fallback model since validation handles it upstream.

3. In `runAction`, replace model resolution with a check on the pre-validated field:
   ```typescript
   // Before:
   const resolvedModel = resolveModel(actor.model, config);
   if (!resolvedModel) { ... engine_error ... }

   // After:
   if (!actor.resolvedModel) {
     return {
       kind: "engine_error",
       reason: actor.model
         ? `model "${actor.model}" not found or not authenticated in the model registry`
         : "no model configured for actor and no default model available",
       usage: emptyUsage(),
       transcript: [],
     };
   }
   ```
   The error messages match today's behavior exactly. The only difference is the model was already resolved (or not) during validation.

4. Replace thinking level fallback:
   ```typescript
   // Before:
   thinkingLevel: actor.thinking ?? "medium",

   // After:
   thinkingLevel: actor.thinking,
   ```

5. The `SdkEngineConfig` interface shrinks to just `{ readonly modelRegistry: ModelRegistry }` (still needed for `createAgentSession`).

6. Update `createSdkActorEngine` and `execute.ts` call site accordingly — remove the `defaultModel` argument.

**Verify:** `npx tsc --noEmit`

### Step 8: Update existing tests

**File:** `test/runtime/scheduler.test.ts`

Actor fixtures in scheduler tests need a `resolvedModel` field and a non-optional `thinking` field. Build a minimal model fixture:

```typescript
const fakeModel = {
  id: "test-model",
  name: "Test Model",
  reasoning: true,
  // ... other required Model<Api> fields
} as Model<Api>;
```

Add `resolvedModel: fakeModel` and `thinking: "medium"` to each actor fixture.

**Files:** `test/index.smoke.test.ts`, `test/replay.test.ts`, `test/index.confirmation.test.ts`, `test/index.description.test.ts`

These tests mock the extension context. If they construct `ActorConfig` objects that flow into `executePlan`, they need updating. If they only test tool registration / descriptions (which use raw `ActorConfig`), they're unaffected.

Check each test file for `ActorConfig` construction and update as needed. Add `pi.getThinkingLevel` mock where `pi` is mocked.

**Verify:** `npx vitest run`

### Step 9: Update `summarizePlanImpact` in `execute.ts`

**File:** `src/execute.ts`

The `summarizePlanImpact` function (line 208) takes `actorsByName: ReadonlyMap<..., ActorConfig>`. Change to `ValidatedActor`. The function only reads `.tools`, so this is a type-only change.

**Verify:** `npx vitest run` — full test suite.

### Step 10: Verify end-to-end

Run the full build and test suite:

```
npm run build
npx vitest run
```

Test manually if possible: create an actor with `thinking: xhigh` and a model that doesn't support it. Confirm the warning appears in the TUI.

## Dependency graph

```
Step 1 (type)
  ↓
Step 2 (validate.ts) → Step 3 (tests)
  ↓
Step 4 (execute.ts) + Step 5 (pi-relay.ts, replay.ts)
  ↓
Step 6 (scheduler.ts) + Step 7 (sdk-engine.ts)
  ↓
Step 8 (test updates) + Step 9 (plan impact)
  ↓
Step 10 (verify)
```

Steps 4+5 can be done together. Steps 6+7 can be done together. Steps 8+9 can be done together.

## Code style

Match pi-relay's existing conventions, which are closely aligned with pi-mono:

- **Module-level JSDoc** on every file describing purpose and responsibilities.
- **`const` arrow functions** for top-level functions (pi-relay's convention — pi-mono uses `function` declarations, but pi-relay is internally consistent).
- **Section divider comments** (`// ====...`) to organize modules by responsibility.
- **`readonly` on all interface fields.** No mutable interfaces in public APIs.
- **`import type`** for type-only imports, separated from value imports.
- **Named exports only.** No default exports except the extension entry point.
- **Descriptive names, no abbreviations.** `findModel` not `findMdl`, `effectiveThinking` not `effThink`.
- **JSDoc on exported functions** with parameter/return descriptions when the types alone don't tell the full story.
- **Tests use `describe`/`it`** with behavior descriptions. Test names read as sentences.

## Risks and mitigations

1. **`Model<Api>` fixture construction in tests.** The `Model` type from pi-ai has many required fields (cost, contextWindow, maxTokens, etc.). Mitigation: build one shared fixture in a test helper and `as Model<Api>` cast it. Only the fields validation reads (`id`, `reasoning`) need real values.

2. **`resolveModel` split into `findModel`.** The registry lookup logic is extracted from `resolveModel` into `findModel`, which returns `Model<Api> | undefined`. The fallback-to-default logic moves into `validateActors` as plain control flow. The internal lookup (provider/id split, exact match, partial match) is unchanged. Mitigation: `findModel` tests verify every lookup path.

3. **`pi` threading through `ExecuteInput`.** Both call sites already have `pi` in scope, but it's a new field on `ExecuteInput`. If other callers exist (tests that call `executePlan` directly), they need updating. Mitigation: check all call sites in step 5.
