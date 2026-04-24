import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { type PlanDraftDoc, PlanDraftSchema } from "../../src/plan/draft.js";

const validPlan: PlanDraftDoc = {
	task: "Add a feature flag to the user service and run the test suite before committing.",
	success_criteria: "Tests pass and the flag is wired to the canonical feature registry.",
	artifacts: [
		{
			name: "requirements",
			description: "Parsed requirements",
		},
		{
			name: "implementation_notes",
			description: "Notes from the implementer",
		},
	],
	steps: [
		{
			type: "action",
			name: "plan-changes",
			actor: "planner",
			instruction: "Identify the files that need to change and record them in requirements.",
			reads: [],
			writes: ["requirements"],
			routes: { success: "implement" },
		},
		{
			type: "action",
			name: "implement",
			actor: "worker",
			instruction: "Apply the changes described in requirements.",
			reads: ["requirements"],
			writes: ["implementation_notes"],
			routes: { done: "run-tests" },
		},
		{
			type: "command",
			name: "run-tests",
			command: "npm test",
			timeout: 120,
			on_success: "done",
			on_failure: "failed",
		},
		{
			type: "terminal",
			name: "done",
			outcome: "success",
			summary: "Feature flag shipped and tests are green.",
		},
		{
			type: "terminal",
			name: "failed",
			outcome: "failure",
			summary: "Tests failed after implementation.",
		},
	],
	entry_step: "plan-changes",
};

describe("PlanDraftSchema", () => {
	it("accepts a structurally valid plan", () => {
		expect(Value.Check(PlanDraftSchema, validPlan)).toBe(true);
	});

	it("rejects a plan missing the task field", () => {
		const bad = { ...validPlan, task: undefined };
		expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
	});

	it("rejects a plan with an empty steps array", () => {
		const bad = { ...validPlan, steps: [] };
		expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
	});

	it("rejects an action step without routes", () => {
		const bad: PlanDraftDoc = {
			...validPlan,
			steps: [
				{
					type: "action",
					name: "broken",
					actor: "worker",
					instruction: "Do the thing.",
					reads: [],
					writes: [],
					routes: {},
				},
				...validPlan.steps.slice(1),
			],
		};
		expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
	});

	it("rejects an unknown step kind", () => {
		const bad = {
			...validPlan,
			steps: [
				{
					type: "nonsense",
					name: "weird",
					actor: "worker",
					instruction: "hi",
					reads: [],
					writes: [],
					routes: {},
				},
				...validPlan.steps.slice(1),
			],
		};
		expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
	});

	it("rejects an unknown step kind in verify position", () => {
		const bad: unknown = {
			...validPlan,
			steps: [
				validPlan.steps[0],
				validPlan.steps[1],
				{
					type: "verify_nope",
					name: "run-tests",
					command: "npm test",
					on_success: "done",
					on_failure: "failed",
				},
				...validPlan.steps.slice(3),
			],
		};
		expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
	});

	it("rejects a name that violates the pattern", () => {
		const bad = {
			...validPlan,
			steps: [{ ...validPlan.steps[0], name: "has space" }, ...validPlan.steps.slice(1)],
		};
		expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
	});

	it("accepts the minimal shape: one action step plus a terminal", () => {
		const minimal: PlanDraftDoc = {
			task: "Say hello.",
			artifacts: [],
			steps: [
				{
					type: "action",
					name: "greet",
					actor: "worker",
					instruction: "Produce a one-line greeting.",
					reads: [],
					writes: [],
					routes: { done: "end" },
				},
				{
					type: "terminal",
					name: "end",
					outcome: "success",
					summary: "Greeted.",
				},
			],
			entry_step: "greet",
		};
		expect(Value.Check(PlanDraftSchema, minimal)).toBe(true);
	});

	it("accepts a plan without entry_step, artifacts, reads, or writes", () => {
		const minimal: PlanDraftDoc = {
			task: "Say hello.",
			steps: [
				{
					type: "action",
					name: "greet",
					actor: "worker",
					instruction: "Produce a one-line greeting.",
					routes: { done: "end" },
				},
				{
					type: "terminal",
					name: "end",
					outcome: "success",
					summary: "Greeted.",
				},
			],
		};
		expect(Value.Check(PlanDraftSchema, minimal)).toBe(true);
	});

	it("accepts an artifact with fields", () => {
		const plan = {
			...validPlan,
			artifacts: [{ name: "a", description: "a", fields: ["x", "y"] }],
		};
		expect(Value.Check(PlanDraftSchema, plan)).toBe(true);
	});

	it("accepts an artifact with fields and list", () => {
		const plan = {
			...validPlan,
			artifacts: [{ name: "a", description: "a", fields: ["x"], list: true }],
		};
		expect(Value.Check(PlanDraftSchema, plan)).toBe(true);
	});

	it("rejects an artifact with an empty fields array", () => {
		const plan = {
			...validPlan,
			artifacts: [{ name: "a", description: "a", fields: [] }],
		};
		expect(Value.Check(PlanDraftSchema, plan)).toBe(false);
	});
});
