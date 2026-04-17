import { describe, expect, it } from "vitest";
import { instantiateTemplate } from "../../src/templates/substitute.js";
import type { PlanTemplate } from "../../src/templates/types.js";

const makeTemplate = (overrides: Partial<PlanTemplate> = {}): PlanTemplate => ({
	name: "test-template",
	description: "A test template.",
	parameters: [
		{ name: "module", description: "Module path.", required: true },
		{ name: "symbol", description: "Symbol name.", required: true },
		{ name: "note", description: "Optional note.", required: false },
	],
	rawPlan: {
		task: "Rename {{symbol}} in {{module}}",
		entryStep: "rename",
		artifacts: [],
		steps: [
			{
				kind: "action",
				id: "rename",
				actor: "worker",
				instruction: "Rename {{symbol}} in {{module}}. Note: {{note}}",
				reads: [],
				writes: [],
				routes: [{ route: "done", to: "success" }],
			},
			{
				kind: "terminal",
				id: "success",
				outcome: "success",
				summary: "Done.",
			},
		],
	},
	source: "user",
	filePath: "/tmp/test-template.md",
	...overrides,
});

describe("instantiateTemplate", () => {
	it("substitutes all placeholders in a valid call", () => {
		const result = instantiateTemplate(makeTemplate(), {
			module: "src/foo.ts",
			symbol: "oldName",
			note: "be careful",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.plan.task).toBe("Rename oldName in src/foo.ts");
		const step = result.value.plan.steps[0]!;
		if (step.kind !== "action") throw new Error("expected action");
		expect(step.instruction).toBe("Rename oldName in src/foo.ts. Note: be careful");
		expect(result.value.templateName).toBe("test-template");
		expect(result.value.templateArgs).toEqual({
			module: "src/foo.ts",
			symbol: "oldName",
			note: "be careful",
		});
	});

	it("replaces optional params with empty string when omitted", () => {
		const result = instantiateTemplate(makeTemplate(), {
			module: "src/foo.ts",
			symbol: "oldName",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const step = result.value.plan.steps[0]!;
		if (step.kind !== "action") throw new Error("expected action");
		expect(step.instruction).toBe("Rename oldName in src/foo.ts. Note: ");
	});

	it("returns missing_required_param when a required param is absent", () => {
		const result = instantiateTemplate(makeTemplate(), { module: "src/foo.ts" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("missing_required_param");
		if (result.error.kind !== "missing_required_param") return;
		expect(result.error.missing).toEqual(["symbol"]);
		expect(result.error.provided).toEqual(["module"]);
	});

	it("silently ignores unknown args", () => {
		const result = instantiateTemplate(makeTemplate(), {
			module: "src/foo.ts",
			symbol: "oldName",
			extra_stuff: "ignored",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.templateArgs).not.toHaveProperty("extra_stuff");
	});

	it("detects unresolved placeholders from typos in the template", () => {
		const template = makeTemplate({
			rawPlan: {
				...makeTemplate().rawPlan,
				task: "Do {{typo_param}}",
			},
		});
		const result = instantiateTemplate(template, {
			module: "src/foo.ts",
			symbol: "oldName",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("unresolved_placeholder");
		if (result.error.kind !== "unresolved_placeholder") return;
		expect(result.error.placeholder).toBe("typo_param");
		expect(result.error.fieldPath).toBe("task");
	});

	it("handles YAML special characters in arg values without corruption", () => {
		const result = instantiateTemplate(makeTemplate(), {
			module: 'src/"weird:path"\nnewline',
			symbol: "old: {name}",
			note: "has 'quotes'",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.plan.task).toContain('"weird:path"');
	});

	it("substitutes placeholders in deeply nested values", () => {
		const template = makeTemplate({
			rawPlan: {
				task: "test",
				entryStep: "a",
				artifacts: [],
				steps: [
					{
						kind: "action",
						id: "a",
						actor: "worker",
						instruction: "do it",
						reads: [],
						writes: [],
						routes: [{ route: "done", to: "{{next_step}}" }],
					},
					{
						kind: "terminal",
						id: "b",
						outcome: "success",
						summary: "ok",
					},
				],
			},
			parameters: [{ name: "next_step", description: "Next step id.", required: true }],
		});
		const result = instantiateTemplate(template, { next_step: "b" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const step = result.value.plan.steps[0]!;
		if (step.kind !== "action") throw new Error("expected action");
		expect(step.routes[0]!.to).toBe("b");
	});

	it("catches residual placeholders injected via arg values", () => {
		// If an arg value contains {{something}}, and that something is not a
		// declared param, it will show up as unresolved after substitution.
		const template = makeTemplate({
			parameters: [{ name: "x", description: "test", required: true }],
			rawPlan: {
				task: "Do {{x}}",
				entryStep: "a",
				artifacts: [],
				steps: [
					{
						kind: "terminal",
						id: "a",
						outcome: "success",
						summary: "ok",
					},
				],
			},
		});
		const result = instantiateTemplate(template, { x: "{{injected}}" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("unresolved_placeholder");
	});

	it("returns invalid_plan when substitution produces an empty task", () => {
		const template = makeTemplate({
			parameters: [{ name: "task_text", description: "task", required: false }],
			rawPlan: {
				task: "{{task_text}}",
				entryStep: "a",
				artifacts: [],
				steps: [
					{
						kind: "terminal",
						id: "a",
						outcome: "success",
						summary: "ok",
					},
				],
			},
		});
		const result = instantiateTemplate(template, {});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.kind).toBe("invalid_plan");
	});

	it("handles a template with no parameters", () => {
		const template = makeTemplate({
			parameters: [],
			rawPlan: {
				task: "Run the linter",
				entryStep: "lint",
				artifacts: [],
				steps: [
					{
						kind: "check",
						id: "lint",
						check: { kind: "command_exits_zero", command: "npm run lint" },
						onPass: "done",
						onFail: "failed",
					},
					{ kind: "terminal", id: "done", outcome: "success", summary: "Lint passed." },
					{ kind: "terminal", id: "failed", outcome: "failure", summary: "Lint failed." },
				],
			},
		});
		const result = instantiateTemplate(template, {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.plan.task).toBe("Run the linter");
	});

	it("coerces a sole placeholder to a number when the arg is numeric", () => {
		const template = makeTemplate({
			parameters: [{ name: "count", description: "a number", required: true }],
			rawPlan: {
				task: "test",
				entryStep: "a",
				artifacts: [],
				steps: [
					{
						kind: "action",
						id: "a",
						actor: "worker",
						instruction: "do it",
						reads: [],
						writes: [],
						routes: [{ route: "done", to: "b" }],
						maxRuns: "{{count}}",
					},
					{ kind: "terminal", id: "b", outcome: "success", summary: "ok" },
				],
			},
		});
		const result = instantiateTemplate(template, { count: "25" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const step = result.value.plan.steps[0]!;
		if (step.kind !== "action") throw new Error("expected action");
		expect(step.maxRuns).toBe(25);
		expect(typeof step.maxRuns).toBe("number");
	});

	it("coerces booleans when the entire value is a placeholder", () => {
		const template = makeTemplate({
			parameters: [{ name: "flag", description: "bool", required: true }],
			rawPlan: {
				task: "test {{flag}}",
				entryStep: "a",
				artifacts: [{ id: "x", description: "x", shape: { kind: "untyped_json" } }],
				steps: [
					{
						kind: "action",
						id: "a",
						actor: "worker",
						instruction: "do it",
						reads: [],
						writes: ["x"],
						routes: [{ route: "done", to: "b" }],
					},
					{ kind: "terminal", id: "b", outcome: "success", summary: "ok" },
				],
			},
		});
		const result = instantiateTemplate(template, { flag: "true" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.plan.task).toBe("test true");
	});

	it("keeps string type when placeholder is embedded in a larger string", () => {
		const template = makeTemplate({
			parameters: [{ name: "n", description: "num", required: true }],
			rawPlan: {
				task: "run {{n}} times",
				entryStep: "a",
				artifacts: [],
				steps: [{ kind: "terminal", id: "a", outcome: "success", summary: "ok" }],
			},
		});
		const result = instantiateTemplate(template, { n: "42" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.plan.task).toBe("run 42 times");
		expect(typeof result.value.plan.task).toBe("string");
	});

	it("does not mutate the original rawPlan", () => {
		const template = makeTemplate();
		const originalTask = template.rawPlan.task;
		instantiateTemplate(template, { module: "changed", symbol: "changed" });
		expect(template.rawPlan.task).toBe(originalTask);
	});
});
