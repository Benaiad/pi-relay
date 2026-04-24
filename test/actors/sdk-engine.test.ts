/**
 * Tests for the SDK engine's completion extraction logic.
 *
 * The full runAction flow requires a live model, so these tests focus on
 * the extractable pure functions: finding the relay_complete tool result
 * in a message array and reading structured details from it.
 *
 * Integration coverage comes from the smoke and replay tests which exercise
 * the full plan execution pipeline.
 */

import { describe, expect, it } from "vitest";
import { buildTaskPrompt } from "../../src/actors/task-prompt.js";
import { ArtifactId, StepId, unwrap } from "../../src/plan/ids.js";
import type { ArtifactContract } from "../../src/plan/types.js";

describe("buildTaskPrompt", () => {
	const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
		[
			ArtifactId("spec"),
			{
				name: ArtifactId("spec"),
				description: "Parsed requirements",
				shape: { type: "text" },
			},
		],
	]);

	const emptySnapshot = {
		get: () => undefined,
		has: () => false,
		ids: () => [],
	};

	it("includes actor name and step id", () => {
		const prompt = buildTaskPrompt("Do the thing", [], emptySnapshot, contracts, [], "worker", StepId("implement"));
		expect(prompt).toContain("worker");
		expect(prompt).toContain("implement");
	});

	it("includes the task instruction", () => {
		const prompt = buildTaskPrompt(
			"Implement the feature",
			[],
			emptySnapshot,
			contracts,
			[],
			"worker",
			StepId("step1"),
		);
		expect(prompt).toContain("Task: Implement the feature");
	});

	it("renders input artifacts when present", () => {
		const snapshot = {
			get: (id: ReturnType<typeof ArtifactId>) => (unwrap(id) === "spec" ? "requirements text" : undefined),
			has: (id: ReturnType<typeof ArtifactId>) => unwrap(id) === "spec",
			ids: () => [ArtifactId("spec")],
		};
		const prompt = buildTaskPrompt(
			"Do the thing",
			[ArtifactId("spec")],
			snapshot,
			contracts,
			[],
			"worker",
			StepId("step1"),
		);
		expect(prompt).toContain("Input artifacts");
		expect(prompt).toContain("requirements text");
	});

	it("lists missing artifacts", () => {
		const prompt = buildTaskPrompt(
			"Do the thing",
			[ArtifactId("spec")],
			emptySnapshot,
			contracts,
			[],
			"worker",
			StepId("step1"),
		);
		expect(prompt).toContain("Missing artifacts");
		expect(prompt).toContain("spec");
	});

	it("includes prior attempts on re-entry", () => {
		const prompt = buildTaskPrompt(
			"Fix the bug",
			[],
			emptySnapshot,
			contracts,
			[
				{
					attemptNumber: 1,
					outcomeLabel: "route: changes_requested",
					narration: "Found issues in the code",
					toolsCalled: ["read", "edit"],
				},
			],
			"worker",
			StepId("step1"),
		);
		expect(prompt).toContain("Previous attempts at this step");
		expect(prompt).toContain("Attempt 1");
		expect(prompt).toContain("route: changes_requested");
		expect(prompt).toContain("read, edit");
	});

	it("does not include a completion reminder", () => {
		const prompt = buildTaskPrompt("Do the thing", [], emptySnapshot, contracts, [], "worker", StepId("step1"));
		expect(prompt).not.toContain("relay-complete");
		expect(prompt).not.toContain("Completion reminder");
	});

	it("includes prior check result when present", () => {
		const prompt = buildTaskPrompt(
			"Fix the failing test",
			[],
			emptySnapshot,
			contracts,
			[],
			"worker",
			StepId("step1"),
			undefined,
			{
				stepId: StepId("check"),
				outcome: "failed",
				description: "test suite failed with 3 errors",
			},
		);
		expect(prompt).toContain("Prior check result");
		expect(prompt).toContain("check failed");
		expect(prompt).toContain("3 errors");
	});
});
