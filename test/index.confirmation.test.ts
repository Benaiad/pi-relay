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
	it("includes the task, step counts, and actor list", () => {
		const impact = summarizePlanImpact(mutatingPlan, registry);
		const body = buildConfirmationBody(mutatingPlan, impact);
		expect(body).toContain("Task:");
		expect(body).toContain("Add a feature flag");
		expect(body).toContain("Success:");
		expect(body).toContain("Tests green");
		expect(body).toContain("Steps: 4");
		expect(body).toContain("1 action, 1 check, 2 terminal");
		expect(body).toContain("Actors: worker");
	});

	it("calls out filesystem and shell impact when applicable", () => {
		const impact = summarizePlanImpact(mutatingPlan, registry);
		const body = buildConfirmationBody(mutatingPlan, impact);
		expect(body).toContain("may create, edit, or write files");
		expect(body).toContain("may run shell commands");
		expect(body).toContain("'npm test'");
	});

	it("explicitly labels read-only plans", () => {
		const impact = summarizePlanImpact(readOnlyPlan, registry);
		const body = buildConfirmationBody(readOnlyPlan, impact);
		expect(body).toContain("Impact: read-only");
	});

	it("warns when the plan references unknown actors", () => {
		const firstStep = readOnlyPlan.steps[0]!;
		if (firstStep.kind !== "action") throw new Error("expected action");
		const bad: PlanDraftDoc = {
			...readOnlyPlan,
			steps: [{ ...firstStep, actor: "ghost-actor" }, readOnlyPlan.steps[1]!],
		};
		const impact = summarizePlanImpact(bad, registry);
		const body = buildConfirmationBody(bad, impact);
		expect(body).toContain("WARNING");
		expect(body).toContain("ghost-actor");
	});

	it("notes that subprocess actors are non-interactive", () => {
		const impact = summarizePlanImpact(readOnlyPlan, registry);
		const body = buildConfirmationBody(readOnlyPlan, impact);
		expect(body).toContain("non-interactively");
		expect(body).toContain("authorizes every");
	});
});
