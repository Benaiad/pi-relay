# Actor Model and Thinking Validation

## Problem

An actor `.md` file can declare a `model` and a `thinking` level, but pi-relay never checks whether these are compatible with the runtime environment. Three things can go wrong silently:

1. **Model provider not configured.** The actor specifies `model: openai/gpt-5.2` but the user has no `OPENAI_API_KEY` and no OAuth for OpenAI. Pi's `createAgentSession` receives the resolved model from the registry, but if the actor's model string doesn't resolve, pi-relay already falls back to the assistant's model — silently. The actor author doesn't know their model choice was ignored.

2. **Thinking level exceeds model capability.** The actor sets `thinking: xhigh` but the resolved model only supports up to `high`. Pi's session layer clamps `xhigh` down to `high` internally, but pi-relay never tells the user or the outer model that the actor is running at a lower thinking level than declared.

3. **Thinking on a non-reasoning model.** The actor sets `thinking: high` but the resolved model has `reasoning: false`. Pi's session layer forces thinking to `off`. The actor runs without any reasoning, contrary to what the actor file says.

All three cases degrade silently. The actor author designed the actor with certain capabilities in mind. When those capabilities are unavailable, the right behavior is to warn — not to pretend everything is fine.

## Design

### When validation runs

Validation runs at **tool execution time**, inside the `execute` callback of both the `relay` and `replay` tools. This is the earliest point where `ExtensionContext` is available, which provides:

- `ctx.modelRegistry` — the full model registry with provider auth status
- `ctx.model` — the assistant's current model (the fallback)
- `ctx.ui.notify()` — the notification channel

The assistant's current thinking level comes from `pi.getThinkingLevel()` on the `ExtensionAPI` object. Although `pi` is available at load time, `getThinkingLevel()` is called at tool execution time — the user can change their thinking level between invocations, so the value must be read fresh on each call. The `pi` object is in scope inside the `execute` closure.

Validation happens **after actor discovery and filtering, before plan compilation**. Each actor in the discovered set is validated once per tool invocation. The validated actors (with any adjustments applied) are what the plan compiler and scheduler see.

### What is validated

For each discovered actor:

1. **Resolve the model.** Use the existing `resolveModel` logic. If the actor has no `model` field, it inherits the assistant's model — no warning needed.

2. **Check model availability.** If the actor specifies a `model` but resolution falls back to the default model (because the specified model wasn't found or its provider isn't authenticated), emit a warning and proceed with the fallback.

3. **Resolve the effective thinking level.** If the actor declares a `thinking` level, use it. If not, inherit the assistant's current thinking level via `pi.getThinkingLevel()`. This replaces the previous hardcoded `"medium"` default — actors without an explicit thinking level match whatever the user has configured for their session.

4. **Check reasoning support.** If the resolved model has `reasoning: false` and the effective thinking level is anything other than `"off"`, emit a warning and override to `"off"`.

5. **Check xhigh support.** If the resolved model has `reasoning: true` but `supportsXhigh(model)` returns `false`, and the effective thinking level is `"xhigh"`, emit a warning and clamp to `"high"`.

### Warning messages

Warnings use `ctx.ui.notify(message, "warning")`. Each warning is a single sentence identifying the actor, the problem, and the resolution:

- **Model not available:** `Actor '<name>': model '<model>' not available (provider not configured). Using assistant's model.`
- **Thinking on non-reasoning model:** `Actor '<name>': model '<resolved>' does not support thinking. Thinking level set to 'off'.`
- **xhigh clamped:** `Actor '<name>': model '<resolved>' supports up to 'high' thinking. Clamped from 'xhigh' to 'high'.`

### Data flow

The validation step produces a list of `ValidatedActor` values — the original `ActorConfig` with a resolved model and an adjusted thinking level. The rest of the pipeline (plan compilation, scheduler, SDK engine) consumes `ValidatedActor` instead of raw `ActorConfig`.

```
Actor discovery → ActorConfig[]
                       ↓
Validation (needs ExtensionContext + ExtensionAPI)
                       ↓
               ValidatedActor[] + warnings emitted via ctx.ui.notify()
                       ↓
Plan compilation, scheduling, execution
```

`ValidatedActor` carries the same shape as `ActorConfig` but adds an optional `resolvedModel` reference and a guaranteed (non-optional) `thinking` level.

`resolvedModel` is `Model<Api> | undefined` — not guaranteed. When no model is available at all (actor specified an unknown model and no assistant model exists), the actor stays in the validated set with `resolvedModel: undefined`. The SDK engine preserves its existing error path for this case: it returns an `engine_error` outcome at step execution time. This avoids a subtle inconsistency — if validation excluded modelless actors, the compiler's actor registry (built from raw discovery) would still list them, and the plan would compile successfully only to fail at runtime with a confusing "actor not found" scheduler error.

### Where the logic lives

A new module `src/actors/validate.ts` owns the validation function:

```
validateActors(
  actors,
  modelRegistry,
  defaultModel,
  assistantThinkingLevel,
  notify
) → ValidatedActor[]
```

The `assistantThinkingLevel` parameter comes from `pi.getThinkingLevel()` at the call site. The function is pure aside from calling `notify` for side effects. It does not read from disk, does not depend on `ExtensionContext` or `ExtensionAPI` directly (receives the pieces it needs as arguments), and is independently testable.

`execute.ts` calls `validateActors` after discovery/filtering and before passing actors to the compiler and scheduler.

### What changes in the SDK engine

The SDK engine currently resolves the model from a string and defaults thinking to `"medium"`. With validation upstream:

- The engine receives a `ValidatedActor` with a pre-resolved model and a validated thinking level.
- Model resolution moves from `sdk-engine.ts` into `validate.ts`.
- When `resolvedModel` is defined, the engine uses it directly — no resolution needed.
- When `resolvedModel` is undefined, the engine returns its existing `engine_error` outcome. The error messages are the same as today.
- The `actor.thinking ?? "medium"` fallback in `createAgentSession` is replaced by the validated thinking level from `ValidatedActor`. The hardcoded `"medium"` default is eliminated — actors without an explicit thinking level inherit the assistant's current thinking level, which is resolved and capability-checked during validation.

### Dependency

`supportsXhigh` is imported from `@mariozechner/pi-ai`. pi-relay already depends on this package (used in `sdk-engine.ts` for `Model` and `Api` types).

## What this does NOT cover

- **Changing pi-mono.** No exports are added or modified in pi's packages. The validation uses what is already public: `Model.reasoning`, `supportsXhigh()`, `ModelRegistry.getAvailable()`.
- **Blocking execution.** Validation produces warnings, not errors. An actor with a degraded model or clamped thinking level still runs. The user is informed; execution is not halted.
- **Persisting validation results.** Warnings are transient `notify()` calls. They are not written to disk or stored in the session.
- **Validating at extension load time.** The model registry is not available then. If this changes in pi's extension API, validation could be lifted earlier, but the current design does not depend on it.
- **Validating thinking levels other than xhigh.** The only granular capability check pi exports is `supportsXhigh()`. There is no `supportsHigh()` or `supportsLevel(model, level)` function. If pi adds finer-grained checks, the validation can be extended. For now, the checks are: reasoning yes/no, and xhigh yes/no.
- **Changes to the actor `.md` format.** No new frontmatter fields. The existing `model` and `thinking` fields are validated, not extended.
