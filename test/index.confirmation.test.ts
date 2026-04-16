import { describe, expect, it } from "vitest";
import type { ActorConfig } from "../src/actors/types.js";
import { buildSelectTitle, summarizePlanImpact } from "../src/execute.js";
import type { PlanDraftDoc } from "../src/plan/draft.js";
import { ActorId } from "../src/plan/ids.js";

const actor = (name: string, tools?: string[]): ActorConfig => ({
	name,
	description: `${name} actor`,
	tools,
	source: "user",
	systemPrompt: "",
	filePath: `/tmp/${name}.md`,
});

const registry = new Map<ReturnType<typeof ActorId>, ActorConfig>([
	[ActorId("worker"), actor("worker", ["read", "edit", "write", "bash"])],
	[ActorId("planner"), actor("planner", ["read", "grep", "find", "ls"])],
	[ActorId("reviewer"), actor("reviewer", ["read", "grep", "find", "ls", "bash"])],
]);

const readOnlyPlan: PlanDraftDoc = {
	task: "Describe what the parser does.",
	artifacts: [{ id: "summary", description: "analysis", shape: { kind: "untyped_json" } }],
	steps: [
		{
			kind: "action",
			id: "analyze",
			actor: "planner",
			instruction: "Read the parser and describe its responsibilities.",
			reads: [],
			writes: ["summary"],
			routes: [{ route: "done", to: "end" }],
		},
		{ kind: "terminal", id: "end", outcome: "success", summary: "described" },
	],
	entryStep: "analyze",
};

const mutatingPlan: PlanDraftDoc = {
	task: "Add a feature flag and verify the tests pass.",
	successCriteria: "Tests green after the change.",
	artifacts: [{ id: "notes", description: "n", shape: { kind: "untyped_json" } }],
	steps: [
		{
			kind: "action",
			id: "implement",
			actor: "worker",
			instruction: "Add the flag.",
			reads: [],
			writes: ["notes"],
			routes: [{ route: "done", to: "verify" }],
		},
		{
			kind: "check",
			id: "verify",
			check: { kind: "command_exits_zero", command: "npm", args: ["test"] },
			onPass: "end",
			onFail: "bad",
		},
		{ kind: "terminal", id: "end", outcome: "success", summary: "ok" },
		{ kind: "terminal", id: "bad", outcome: "failure", summary: "bad" },
	],
	entryStep: "implement",
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
		if (firstStep.kind !== "action") throw new Error("expected action");
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
					kind: "check",
					id: "verify",
					check: { kind: "command_exits_zero", command: "npm", args: ["test"] },
					onPass: "step2",
					onFail: "bad",
				},
				{
					kind: "check",
					id: "step2",
					check: { kind: "command_exits_zero", command: "npm", args: ["run", "lint"] },
					onPass: "end",
					onFail: "bad",
				},
				{ kind: "terminal", id: "end", outcome: "success", summary: "ok" },
				{ kind: "terminal", id: "bad", outcome: "failure", summary: "bad" },
			],
		};
		const impact = summarizePlanImpact(planWithMultipleChecks, registry);
		const title = buildSelectTitle(planWithMultipleChecks, impact);
		expect(title).toContain("check: npm test (+1)");
	});

	it("surfaces unknown actors with a leading warning", () => {
		const firstStep = readOnlyPlan.steps[0]!;
		if (firstStep.kind !== "action") throw new Error("expected action");
		const bad: PlanDraftDoc = {
			...readOnlyPlan,
			steps: [{ ...firstStep, actor: "ghost-actor" }, readOnlyPlan.steps[1]!],
		};
		const impact = summarizePlanImpact(bad, registry);
		const title = buildSelectTitle(bad, impact);
		expect(title).toContain("⚠ unknown actors: ghost-actor");
	});
});
