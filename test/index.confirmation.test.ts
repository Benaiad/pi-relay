import { describe, expect, it } from "vitest";
import type { ActorConfig } from "../src/actors/types.js";
import { buildConfirmationBody, summarizePlanImpact } from "../src/index.js";
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

describe("buildConfirmationBody", () => {
	it("stays short — no task text or step list (rendered above via renderCall)", () => {
		const impact = summarizePlanImpact(mutatingPlan, registry);
		const body = buildConfirmationBody(mutatingPlan, impact);
		expect(body).not.toContain("Add a feature flag");
		expect(body).not.toContain("Success:");
		expect(body).not.toContain("Steps:");
		expect(body).not.toContain("Actors:");
		// Body is bounded in height so confirm dialogs that don't scroll stay readable.
		expect(body.split("\n").length).toBeLessThanOrEqual(8);
	});

	it("calls out filesystem and shell impact with bullet points", () => {
		const impact = summarizePlanImpact(mutatingPlan, registry);
		const body = buildConfirmationBody(mutatingPlan, impact);
		expect(body).toContain("• may create, edit, or write files");
		expect(body).toContain("• may run shell commands");
		expect(body).toContain("• check runs: npm test");
	});

	it("shows the first check command plus a count when there are multiple", () => {
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
		const body = buildConfirmationBody(planWithMultipleChecks, impact);
		expect(body).toContain("check runs: npm test (+1 more)");
	});

	it("labels read-only plans explicitly", () => {
		const impact = summarizePlanImpact(readOnlyPlan, registry);
		const body = buildConfirmationBody(readOnlyPlan, impact);
		expect(body).toContain("read-only");
	});

	it("surfaces unknown actors as a leading warning", () => {
		const firstStep = readOnlyPlan.steps[0]!;
		if (firstStep.kind !== "action") throw new Error("expected action");
		const bad: PlanDraftDoc = {
			...readOnlyPlan,
			steps: [{ ...firstStep, actor: "ghost-actor" }, readOnlyPlan.steps[1]!],
		};
		const impact = summarizePlanImpact(bad, registry);
		const body = buildConfirmationBody(bad, impact);
		expect(body).toContain("unknown actors");
		expect(body).toContain("ghost-actor");
	});

	it("notes that subprocess actors are non-interactive and the plan is shown above", () => {
		const impact = summarizePlanImpact(readOnlyPlan, registry);
		const body = buildConfirmationBody(readOnlyPlan, impact);
		expect(body).toContain("non-interactively");
		expect(body).toContain("authorizes every");
		expect(body).toContain("shown above");
	});
});
