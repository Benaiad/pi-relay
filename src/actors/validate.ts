/**
 * Actor model and thinking level validation.
 *
 * Validates each discovered actor's model availability and thinking level
 * compatibility before plan compilation. Produces a `ValidatedActor` for
 * every input actor — none are excluded. When an actor's declared model
 * is unavailable or its thinking level exceeds the resolved model's
 * capabilities, the validator emits a warning and adjusts the value.
 *
 * This module is intentionally decoupled from the extension API. It receives
 * its dependencies as arguments (model registry, default model, thinking
 * level, notify callback) so it can be tested without mocking pi internals.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { supportsXhigh } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { ActorConfig, ThinkingLevel, ValidatedActor } from "./types.js";

// ============================================================================
// Public API
// ============================================================================

/**
 * Validate an array of discovered actors against the runtime model registry.
 *
 * For each actor, resolves the model, defaults the thinking level from the
 * assistant's session, and clamps it to the model's capabilities. Emits
 * warnings via `notify` for any adjustments made.
 *
 * Every input actor produces exactly one output `ValidatedActor` — actors
 * are never excluded, even when no model is available. The SDK engine
 * handles the `resolvedModel: undefined` case with its existing error path.
 */
export const validateActors = (
	actors: readonly ActorConfig[],
	modelRegistry: ModelRegistry,
	defaultModel: Model<Api> | undefined,
	assistantThinkingLevel: ThinkingLevel,
	notify: (message: string) => void,
): ValidatedActor[] =>
	actors.map((actor) => validateActor(actor, modelRegistry, defaultModel, assistantThinkingLevel, notify));

// ============================================================================
// Per-actor validation
// ============================================================================

const validateActor = (
	actor: ActorConfig,
	modelRegistry: ModelRegistry,
	defaultModel: Model<Api> | undefined,
	assistantThinkingLevel: ThinkingLevel,
	notify: (message: string) => void,
): ValidatedActor => {
	const resolvedModel = resolveActorModel(actor, modelRegistry, defaultModel, notify);
	const thinking = resolveThinkingLevel(actor, resolvedModel, assistantThinkingLevel, notify);
	return { ...actor, resolvedModel, thinking };
};

// ============================================================================
// Model resolution
// ============================================================================

/**
 * Resolve an actor's declared model string to a `Model` object.
 *
 * When the actor has no model string, the assistant's current model is used
 * silently. When the actor specifies a model that cannot be found in the
 * registry (provider not configured, model ID unknown), falls back to the
 * assistant's model and emits a warning. When no model is available at all,
 * emits a warning and returns `undefined`.
 */
const resolveActorModel = (
	actor: ActorConfig,
	modelRegistry: ModelRegistry,
	defaultModel: Model<Api> | undefined,
	notify: (message: string) => void,
): Model<Api> | undefined => {
	if (!actor.model) return defaultModel;

	const found = findModel(actor.model, modelRegistry);
	if (found) return found;

	if (defaultModel) {
		notify(
			`Actor '${actor.name}': model '${actor.model}' not available (provider not configured). Using assistant's model.`,
		);
		return defaultModel;
	}

	notify(`Actor '${actor.name}': model '${actor.model}' not available and no fallback model. Will fail at runtime.`);
	return undefined;
};

/**
 * Look up a model string in the registry without any fallback.
 *
 * Supports two formats:
 *   - `"provider/modelId"` — resolved via `modelRegistry.find()`
 *   - bare model id — matched by exact ID, then by substring in ID or name
 *
 * Returns `undefined` when the model cannot be found.
 *
 * @internal Exported for testing.
 */
export const findModel = (modelString: string, modelRegistry: ModelRegistry): Model<Api> | undefined => {
	const slashIndex = modelString.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelString.substring(0, slashIndex);
		const modelId = modelString.substring(slashIndex + 1);
		const match = modelRegistry.find(provider, modelId);
		if (match) return match;
	}

	const available = modelRegistry.getAvailable();
	const lower = modelString.toLowerCase();

	const byId = available.find((m) => m.id.toLowerCase() === lower);
	if (byId) return byId;

	return available.find((m) => m.id.toLowerCase().includes(lower) || (m.name?.toLowerCase().includes(lower) ?? false));
};

// ============================================================================
// Thinking level resolution
// ============================================================================

/**
 * Determine the effective thinking level for an actor.
 *
 * If the actor declares a thinking level, use it. Otherwise, inherit the
 * assistant's current thinking level. Then clamp to the resolved model's
 * capabilities: non-reasoning models force `"off"`, and models without
 * xhigh support clamp `"xhigh"` to `"high"`.
 */
const resolveThinkingLevel = (
	actor: ActorConfig,
	resolvedModel: Model<Api> | undefined,
	assistantThinkingLevel: ThinkingLevel,
	notify: (message: string) => void,
): ThinkingLevel => {
	let effective = actor.thinking ?? assistantThinkingLevel;

	if (!resolvedModel) return effective;

	if (!resolvedModel.reasoning && effective !== "off") {
		notify(
			`Actor '${actor.name}': model '${resolvedModel.id}' does not support thinking. Thinking level set to 'off'.`,
		);
		effective = "off";
	} else if (resolvedModel.reasoning && effective === "xhigh" && !supportsXhigh(resolvedModel)) {
		notify(
			`Actor '${actor.name}': model '${resolvedModel.id}' supports up to 'high' thinking. Clamped from 'xhigh' to 'high'.`,
		);
		effective = "high";
	}

	return effective;
};
