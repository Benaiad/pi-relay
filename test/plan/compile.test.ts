import { describe, expect, it } from "vitest";
import { type ActorRegistry, compile } from "../../src/plan/compile.js";
import { formatCompileError } from "../../src/plan/compile-error-format.js";
import type { PlanDraftDoc } from "../../src/plan/draft.js";
import { ActorId, ArtifactId, edgeKey, RouteId, StepId, unwrap } from "../../src/plan/ids.js";
import { isErr, isOk } from "../../src/plan/result.js";

const fixedIdOptions = { generateId: () => "fixed-plan-id" };

const defaultActors: ActorRegistry = {
	has: (id) => ["worker", "planner", "scout"].includes(unwrap(id)),
	names: () => [ActorId("worker"), ActorId("planner"), ActorId("scout")],
};

const emptyActors: ActorRegistry = {
	has: () => false,
	names: () => [],
};

const basicPlan: PlanDraftDoc = {
	task: "Plan, implement, and verify.",
	artifacts: [
		{
			name: "requirements",
			description: "Parsed requirements",
		},
		{
			name: "notes",
			description: "Implementer notes",
		},
	],
	steps: [
		{
			type: "action",
			name: "plan",
			actor: "planner",
			instruction: "Write requirements.",
			reads: [],
			writes: ["requirements"],
			routes: { next: "implement" },
		},
		{
			type: "action",
			name: "implement",
			actor: "worker",
			instruction: "Apply the requirements.",
			reads: ["requirements"],
			writes: ["notes"],
			routes: { done: "done" },
		},
		{
			type: "terminal",
			name: "done",
			outcome: "success",
			summary: "Implementation complete.",
		},
	],
	entry_step: "plan",
};

describe("compile", () => {
	it("accepts a happy-path linear plan and builds every index", () => {
		const result = compile(basicPlan, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		const program = result.value;
		expect(unwrap(program.id)).toBe("fixed-plan-id");
		expect(program.task).toBe(basicPlan.task);
		expect(program.stepOrder.map(unwrap)).toEqual(["plan", "implement", "done"]);
		expect(program.steps.size).toBe(3);
		expect(program.artifacts.size).toBe(2);
		expect(program.edges.size).toBe(2);
		expect(program.edges.get(edgeKey(StepId("plan"), RouteId("next")))).toEqual(StepId("implement"));
		expect(program.edges.get(edgeKey(StepId("implement"), RouteId("done")))).toEqual(StepId("done"));
		expect(program.writers.get(ArtifactId("requirements"))).toEqual(StepId("plan"));
		expect(program.writers.get(ArtifactId("notes"))).toEqual(StepId("implement"));
		expect(program.readers.get(ArtifactId("requirements"))).toEqual(new Set([StepId("implement")]));
		expect(program.actorsReferenced).toEqual(new Set([ActorId("planner"), ActorId("worker")]));
	});

	it("rejects an empty steps array", () => {
		const bad: PlanDraftDoc = { ...basicPlan, steps: [] };
		const result = compile(bad, defaultActors, fixedIdOptions);
		expect(isErr(result)).toBe(true);
		if (!isErr(result)) return;
		expect(result.error.type).toBe("empty_plan");
	});

	it("rejects a plan with no terminal step", () => {
		const bad: PlanDraftDoc = {
			...basicPlan,
			steps: basicPlan.steps.filter((s) => s.type !== "terminal"),
		};
		const result = compile(bad, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("no_terminal");
	});

	it("rejects a plan whose entry step is a terminal", () => {
		const bad: PlanDraftDoc = {
			task: "Instant done",
			steps: [
				{ type: "terminal", name: "done", outcome: "success", summary: "Nothing happened." },
				{
					type: "action",
					name: "work",
					actor: "worker",
					instruction: "Do things.",
					routes: { done: "done" },
				},
			],
			entry_step: "done",
		};
		const result = compile(bad, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("terminal_entry");
	});

	it("rejects duplicate step ids", () => {
		const firstStep = basicPlan.steps[0]!;
		const bad: PlanDraftDoc = {
			...basicPlan,
			steps: [...basicPlan.steps, { ...firstStep }],
		};
		const result = compile(bad, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("duplicate_step");
	});

	it("uses the first step as entry when entryStep is omitted", () => {
		const { entry_step: _, ...planWithoutEntry } = basicPlan;
		const result = compile(planWithoutEntry, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(unwrap(result.value.entryStep)).toBe("plan");
	});

	it("rejects an explicit entryStep that does not exist", () => {
		const bad: PlanDraftDoc = { ...basicPlan, entry_step: "does-not-exist" };
		const result = compile(bad, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("missing_entry");
		if (result.error.type === "missing_entry") {
			expect(unwrap(result.error.entryStep)).toBe("does-not-exist");
			expect(result.error.availableSteps.map(unwrap)).toEqual(["plan", "implement", "done"]);
		}
	});

	it("derives text shape for artifacts without fields", () => {
		const result = compile(basicPlan, defaultActors, fixedIdOptions);
		if (!isOk(result)) throw new Error("expected ok");
		const contract = result.value.artifacts.get(ArtifactId("requirements"));
		expect(contract?.shape).toEqual({ type: "text" });
	});

	it("derives record shape for artifacts with fields", () => {
		const plan: PlanDraftDoc = {
			...basicPlan,
			artifacts: [
				{ name: "requirements", description: "reqs", fields: ["x", "y"] },
				{ name: "notes", description: "notes" },
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		if (!isOk(result)) throw new Error("expected ok");
		expect(result.value.artifacts.get(ArtifactId("requirements"))?.shape).toEqual({
			type: "record",
			fields: ["x", "y"],
		});
		expect(result.value.artifacts.get(ArtifactId("notes"))?.shape).toEqual({
			type: "text",
		});
	});

	it("derives record_list shape for artifacts with fields and list", () => {
		const plan: PlanDraftDoc = {
			...basicPlan,
			artifacts: [
				{ name: "requirements", description: "reqs", fields: ["a"], list: true },
				{ name: "notes", description: "notes" },
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		if (!isOk(result)) throw new Error("expected ok");
		expect(result.value.artifacts.get(ArtifactId("requirements"))?.shape).toEqual({
			type: "record_list",
			fields: ["a"],
		});
	});

	it("defaults artifacts to empty when omitted", () => {
		const plan: PlanDraftDoc = {
			task: "No artifacts needed.",
			steps: [
				{
					type: "action",
					name: "work",
					actor: "worker",
					instruction: "Do the thing.",
					routes: { done: "done" },
				},
				{
					type: "terminal",
					name: "done",
					outcome: "success",
					summary: "Done.",
				},
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(result.value.artifacts.size).toBe(0);
		const step = result.value.steps.get(StepId("work"));
		if (step?.type !== "action") throw new Error("expected action");
		expect(step.reads).toEqual([]);
		expect(step.writes).toEqual([]);
	});

	it("rejects a step referencing an unknown actor", () => {
		const result = compile(basicPlan, emptyActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("missing_actor");
		if (result.error.type === "missing_actor") {
			expect(unwrap(result.error.actor)).toBe("planner");
			expect(result.error.availableActors).toEqual([]);
		}
	});

	it("rejects a route targeting a non-existent step", () => {
		const planStep = basicPlan.steps[0]!;
		if (planStep.type !== "action") throw new Error("expected action");
		const bad: PlanDraftDoc = {
			...basicPlan,
			steps: [{ ...planStep, routes: { next: "nowhere" } }, ...basicPlan.steps.slice(1)],
		};
		const result = compile(bad, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("missing_route_target");
		if (result.error.type === "missing_route_target") {
			expect(unwrap(result.error.from)).toBe("plan");
			expect(unwrap(result.error.target)).toBe("nowhere");
		}
	});

	it("allows multiple steps to write the same artifact", () => {
		const implementStep = basicPlan.steps[1]!;
		if (implementStep.type !== "action") throw new Error("expected action");
		const plan: PlanDraftDoc = {
			...basicPlan,
			steps: [basicPlan.steps[0]!, { ...implementStep, writes: ["requirements", "notes"] }, basicPlan.steps[2]!],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
	});

	it("rejects a step reading an undeclared artifact", () => {
		const implementStep = basicPlan.steps[1]!;
		if (implementStep.type !== "action") throw new Error("expected action");
		const bad: PlanDraftDoc = {
			...basicPlan,
			steps: [basicPlan.steps[0]!, { ...implementStep, reads: ["ghost"] }, basicPlan.steps[2]!],
		};
		const result = compile(bad, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("missing_artifact_contract");
	});

	it("rejects an artifact with no writer", () => {
		const bad: PlanDraftDoc = {
			...basicPlan,
			artifacts: [
				...(basicPlan.artifacts ?? []),
				{
					name: "unused",
					description: "never produced",
				},
			],
		};
		const result = compile(bad, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("missing_artifact_producer");
		if (result.error.type === "missing_artifact_producer") {
			expect(unwrap(result.error.artifactId)).toBe("unused");
		}
	});

	it("rejects duplicate artifact declarations", () => {
		const bad: PlanDraftDoc = {
			...basicPlan,
			artifacts: [
				...(basicPlan.artifacts ?? []),
				{
					name: "requirements",
					description: "dup",
				},
			],
		};
		const result = compile(bad, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("duplicate_artifact");
	});

	it("compiles a files_exist step with pass and fail routes", () => {
		const plan: PlanDraftDoc = {
			task: "Run tests and branch on outcome.",
			artifacts: [{ name: "spec", description: "spec" }],
			steps: [
				{
					type: "action",
					name: "write",
					actor: "worker",
					instruction: "Write a spec.",
					reads: [],
					writes: ["spec"],
					routes: { ready: "verify" },
				},
				{
					type: "files_exist",
					name: "verify",
					paths: ["/tmp/does-not-matter"],
					on_success: "ok",
					on_failure: "broken",
				},
				{ type: "terminal", name: "ok", outcome: "success", summary: "passed" },
				{
					type: "terminal",
					name: "broken",
					outcome: "failure",
					summary: "failed",
				},
			],
			entry_step: "write",
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(result.value.edges.get(edgeKey(StepId("verify"), RouteId("success")))).toEqual(StepId("ok"));
		expect(result.value.edges.get(edgeKey(StepId("verify"), RouteId("failure")))).toEqual(StepId("broken"));
	});

	it("rejects a verify step with an unknown onFailure target", () => {
		const plan: PlanDraftDoc = {
			task: "bad verify",
			artifacts: [],
			steps: [
				{
					type: "files_exist",
					name: "verify",
					paths: ["/tmp/x"],
					on_success: "done",
					on_failure: "ghost",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
			entry_step: "verify",
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("missing_route_target");
	});

	it("accepts artifact ids with hyphens", () => {
		const plan: PlanDraftDoc = {
			task: "Hyphenated artifact ids.",
			artifacts: [{ name: "my-artifact", description: "hyphenated" }],
			steps: [
				{
					type: "action",
					name: "work",
					actor: "worker",
					instruction: "Do it.",
					writes: ["my-artifact"],
					routes: { done: "done" },
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
	});

	it("accepts a command step with reads", () => {
		const plan: PlanDraftDoc = {
			task: "Action writes, verify reads.",
			artifacts: [{ name: "result", description: "result" }],
			steps: [
				{
					type: "action",
					name: "produce",
					actor: "worker",
					instruction: "Write result.",
					writes: ["result"],
					routes: { done: "check" },
				},
				{
					type: "command",
					name: "check",
					command: "echo $result",
					reads: ["result"],
					on_success: "done",
					on_failure: "failed",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
				{ type: "terminal", name: "failed", outcome: "failure", summary: "bad" },
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(result.value.readers.get(ArtifactId("result"))).toEqual(new Set([StepId("check")]));
	});

	it("rejects a command step reading an undeclared artifact", () => {
		const plan: PlanDraftDoc = {
			task: "Verify reads ghost.",
			artifacts: [],
			steps: [
				{
					type: "command",
					name: "check",
					command: "echo $ghost",
					reads: ["ghost"],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("missing_artifact_contract");
		if (result.error.type === "missing_artifact_contract") {
			expect(unwrap(result.error.stepId)).toBe("check");
			expect(result.error.direction).toBe("read");
		}
	});

	it("compiles a command step with empty reads", () => {
		const plan: PlanDraftDoc = {
			task: "Verify with no reads.",
			artifacts: [],
			steps: [
				{
					type: "command",
					name: "check",
					command: "echo hello",
					reads: [],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
	});

	it("accepts a command step with writes", () => {
		const plan: PlanDraftDoc = {
			task: "Command writes an artifact.",
			artifacts: [
				{ name: "input", description: "in" },
				{ name: "output", description: "out" },
			],
			steps: [
				{
					type: "action",
					name: "produce",
					actor: "worker",
					instruction: "Write input.",
					writes: ["input"],
					routes: { done: "grade" },
				},
				{
					type: "command",
					name: "grade",
					command: "./grader.sh",
					reads: ["input"],
					writes: ["output"],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(result.value.allowedWriters.get(ArtifactId("output"))).toEqual(new Set([StepId("grade")]));
		expect(result.value.writers.get(ArtifactId("output"))).toEqual(StepId("grade"));
	});

	it("rejects a command step writing an undeclared artifact", () => {
		const plan: PlanDraftDoc = {
			task: "Command writes ghost.",
			artifacts: [],
			steps: [
				{
					type: "command",
					name: "grade",
					command: "./grader.sh",
					writes: ["ghost"],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const result = compile(plan, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		expect(result.error.type).toBe("missing_artifact_contract");
		if (result.error.type === "missing_artifact_contract") {
			expect(unwrap(result.error.stepId)).toBe("grade");
			expect(result.error.direction).toBe("write");
		}
	});

	it("formats compile errors into readable messages", () => {
		const result = compile({ ...basicPlan, entry_step: "nonexistent" }, defaultActors, fixedIdOptions);
		if (!isErr(result)) throw new Error("expected error");
		const msg = formatCompileError(result.error);
		expect(msg).toContain("'nonexistent'");
		expect(msg).toContain("'plan'");
		expect(msg).toContain("'implement'");
		expect(msg).toContain("'done'");
	});
});
