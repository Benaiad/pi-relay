import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { ActorConfig, ThinkingLevel } from "../../src/actors/types.js";
import { findModel, validateActors } from "../../src/actors/validate.js";

// ============================================================================
// Test fixtures
// ============================================================================

const model = (id: string, reasoning: boolean): Model<Api> =>
	({
		id,
		name: id,
		reasoning,
		provider: "test",
		baseUrl: "https://test",
		api: "openai-completions",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	}) as Model<Api>;

const reasoningModel = model("claude-sonnet-4-5", true);
const nonReasoningModel = model("gemini-2.0-flash", false);
const xhighModel = model("claude-opus-4-6", true);

const actor = (overrides: Partial<ActorConfig> = {}): ActorConfig => ({
	name: "worker",
	description: "Test actor",
	systemPrompt: "",
	source: "user",
	filePath: "/tmp/worker.md",
	...overrides,
});

const registry = (models: Model<Api>[]): ModelRegistry => {
	const map = new Map(models.map((m) => [`${m.provider}/${m.id}`, m]));
	return {
		getAvailable: () => models,
		find: (provider: string, modelId: string) => map.get(`${provider}/${modelId}`),
	} as ModelRegistry;
};

// ============================================================================
// findModel
// ============================================================================

describe("findModel", () => {
	const reg = registry([reasoningModel, nonReasoningModel, xhighModel]);

	it("finds a model by exact ID", () => {
		expect(findModel("claude-sonnet-4-5", reg)).toBe(reasoningModel);
	});

	it("finds a model by partial match", () => {
		expect(findModel("sonnet", reg)).toBe(reasoningModel);
	});

	it("finds a model by provider/id format", () => {
		expect(findModel("test/claude-sonnet-4-5", reg)).toBe(reasoningModel);
	});

	it("returns undefined when no model matches", () => {
		expect(findModel("nonexistent-model", reg)).toBeUndefined();
	});

	it("is case-insensitive", () => {
		expect(findModel("Claude-Sonnet-4-5", reg)).toBe(reasoningModel);
	});
});

// ============================================================================
// validateActors
// ============================================================================

describe("validateActors", () => {
	const reg = registry([reasoningModel, nonReasoningModel, xhighModel]);
	const assistantThinking: ThinkingLevel = "medium";

	it("inherits the default model and assistant thinking level when actor specifies neither", () => {
		const notify = vi.fn();
		const result = validateActors([actor()], reg, reasoningModel, assistantThinking, notify);

		expect(result).toHaveLength(1);
		expect(result[0]!.resolvedModel).toBe(reasoningModel);
		expect(result[0]!.thinking).toBe("medium");
		expect(notify).not.toHaveBeenCalled();
	});

	it("uses the actor's explicit thinking level over the assistant's", () => {
		const notify = vi.fn();
		const result = validateActors([actor({ thinking: "high" })], reg, reasoningModel, "low", notify);

		expect(result[0]!.thinking).toBe("high");
		expect(notify).not.toHaveBeenCalled();
	});

	it("resolves a model specified by the actor", () => {
		const notify = vi.fn();
		const result = validateActors(
			[actor({ model: "claude-sonnet-4-5" })],
			reg,
			xhighModel,
			assistantThinking,
			notify,
		);

		expect(result[0]!.resolvedModel).toBe(reasoningModel);
		expect(notify).not.toHaveBeenCalled();
	});

	it("falls back to the default model and warns when the actor's model is not found", () => {
		const notify = vi.fn();
		const result = validateActors(
			[actor({ model: "openai/gpt-5.2" })],
			reg,
			reasoningModel,
			assistantThinking,
			notify,
		);

		expect(result[0]!.resolvedModel).toBe(reasoningModel);
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("model 'openai/gpt-5.2' not available (provider not configured)"),
		);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Using assistant's model"));
	});

	it("sets resolvedModel to undefined and warns when no model is available at all", () => {
		const notify = vi.fn();
		const result = validateActors([actor({ model: "nonexistent" })], reg, undefined, assistantThinking, notify);

		expect(result).toHaveLength(1);
		expect(result[0]!.resolvedModel).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("no fallback model"));
	});

	it("clamps thinking to 'off' on a non-reasoning model with explicit thinking", () => {
		const notify = vi.fn();
		const result = validateActors(
			[actor({ model: "gemini-2.0-flash", thinking: "high" })],
			reg,
			reasoningModel,
			assistantThinking,
			notify,
		);

		expect(result[0]!.resolvedModel).toBe(nonReasoningModel);
		expect(result[0]!.thinking).toBe("off");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("does not support thinking"));
	});

	it("clamps thinking to 'off' on a non-reasoning model with inherited thinking", () => {
		const notify = vi.fn();
		const result = validateActors([actor({ model: "gemini-2.0-flash" })], reg, reasoningModel, "high", notify);

		expect(result[0]!.thinking).toBe("off");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("does not support thinking"));
	});

	it("keeps 'off' on a non-reasoning model without warning", () => {
		const notify = vi.fn();
		const result = validateActors(
			[actor({ model: "gemini-2.0-flash", thinking: "off" })],
			reg,
			reasoningModel,
			assistantThinking,
			notify,
		);

		expect(result[0]!.thinking).toBe("off");
		expect(notify).not.toHaveBeenCalled();
	});

	it("clamps 'xhigh' to 'high' on a model without xhigh support", () => {
		const notify = vi.fn();
		const result = validateActors(
			[actor({ model: "claude-sonnet-4-5", thinking: "xhigh" })],
			reg,
			reasoningModel,
			assistantThinking,
			notify,
		);

		expect(result[0]!.thinking).toBe("high");
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("supports up to 'high' thinking"));
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Clamped from 'xhigh' to 'high'"));
	});

	it("keeps 'xhigh' on a model that supports it", () => {
		const notify = vi.fn();
		const result = validateActors(
			[actor({ model: "claude-opus-4-6", thinking: "xhigh" })],
			reg,
			reasoningModel,
			assistantThinking,
			notify,
		);

		expect(result[0]!.thinking).toBe("xhigh");
		expect(notify).not.toHaveBeenCalled();
	});

	it("preserves thinking without capability check when no model is available", () => {
		const notify = vi.fn();
		const result = validateActors(
			[actor({ model: "nonexistent", thinking: "xhigh" })],
			reg,
			undefined,
			assistantThinking,
			notify,
		);

		expect(result[0]!.resolvedModel).toBeUndefined();
		expect(result[0]!.thinking).toBe("xhigh");
		// Should warn about the missing model, but not about thinking
		const calls = notify.mock.calls.map((c) => c[0] as string);
		expect(calls.some((c) => c.includes("no fallback model"))).toBe(true);
		expect(calls.some((c) => c.includes("does not support thinking"))).toBe(false);
	});

	it("validates multiple actors independently with correct warnings for each", () => {
		const notify = vi.fn();
		const actors = [
			actor({ name: "worker", model: "claude-sonnet-4-5", thinking: "high" }),
			actor({ name: "judge", model: "gemini-2.0-flash", thinking: "high" }),
			actor({ name: "critic", model: "claude-opus-4-6", thinking: "xhigh" }),
		];
		const result = validateActors(actors, reg, reasoningModel, assistantThinking, notify);

		expect(result).toHaveLength(3);

		// worker: reasoning model, high — no warnings
		expect(result[0]!.resolvedModel).toBe(reasoningModel);
		expect(result[0]!.thinking).toBe("high");

		// judge: non-reasoning, high → clamped to off
		expect(result[1]!.resolvedModel).toBe(nonReasoningModel);
		expect(result[1]!.thinking).toBe("off");

		// critic: xhigh-capable, xhigh — no warnings
		expect(result[2]!.resolvedModel).toBe(xhighModel);
		expect(result[2]!.thinking).toBe("xhigh");

		// Only one warning: judge's thinking clamped
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Actor 'judge'"));
	});

	it("preserves all original ActorConfig fields on the validated actor", () => {
		const notify = vi.fn();
		const original = actor({
			name: "custom",
			description: "Custom actor",
			tools: ["read", "edit"],
			model: "claude-sonnet-4-5",
			thinking: "high",
			systemPrompt: "You are a reviewer.",
			source: "project",
			filePath: "/repo/.pi/pi-relay/actors/custom.md",
		});
		const result = validateActors([original], reg, reasoningModel, assistantThinking, notify);
		const validated = result[0]!;

		expect(validated.name).toBe("custom");
		expect(validated.description).toBe("Custom actor");
		expect(validated.tools).toEqual(["read", "edit"]);
		expect(validated.model).toBe("claude-sonnet-4-5");
		expect(validated.systemPrompt).toBe("You are a reviewer.");
		expect(validated.source).toBe("project");
		expect(validated.filePath).toBe("/repo/.pi/pi-relay/actors/custom.md");
	});
});
