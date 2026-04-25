import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { ValidatedActor } from "../src/actors/types.js";
import { buildSelectTitle, summarizePlanImpact } from "../src/execute.js";
import type { PlanDraftDoc } from "../src/plan/draft.js";
import { ActorId } from "../src/plan/ids.js";

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

const actor = (name: string, tools?: string[]): ValidatedActor => ({
	name,
	description: `${name} actor`,
	tools,
	source: "user",
	systemPrompt: "",
	filePath: `/tmp/${name}.md`,
	resolvedModel: fakeModel,
	thinking: "medium",
});

const registry = new Map<ReturnType<typeof ActorId>, ValidatedActor>([
	[ActorId("worker"), actor("worker", ["read", "edit", "write", "bash"])],
	[ActorId("planner"), actor("planner", ["read", "grep", "find", "ls"])],
	[ActorId("reviewer"), actor("reviewer", ["read", "grep", "find", "ls", "bash"])],
]);

const readOnlyPlan: PlanDraftDoc = {
	task: "Describe what the parser does.",
	artifacts: [{ name: "summary", description: "analysis" }],
	steps: [
		{
			type: "action",
			name: "analyze",
			actor: "planner",
			instruction: "Read the parser and describe its responsibilities.",
			reads: [],
			writes: ["summary"],
			routes: { done: "end" },
		},
		{ type: "terminal", name: "end", outcome: "success", summary: "described" },
	],
	entry_step: "analyze",
};

const mutatingPlan: PlanDraftDoc = {
	task: "Add a feature flag and verify the tests pass.",
	success_criteria: "Tests green after the change.",
	artifacts: [{ name: "notes", description: "n" }],
	steps: [
		{
			type: "action",
			name: "implement",
			actor: "worker",
			instruction: "Add the flag.",
			reads: [],
			writes: ["notes"],
			routes: { done: "verify" },
		},
		{
			type: "command",
			name: "verify",
			command: "npm test",
			on_success: "end",
			on_failure: "bad",
		},
		{ type: "terminal", name: "end", outcome: "success", summary: "ok" },
		{ type: "terminal", name: "bad", outcome: "failure", summary: "bad" },
	],
	entry_step: "implement",
};

describe("summarizePlanImpact", () => {
	it("marks a read-only plan as non-mutating", () => {
		const impact = summarizePlanImpact(readOnlyPlan, registry);
		expect(impact.mayEdit).toBe(false);
		expect(impact.mayRunCommands).toBe(false);
		expect(impact.actionStepCount).toBe(1);
		expect(impact.terminalStepCount).toBe(1);
		expect(impact.uniqueActors).toEqual(["planner"]);
		expect(impact.artifactCount).toBe(1);
	});

	it("flags mayEdit when an actor has edit/write tools", () => {
		const impact = summarizePlanImpact(mutatingPlan, registry);
		expect(impact.mayEdit).toBe(true);
	});

	it("flags mayRunCommands when an actor has bash or a check runs a command", () => {
		const impact = summarizePlanImpact(mutatingPlan, registry);
		expect(impact.mayRunCommands).toBe(true);
		expect(impact.commandChecks).toEqual(["npm test"]);
	});

	it("reports unknown actors rather than silently failing", () => {
		const firstStep = readOnlyPlan.steps[0]!;
		if (firstStep.type !== "action") throw new Error("expected action");
		const bad: PlanDraftDoc = {
			...readOnlyPlan,
			steps: [{ ...firstStep, actor: "ghost-actor" }, readOnlyPlan.steps[1]!],
		};
		const impact = summarizePlanImpact(bad, registry);
		expect(impact.unknownActors).toEqual(["ghost-actor"]);
	});
});

describe("buildSelectTitle", () => {
	it("fits on a single line with the step count and impact tags", () => {
		const impact = summarizePlanImpact(mutatingPlan, registry);
		const title = buildSelectTitle(mutatingPlan, impact);
		expect(title.split("\n").length).toBe(1);
		expect(title).toContain("Relay plan");
		expect(title).toContain("4 steps");
		expect(title).toContain("may edit files");
		expect(title).toContain("runs shell");
		expect(title).toContain("check: npm test");
	});

	it("labels read-only plans with the read-only tag only", () => {
		const impact = summarizePlanImpact(readOnlyPlan, registry);
		const title = buildSelectTitle(readOnlyPlan, impact);
		expect(title).toContain("2 steps");
		expect(title).toContain("read-only");
		expect(title).not.toContain("may edit");
		expect(title).not.toContain("runs shell");
	});

	it("shortens multiple check commands with a count suffix", () => {
		const planWithMultipleChecks: PlanDraftDoc = {
			...mutatingPlan,
			steps: [
				mutatingPlan.steps[0]!,
				{
					type: "command",
					name: "verify",
					command: "npm test",
					on_success: "step2",
					on_failure: "bad",
				},
				{
					type: "command",
					name: "step2",
					command: "npm run lint",
					on_success: "end",
					on_failure: "bad",
				},
				{ type: "terminal", name: "end", outcome: "success", summary: "ok" },
				{ type: "terminal", name: "bad", outcome: "failure", summary: "bad" },
			],
		};
		const impact = summarizePlanImpact(planWithMultipleChecks, registry);
		const title = buildSelectTitle(planWithMultipleChecks, impact);
		expect(title).toContain("check: npm test (+1)");
	});

	it("surfaces unknown actors with a leading warning", () => {
		const firstStep = readOnlyPlan.steps[0]!;
		if (firstStep.type !== "action") throw new Error("expected action");
		const bad: PlanDraftDoc = {
			...readOnlyPlan,
			steps: [{ ...firstStep, actor: "ghost-actor" }, readOnlyPlan.steps[1]!],
		};
		const impact = summarizePlanImpact(bad, registry);
		const title = buildSelectTitle(bad, impact);
		expect(title).toContain("⚠ unknown actors: ghost-actor");
	});
});
