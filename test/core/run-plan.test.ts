import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { ActionOutcome, ActionRequest, ActorEngine, ValidatedActor } from "../../src/actors/types.js";
import { emptyUsage } from "../../src/actors/types.js";
import { type RunPlanProgress, runPlan } from "../../src/core/run-plan.js";
import { type ActorRegistry, compile } from "../../src/plan/compile.js";
import type { PlanDraftDoc } from "../../src/plan/draft.js";
import { ActorId, ArtifactId, RouteId, unwrap } from "../../src/plan/ids.js";
import { isOk } from "../../src/plan/result.js";

const actorRegistry: ActorRegistry = {
	has: (id) => unwrap(id) === "worker",
	names: () => [ActorId("worker")],
};

const fakeModel = {
	id: "test-model",
	name: "Test Model",
	reasoning: true,
	provider: "test",
	baseUrl: "https://test",
	api: "openai-completions",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 4096,
} as Model<Api>;

const fakeModelRegistry = {
	getAll: () => [fakeModel],
	getAvailable: () => [fakeModel],
	find: () => fakeModel,
	hasConfiguredAuth: () => true,
	getApiKeyAndHeaders: async () => ({ apiKey: "test", headers: {} }),
	registerProvider: () => {},
} as never;

const workerActor: ValidatedActor = {
	name: "worker",
	description: "Test worker",
	systemPrompt: "",
	source: "user",
	filePath: "/tmp/worker.md",
	resolvedModel: fakeModel,
	thinking: "off",
};

const actorsByName = new Map([[ActorId("worker"), workerActor]]);

const simplePlan: PlanDraftDoc = {
	task: "Test task",
	steps: [
		{
			type: "action",
			name: "implement",
			actor: "worker",
			instruction: "Do the thing",
			routes: { done: "verify" },
			writes: ["notes"],
		},
		{
			type: "command",
			name: "verify",
			command: "true",
			on_success: "done",
			on_failure: "failed",
		},
		{ type: "terminal", name: "done", outcome: "success", summary: "Done." },
		{ type: "terminal", name: "failed", outcome: "failure", summary: "Failed." },
	],
	artifacts: [{ name: "notes", description: "Change notes" }],
};

const completingEngine = (route: string, writes: Record<string, unknown> = {}): ActorEngine => ({
	async runAction(_request: ActionRequest): Promise<ActionOutcome> {
		const writeMap = new Map<ReturnType<typeof ArtifactId>, unknown>();
		for (const [k, v] of Object.entries(writes)) writeMap.set(ArtifactId(k), v);
		return {
			kind: "completed",
			route: RouteId(route),
			assistant_summary: "Completed.",
			writes: writeMap,
			usage: { ...emptyUsage(), turns: 1, cost: 0.01 },
			transcript: [],
		};
	},
});

describe("runPlan", () => {
	it("runs a plan to success", async () => {
		const compileResult = compile(simplePlan, actorRegistry);
		expect(isOk(compileResult)).toBe(true);
		if (!isOk(compileResult)) return;

		const result = await runPlan({
			program: compileResult.value,
			actorsByName,
			modelRegistry: fakeModelRegistry,
			cwd: process.cwd(),
			actorEngine: completingEngine("done", { notes: "Changed stuff" }),
		});

		expect(result.report.outcome).toBe("success");
		expect(result.state.phase).toBe("succeeded");
	});

	it("runs a plan to failure when command fails", async () => {
		const failPlan: PlanDraftDoc = {
			...simplePlan,
			steps: [
				{
					type: "action",
					name: "implement",
					actor: "worker",
					instruction: "Do the thing",
					routes: { done: "verify" },
					writes: ["notes"],
				},
				{
					type: "command",
					name: "verify",
					command: "false",
					on_success: "done",
					on_failure: "failed",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "Done." },
				{ type: "terminal", name: "failed", outcome: "failure", summary: "Failed." },
			],
		};

		const compileResult = compile(failPlan, actorRegistry);
		expect(isOk(compileResult)).toBe(true);
		if (!isOk(compileResult)) return;

		const result = await runPlan({
			program: compileResult.value,
			actorsByName,
			modelRegistry: fakeModelRegistry,
			cwd: process.cwd(),
			actorEngine: completingEngine("done", { notes: "Changed stuff" }),
		});

		expect(result.report.outcome).toBe("failure");
		expect(result.state.phase).toBe("failed");
	});

	it("fires onProgress for each scheduler event", async () => {
		const compileResult = compile(simplePlan, actorRegistry);
		expect(isOk(compileResult)).toBe(true);
		if (!isOk(compileResult)) return;

		const events: RunPlanProgress[] = [];
		const result = await runPlan({
			program: compileResult.value,
			actorsByName,
			modelRegistry: fakeModelRegistry,
			cwd: process.cwd(),
			actorEngine: completingEngine("done", { notes: "Changed stuff" }),
			onProgress: (progress) => events.push(progress),
		});

		expect(events.length).toBeGreaterThan(0);
		expect(result.report.outcome).toBe("success");

		const eventTypes = events.map((e) => e.event.type);
		expect(eventTypes).toContain("run_started");
		expect(eventTypes).toContain("step_started");
		expect(eventTypes).toContain("run_finished");
	});

	it("respects abort signal", async () => {
		const compileResult = compile(simplePlan, actorRegistry);
		expect(isOk(compileResult)).toBe(true);
		if (!isOk(compileResult)) return;

		const controller = new AbortController();
		controller.abort();

		const result = await runPlan({
			program: compileResult.value,
			actorsByName,
			modelRegistry: fakeModelRegistry,
			cwd: process.cwd(),
			signal: controller.signal,
			actorEngine: completingEngine("done"),
		});

		expect(result.state.phase).toBe("aborted");
	});
});
