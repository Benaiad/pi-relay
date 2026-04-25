import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import type { ActionOutcome, ActionRequest, ActorEngine, ActorUsage, ValidatedActor } from "../../src/actors/types.js";
import { emptyUsage } from "../../src/actors/types.js";
import { type ActorRegistry, compile } from "../../src/plan/compile.js";
import type { PlanDraftDoc } from "../../src/plan/draft.js";
import { ActorId, ArtifactId, RouteId, unwrap } from "../../src/plan/ids.js";
import { isOk } from "../../src/plan/result.js";
import { applyEvent, initRunState, type RelayEvent } from "../../src/runtime/events.js";
import { buildAttemptTimeline } from "../../src/runtime/run-report.js";
import { Scheduler } from "../../src/runtime/scheduler.js";

// ============================================================================
// Test helpers
// ============================================================================

const actorRegistry: ActorRegistry = {
	has: (id) => ["worker", "planner", "checker"].includes(unwrap(id)),
	names: () => [ActorId("worker"), ActorId("planner"), ActorId("checker")],
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

const validatedActor = (name: string): ValidatedActor => ({
	name,
	description: `Fake ${name}`,
	systemPrompt: "",
	source: "user",
	filePath: `/tmp/${name}.md`,
	resolvedModel: fakeModel,
	thinking: "medium",
});

const fakeActorsByName = new Map<ActorId, ValidatedActor>([
	[ActorId("worker"), validatedActor("worker")],
	[ActorId("planner"), validatedActor("planner")],
	[ActorId("checker"), validatedActor("checker")],
]);

class StubClock {
	private tick = 0;
	next(): number {
		this.tick += 1;
		return this.tick;
	}
}

const fakeUsage = (turns = 1, cost = 0.01): ActorUsage => ({
	...emptyUsage(),
	turns,
	input: 100 * turns,
	output: 50 * turns,
	cost,
});

type ScriptEntry = (request: ActionRequest) => ActionOutcome | Promise<ActionOutcome>;

class ScriptedActorEngine implements ActorEngine {
	private calls: Array<{
		stepId: string;
		attempt: number;
		priorAttemptCount: number;
	}> = [];
	constructor(private readonly script: Map<string, ScriptEntry[]>) {}

	async runAction(request: ActionRequest): Promise<ActionOutcome> {
		const stepKey = unwrap(request.step.name);
		const entries = this.script.get(stepKey) ?? [];
		const priorCalls = this.calls.filter((c) => c.stepId === stepKey).length;
		this.calls.push({
			stepId: stepKey,
			attempt: priorCalls + 1,
			priorAttemptCount: request.priorAttempts.length,
		});
		const entry = entries[priorCalls] ?? entries[entries.length - 1];
		if (!entry) {
			return {
				kind: "engine_error",
				reason: `no script entry for ${stepKey}`,
				usage: emptyUsage(),
				transcript: [],
			};
		}
		return entry(request);
	}

	callCounts(): ReadonlyMap<string, number> {
		const counts = new Map<string, number>();
		for (const c of this.calls) counts.set(c.stepId, (counts.get(c.stepId) ?? 0) + 1);
		return counts;
	}

	priorAttemptCountsFor(stepKey: string): readonly number[] {
		return this.calls.filter((c) => c.stepId === stepKey).map((c) => c.priorAttemptCount);
	}
}

const completed =
	(route: string, writes: Record<string, unknown> = {}): ScriptEntry =>
	() => {
		const writeMap = new Map<ReturnType<typeof ArtifactId>, unknown>();
		for (const [k, v] of Object.entries(writes)) writeMap.set(ArtifactId(k), v);
		return {
			kind: "completed",
			route: RouteId(route),
			assistant_summary: "Completed.",
			writes: writeMap,
			usage: fakeUsage(),
			transcript: [],
		};
	};

const noCompletion =
	(reason: string): ScriptEntry =>
	() => ({ kind: "no_completion", reason, usage: fakeUsage(), transcript: [] });

const engineError =
	(reason: string): ScriptEntry =>
	() => ({ kind: "engine_error", reason, usage: fakeUsage(), transcript: [] });

const linearPlan: PlanDraftDoc = {
	task: "Linear two-step plan.",
	artifacts: [{ name: "note", description: "n", fields: ["ok"] }],
	steps: [
		{
			type: "action",
			name: "first",
			actor: "worker",
			instruction: "Produce the note.",
			reads: [],
			writes: ["note"],
			routes: { next: "end" },
		},
		{ type: "terminal", name: "end", outcome: "success", summary: "All good." },
	],
	entry_step: "first",
};

const buildScheduler = (
	doc: PlanDraftDoc,
	engine: ActorEngine,
	extras: { signal?: AbortSignal; shellCommandPrefix?: string } = {},
) => {
	const compiled = compile(doc, actorRegistry, { generateId: () => "pid" });
	if (!isOk(compiled)) throw new Error("compile must succeed for scheduler tests");
	const clock = new StubClock();
	const scheduler = new Scheduler({
		program: compiled.value,
		actorEngine: engine,
		actorsByName: fakeActorsByName,
		cwd: process.cwd(),
		clock: () => clock.next(),
		signal: extras.signal,
		shellCommandPrefix: extras.shellCommandPrefix,
	});
	return { scheduler, program: compiled.value };
};

// ============================================================================
// Tests
// ============================================================================

describe("Scheduler — happy paths", () => {
	it("runs a linear action → terminal plan to success and records the route taken", async () => {
		const engine = new ScriptedActorEngine(new Map([["first", [completed("next", { note: { ok: 1 } })]]]));
		const { scheduler } = buildScheduler(linearPlan, engine);
		const events: RelayEvent[] = [];
		scheduler.subscribe((e) => events.push(e));

		const report = await scheduler.run();

		expect(report.outcome).toBe("success");
		expect(report.steps.map((s) => s.status)).toEqual(["succeeded", "succeeded"]);
		expect(report.artifacts.map((a) => unwrap(a.artifactId))).toEqual(["note"]);
		expect(engine.callCounts().get("first")).toBe(1);
		expect(events.some((e) => e.type === "action_completed")).toBe(true);
		expect(events.some((e) => e.type === "artifact_committed")).toBe(true);
		expect(events.some((e) => e.type === "terminal_reached")).toBe(true);
		expect(events[events.length - 1]!.type).toBe("run_finished");
	});

	it("routes a command step to its pass edge and continues", async () => {
		const plan: PlanDraftDoc = {
			task: "Run a verify that always passes.",
			artifacts: [],
			steps: [
				{
					type: "command",
					name: "verify",
					command: 'node -e "process.exit(0)"',
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
			entry_step: "verify",
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(report.steps.find((s) => unwrap(s.stepId) === "verify")!.lastRoute).toEqual(RouteId("success"));
	});

	it("routes a command step to its fail edge when the command fails", async () => {
		const plan: PlanDraftDoc = {
			task: "Run a verify that always fails.",
			artifacts: [],
			steps: [
				{
					type: "command",
					name: "verify",
					command: 'node -e "process.exit(2)"',
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
			entry_step: "verify",
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("failure");
		expect(report.terminalOutcome).toBe("failure");
	});

	it("applies shellCommandPrefix to command steps", async () => {
		const plan: PlanDraftDoc = {
			task: "Verify that shellCommandPrefix is prepended.",
			artifacts: [],
			steps: [
				{
					type: "command",
					name: "verify",
					command: "node -e \"process.exit(typeof process.env.RELAY_PREFIX_TEST === 'undefined' ? 1 : 0)\"",
					on_success: "ok",
					on_failure: "broken",
				},
				{ type: "terminal", name: "ok", outcome: "success", summary: "passed" },
				{ type: "terminal", name: "broken", outcome: "failure", summary: "failed" },
			],
			entry_step: "verify",
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine, {
			shellCommandPrefix: "export RELAY_PREFIX_TEST=1",
		});
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});

	it("runs command steps without prefix when shellCommandPrefix is not set", async () => {
		const plan: PlanDraftDoc = {
			task: "Verify commands work without prefix.",
			artifacts: [],
			steps: [
				{
					type: "command",
					name: "verify",
					command: 'node -e "process.exit(0)"',
					on_success: "ok",
					on_failure: "broken",
				},
				{ type: "terminal", name: "ok", outcome: "success", summary: "passed" },
				{ type: "terminal", name: "broken", outcome: "failure", summary: "failed" },
			],
			entry_step: "verify",
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});
});

describe("Scheduler — implicit retries", () => {
	it("implicitly retries a failing action step up to 3 times then succeeds", async () => {
		const engine = new ScriptedActorEngine(
			new Map([
				["first", [noCompletion("first try"), noCompletion("second try"), completed("next", { note: { ok: 1 } })]],
			]),
		);
		const { scheduler } = buildScheduler(linearPlan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(engine.callCounts().get("first")).toBe(3);
	});

	it("routes to a declared 'failure' edge when implicit retries are exhausted", async () => {
		const plan: PlanDraftDoc = {
			task: "Retry then fail.",
			artifacts: [],
			steps: [
				{
					type: "action",
					name: "try",
					actor: "worker",
					instruction: "Might fail.",
					reads: [],
					writes: [],
					routes: {
						success: "good",
						failure: "bad",
					},
				},
				{ type: "terminal", name: "good", outcome: "success", summary: "ok" },
				{ type: "terminal", name: "bad", outcome: "failure", summary: "no good" },
			],
			entry_step: "try",
		};
		const engine = new ScriptedActorEngine(
			new Map([["try", [engineError("e1"), engineError("e2"), engineError("e3")]]]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("failure");
		expect(report.terminalOutcome).toBe("failure");
		expect(engine.callCounts().get("try")).toBe(3);
	});

	it("emits a synthetic run_finished failure when no fallback route exists", async () => {
		const engine = new ScriptedActorEngine(
			new Map([["first", [engineError("boom"), engineError("boom"), engineError("boom")]]]),
		);
		const { scheduler } = buildScheduler(linearPlan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("failure");
	});
});

describe("Scheduler — abort", () => {
	it("stops scheduling new steps when the abort signal fires before run", async () => {
		const controller = new AbortController();
		controller.abort();
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(linearPlan, engine, {
			signal: controller.signal,
		});
		const report = await scheduler.run();
		expect(report.outcome).toBe("aborted");
		expect(engine.callCounts().size).toBe(0);
	});
});

describe("Scheduler — audit replay", () => {
	it("replaying the captured audit yields an identical final state", async () => {
		const engine = new ScriptedActorEngine(new Map([["first", [completed("next", { note: { ok: 1 } })]]]));
		const { scheduler, program } = buildScheduler(linearPlan, engine);
		await scheduler.run();
		const finalState = scheduler.getState();

		let replayed = initRunState(program);
		for (const event of scheduler.getAudit().entries()) {
			replayed = applyEvent(replayed, event);
		}

		expect(replayed.phase).toBe(finalState.phase);
		expect(replayed.finalOutcome).toBe(finalState.finalOutcome);
		expect(replayed.committedArtifacts.map(unwrap)).toEqual(finalState.committedArtifacts.map(unwrap));
		for (const id of program.stepOrder) {
			const a = replayed.steps.get(id)!;
			const b = finalState.steps.get(id)!;
			expect(a.status).toBe(b.status);
			expect(a.attempts).toBe(b.attempts);
			expect(a.lastRoute).toEqual(b.lastRoute);
		}
	});
});

describe("Scheduler — artifact contract violations", () => {
	it("rejects writes from the wrong step and retries", async () => {
		const plan: PlanDraftDoc = {
			task: "Two-step with contracts.",
			artifacts: [
				{ name: "a", description: "a" },
				{ name: "b", description: "b" },
			],
			steps: [
				{
					type: "action",
					name: "first",
					actor: "worker",
					instruction: "Write a.",
					reads: [],
					writes: ["a"],
					routes: { next: "second" },
				},
				{
					type: "action",
					name: "second",
					actor: "worker",
					instruction: "Write b.",
					reads: ["a"],
					writes: ["b"],
					routes: { done: "end" },
				},
				{ type: "terminal", name: "end", outcome: "success", summary: "ok" },
			],
			entry_step: "first",
		};
		// First attempt: try to write to b (not allowed) — should cause a rejection and a retry.
		const engine = new ScriptedActorEngine(
			new Map([
				["first", [completed("next", { b: "1" }), completed("next", { a: "1" })]],
				["second", [completed("done", { b: "2" })]],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const events: RelayEvent[] = [];
		scheduler.subscribe((e) => events.push(e));
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(events.some((e) => e.type === "artifact_rejected")).toBe(true);
		expect(engine.callCounts().get("first")).toBe(2);
	});
});

describe("Scheduler — terminal routes", () => {
	it("honors a terminal failure as the final outcome", async () => {
		const plan: PlanDraftDoc = {
			task: "Route to failure.",
			artifacts: [],
			steps: [
				{
					type: "action",
					name: "decide",
					actor: "worker",
					instruction: "decide",
					reads: [],
					writes: [],
					routes: { fail: "bad" },
				},
				{
					type: "terminal",
					name: "bad",
					outcome: "failure",
					summary: "decided to fail",
				},
			],
			entry_step: "decide",
		};
		const engine = new ScriptedActorEngine(new Map([["decide", [completed("fail")]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("failure");
		expect(report.terminalOutcome).toBe("failure");
		expect(report.summary).toContain("decided to fail");
	});

	it("produces a chronological attempt timeline for a review/fix loop", async () => {
		const plan: PlanDraftDoc = {
			task: "Loop with back-edge, timeline check.",
			artifacts: [
				{ name: "notes", description: "n", fields: ["v"] },
				{ name: "verdict", description: "v", fields: ["ok"] },
			],
			steps: [
				{
					type: "action",
					name: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					type: "action",
					name: "review",
					actor: "checker",
					instruction: "review",
					reads: ["notes"],
					writes: ["verdict"],
					routes: {
						accepted: "done",
						changes_requested: "fix",
					},
				},
				{
					type: "action",
					name: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict"],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					type: "terminal",
					name: "done",
					outcome: "success",
					summary: "accepted",
				},
			],
			entry_step: "create",
		};
		const engine = new ScriptedActorEngine(
			new Map([
				["create", [completed("done", { notes: { v: 1 } })]],
				[
					"review",
					[
						completed("changes_requested", { verdict: { ok: false } }),
						completed("accepted", { verdict: { ok: true } }),
					],
				],
				["fix", [completed("done", { notes: { v: 2 } })]],
			]),
		);
		const { scheduler, program } = buildScheduler(plan, engine);
		await scheduler.run();
		const timeline = buildAttemptTimeline(scheduler.getAudit().entries(), program);

		// Chronological order: create → review#1 → fix → review#2 → done.
		const order = timeline.map((entry) => `${unwrap(entry.stepId)}#${entry.attempt.attemptNumber}`);
		expect(order).toEqual(["create#1", "review#1", "fix#1", "review#2", "done#1"]);

		// Each review attempt has its own route.
		const reviewEntries = timeline.filter((entry) => unwrap(entry.stepId) === "review");
		expect(reviewEntries.length).toBe(2);
		expect(unwrap(reviewEntries[0]!.attempt.route!)).toBe("changes_requested");
		expect(unwrap(reviewEntries[1]!.attempt.route!)).toBe("accepted");
	});

	it("exposes per-attempt history in the run report for re-entered steps", async () => {
		const plan: PlanDraftDoc = {
			task: "Simple review loop with one iteration.",
			artifacts: [
				{ name: "notes", description: "impl", fields: ["v"] },
				{ name: "verdict", description: "r", fields: ["ok"] },
			],
			steps: [
				{
					type: "action",
					name: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					type: "action",
					name: "review",
					actor: "checker",
					instruction: "review",
					reads: ["notes"],
					writes: ["verdict"],
					routes: {
						accepted: "done",
						changes_requested: "fix",
					},
				},
				{
					type: "action",
					name: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict"],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					type: "terminal",
					name: "done",
					outcome: "success",
					summary: "accepted",
				},
			],
			entry_step: "create",
		};
		const engine = new ScriptedActorEngine(
			new Map([
				["create", [completed("done", { notes: { v: 1 } })]],
				[
					"review",
					[
						completed("changes_requested", { verdict: { ok: false } }),
						completed("accepted", { verdict: { ok: true } }),
					],
				],
				["fix", [completed("done", { notes: { v: 2 } })]],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();

		// The review step should have two attempt records, each with its route.
		const reviewSummary = report.steps.find((s) => unwrap(s.stepId) === "review")!;
		expect(reviewSummary.attemptCount).toBe(2);
		expect(reviewSummary.attempts.length).toBe(2);
		expect(reviewSummary.attempts[0]!.outcome).toBe("completed");
		expect(unwrap(reviewSummary.attempts[0]!.route!)).toBe("changes_requested");
		expect(reviewSummary.attempts[1]!.outcome).toBe("completed");
		expect(unwrap(reviewSummary.attempts[1]!.route!)).toBe("accepted");

		// Total activations includes the re-entry. Terminals don't emit
		// step_started so they don't count: create(1) + review(2) + fix(1) = 4.
		expect(report.totalActivations).toBe(4);
	});

	it("passes priorAttempts to the actor engine on re-entry", async () => {
		const plan: PlanDraftDoc = {
			task: "Loop once.",
			artifacts: [
				{ name: "notes", description: "n", fields: ["v"] },
				{ name: "verdict", description: "v", fields: ["ok"] },
			],
			steps: [
				{
					type: "action",
					name: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					type: "action",
					name: "review",
					actor: "checker",
					instruction: "review",
					reads: ["notes"],
					writes: ["verdict"],
					routes: {
						accepted: "done",
						changes_requested: "fix",
					},
				},
				{
					type: "action",
					name: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict"],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					type: "terminal",
					name: "done",
					outcome: "success",
					summary: "accepted",
				},
			],
			entry_step: "create",
		};
		const engine = new ScriptedActorEngine(
			new Map([
				["create", [completed("done", { notes: { v: 1 } })]],
				[
					"review",
					[
						completed("changes_requested", { verdict: { ok: false } }),
						completed("accepted", { verdict: { ok: true } }),
					],
				],
				["fix", [completed("done", { notes: { v: 2 } })]],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		await scheduler.run();

		// review is called twice; the first call should see 0 prior attempts,
		// the second call should see 1 prior attempt in its request.
		expect(engine.priorAttemptCountsFor("review")).toEqual([0, 1]);
		// Single-attempt steps always see 0 prior attempts.
		expect(engine.priorAttemptCountsFor("create")).toEqual([0]);
		expect(engine.priorAttemptCountsFor("fix")).toEqual([0]);
	});

	it("executes a review/fix loop via back-edges and multi-writer artifacts", async () => {
		const plan: PlanDraftDoc = {
			task: "Review-fix loop.",
			artifacts: [
				{ name: "notes", description: "impl", fields: ["v"] },
				{ name: "verdict", description: "review", fields: ["ok"] },
			],
			steps: [
				{
					type: "action",
					name: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					type: "action",
					name: "review",
					actor: "checker",
					instruction: "review",
					reads: ["notes"],
					writes: ["verdict"],
					routes: {
						accepted: "done",
						changes_requested: "fix",
					},
				},
				{
					type: "action",
					name: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict", "notes"],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					type: "terminal",
					name: "done",
					outcome: "success",
					summary: "accepted",
				},
			],
			entry_step: "create",
		};

		// Script: create ok → review rejects → fix → review accepts.
		const engine = new ScriptedActorEngine(
			new Map([
				["create", [completed("done", { notes: { v: 1 } })]],
				[
					"review",
					[
						completed("changes_requested", { verdict: { ok: false } }),
						completed("accepted", { verdict: { ok: true } }),
					],
				],
				["fix", [completed("done", { notes: { v: 2 } })]],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(engine.callCounts().get("create")).toBe(1);
		expect(engine.callCounts().get("review")).toBe(2);
		expect(engine.callCounts().get("fix")).toBe(1);
	});

	it("halts when an action step exceeds its maxRuns cap", async () => {
		const plan: PlanDraftDoc = {
			task: "Two-actor ping-pong that never converges.",
			artifacts: [{ name: "state", description: "s" }],
			steps: [
				{
					type: "action",
					name: "a",
					actor: "worker",
					instruction: "a",
					reads: [],
					writes: ["state"],
					routes: { next: "b" },
					max_runs: 3,
				},
				{
					type: "action",
					name: "b",
					actor: "checker",
					instruction: "b",
					reads: ["state"],
					writes: [],
					routes: { again: "a" },
					max_runs: 3,
				},
				{ type: "terminal", name: "never", outcome: "success", summary: "never" },
			],
			entry_step: "a",
		};
		const engine = new ScriptedActorEngine(
			new Map([
				["a", [completed("next", { state: "1" })]],
				["b", [completed("again")]],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("incomplete");
		expect(report.summary).toContain("maxRuns cap (3)");
		const runCounts = engine.callCounts();
		expect((runCounts.get("a") ?? 0) + (runCounts.get("b") ?? 0)).toBeLessThanOrEqual(6);
	});

	it("halts a verify-step loop that would otherwise run forever", async () => {
		const plan: PlanDraftDoc = {
			task: "Verify loop with no escape.",
			steps: [
				{
					type: "files_exist",
					name: "check",
					paths: ["/tmp/pi-relay-nonexistent-sentinel-file"],
					on_success: "done",
					on_failure: "check",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("incomplete");
		expect(report.summary).toContain("maxRuns cap");
	});

	it("rejects a completion that routes to a reader without writing the required artifact", async () => {
		const plan: PlanDraftDoc = {
			task: "Diagnose then fix.",
			artifacts: [{ name: "diag", description: "d", fields: ["cause"] }],
			steps: [
				{
					type: "action",
					name: "diagnose",
					actor: "worker",
					instruction: "find bug",
					writes: ["diag"],
					routes: { found: "fix", clean: "done" },
				},
				{
					type: "action",
					name: "fix",
					actor: "worker",
					instruction: "fix it",
					reads: ["diag"],
					routes: { done: "done" },
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(
			new Map([
				["diagnose", [completed("found")]],
				["fix", [completed("done")]],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(["incomplete", "failure"]).toContain(report.outcome);
		expect(report.summary).toContain("did not write");
	});

	it("allows routing without writing when the target does not read the artifact", async () => {
		const plan: PlanDraftDoc = {
			task: "Optional write.",
			artifacts: [{ name: "notes", description: "n" }],
			steps: [
				{
					type: "action",
					name: "work",
					actor: "worker",
					instruction: "do",
					writes: ["notes"],
					routes: { done: "done" },
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(new Map([["work", [completed("done")]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});

	it("marks unreached branches as skipped after run_finished fires", async () => {
		const plan: PlanDraftDoc = {
			task: "Pick the good path, leave the alternate branch unreached.",
			artifacts: [],
			steps: [
				{
					type: "action",
					name: "decide",
					actor: "worker",
					instruction: "decide",
					reads: [],
					writes: [],
					routes: {
						good: "success_terminal",
						bad: "failure_terminal",
					},
				},
				{
					type: "terminal",
					name: "success_terminal",
					outcome: "success",
					summary: "ok",
				},
				{
					type: "terminal",
					name: "failure_terminal",
					outcome: "failure",
					summary: "never reached",
				},
			],
			entry_step: "decide",
		};
		const engine = new ScriptedActorEngine(new Map([["decide", [completed("good")]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		const failureBranch = report.steps.find((s) => unwrap(s.stepId) === "failure_terminal")!;
		expect(failureBranch.status).toBe("skipped");
		const decided = report.steps.find((s) => unwrap(s.stepId) === "decide")!;
		expect(decided.status).toBe("succeeded");
	});
});

describe("Scheduler — command step artifact reads", () => {
	it("provides read artifacts as files in RELAY_INPUT", async () => {
		const plan: PlanDraftDoc = {
			task: "Action writes, command reads from RELAY_INPUT.",
			artifacts: [{ name: "candidate", description: "test value" }],
			steps: [
				{
					type: "action",
					name: "produce",
					actor: "worker",
					instruction: "Write candidate.",
					writes: ["candidate"],
					routes: { done: "check" },
				},
				{
					type: "command",
					name: "check",
					command:
						"node -e \"const v = require('fs').readFileSync(require('path').join(process.env.RELAY_INPUT, 'candidate'), 'utf-8'); process.exit(v === 'hello' ? 0 : 1)\"",
					reads: ["candidate"],
					on_success: "done",
					on_failure: "failed",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
				{ type: "terminal", name: "failed", outcome: "failure", summary: "bad" },
			],
		};
		const engine = new ScriptedActorEngine(new Map([["produce", [completed("done", { candidate: "hello" })]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});

	it("serializes structured artifacts as JSON files in RELAY_INPUT", async () => {
		const plan: PlanDraftDoc = {
			task: "Action writes record, command reads JSON from RELAY_INPUT.",
			artifacts: [{ name: "result", description: "structured", fields: ["score", "label"] }],
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
					command:
						"node -e \"const v = JSON.parse(require('fs').readFileSync(require('path').join(process.env.RELAY_INPUT, 'result'), 'utf-8')); process.exit(v.score === 42 ? 0 : 1)\"",
					reads: ["result"],
					on_success: "done",
					on_failure: "failed",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
				{ type: "terminal", name: "failed", outcome: "failure", summary: "bad" },
			],
		};
		const engine = new ScriptedActorEngine(
			new Map([["produce", [completed("done", { result: { score: 42, label: "good" } })]]]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});

	it("omits input files for artifacts not yet committed", async () => {
		const plan: PlanDraftDoc = {
			task: "Command reads artifact that hasn't been written yet.",
			artifacts: [{ name: "data", description: "d" }],
			steps: [
				{
					type: "action",
					name: "early",
					actor: "worker",
					instruction: "Does not write data.",
					routes: { done: "check" },
				},
				{
					type: "command",
					name: "check",
					command:
						"node -e \"const fs = require('fs'); const p = require('path').join(process.env.RELAY_INPUT || '/nonexistent', 'data'); process.exit(fs.existsSync(p) ? 1 : 0)\"",
					reads: ["data"],
					on_success: "done",
					on_failure: "failed",
				},
				{
					type: "action",
					name: "late",
					actor: "worker",
					instruction: "Writes data but never reached.",
					writes: ["data"],
					routes: { done: "done" },
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
				{ type: "terminal", name: "failed", outcome: "failure", summary: "bad" },
			],
		};
		const engine = new ScriptedActorEngine(new Map([["early", [completed("done")]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});
});

describe("Scheduler — command step writes", () => {
	it("commits a text artifact written to RELAY_OUTPUT by a command step", async () => {
		const plan: PlanDraftDoc = {
			task: "Command writes a text artifact.",
			artifacts: [{ name: "score", description: "score" }],
			steps: [
				{
					type: "command",
					name: "grade",
					command:
						"node -e \"require('fs').writeFileSync(require('path').join(process.env.RELAY_OUTPUT, 'score'), '0.85')\"",
					writes: ["score"],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const events: RelayEvent[] = [];
		scheduler.subscribe((e) => events.push(e));
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(events.some((e) => e.type === "artifact_committed")).toBe(true);
	});

	it("commits a JSON artifact written to RELAY_OUTPUT for a record-shaped contract", async () => {
		const plan: PlanDraftDoc = {
			task: "Command writes a JSON artifact.",
			artifacts: [{ name: "result", description: "result", fields: ["value", "label"] }],
			steps: [
				{
					type: "command",
					name: "grade",
					command:
						"node -e \"require('fs').writeFileSync(require('path').join(process.env.RELAY_OUTPUT, 'result'), JSON.stringify({value: 42, label: 'good'}))\"",
					writes: ["result"],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(report.artifacts.map((a) => unwrap(a.artifactId))).toEqual(["result"]);
	});

	it("commits artifacts even when the command exits non-zero", async () => {
		const plan: PlanDraftDoc = {
			task: "Command fails but still writes.",
			artifacts: [{ name: "feedback", description: "feedback" }],
			steps: [
				{
					type: "command",
					name: "grade",
					command:
						"node -e \"require('fs').writeFileSync(require('path').join(process.env.RELAY_OUTPUT, 'feedback'), 'needs work'); process.exit(1)\"",
					writes: ["feedback"],
					on_success: "ok",
					on_failure: "retry",
				},
				{ type: "terminal", name: "ok", outcome: "success", summary: "ok" },
				{ type: "terminal", name: "retry", outcome: "failure", summary: "failed" },
			],
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const events: RelayEvent[] = [];
		scheduler.subscribe((e) => events.push(e));
		const report = await scheduler.run();
		expect(report.outcome).toBe("failure");
		expect(events.some((e) => e.type === "artifact_committed")).toBe(true);
	});

	it("does not commit when the command writes nothing to RELAY_OUTPUT", async () => {
		const plan: PlanDraftDoc = {
			task: "Command declares writes but produces nothing.",
			artifacts: [{ name: "output", description: "out" }],
			steps: [
				{
					type: "action",
					name: "setup",
					actor: "worker",
					instruction: "Write output so the artifact has a producer.",
					writes: ["output"],
					routes: { done: "grade" },
				},
				{
					type: "command",
					name: "grade",
					command: 'node -e "process.exit(0)"',
					writes: ["output"],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(new Map([["setup", [completed("done", { output: "initial" })]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const events: RelayEvent[] = [];
		scheduler.subscribe((e) => events.push(e));
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		const commandCommits = events.filter((e) => e.type === "artifact_committed" && unwrap(e.writerStep) === "grade");
		expect(commandCommits.length).toBe(0);
	});

	it("skips malformed JSON for record-shaped artifacts without failing the run", async () => {
		const plan: PlanDraftDoc = {
			task: "Command writes invalid JSON for a record artifact.",
			artifacts: [{ name: "result", description: "result", fields: ["score"] }],
			steps: [
				{
					type: "command",
					name: "grade",
					command:
						"node -e \"require('fs').writeFileSync(require('path').join(process.env.RELAY_OUTPUT, 'result'), 'not json')\"",
					writes: ["result"],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const events: RelayEvent[] = [];
		scheduler.subscribe((e) => events.push(e));
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		const commits = events.filter((e) => e.type === "artifact_committed");
		expect(commits.length).toBe(0);
	});
});

describe("Scheduler — verify reader write enforcement", () => {
	it("retries when action routes to a verify reader without writing the required artifact", async () => {
		const plan: PlanDraftDoc = {
			task: "Action must write before verify reads.",
			artifacts: [{ name: "candidate", description: "c" }],
			steps: [
				{
					type: "action",
					name: "produce",
					actor: "worker",
					instruction: "Write candidate.",
					writes: ["candidate"],
					routes: { done: "grade" },
				},
				{
					type: "command",
					name: "grade",
					command: "echo $candidate",
					reads: ["candidate"],
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(
			new Map([["produce", [completed("done"), completed("done", { candidate: "fixed" })]]]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(engine.callCounts().get("produce")).toBe(2);
	});

	it("does not enforce when verify step has no reads", async () => {
		const plan: PlanDraftDoc = {
			task: "Action routes to verify without reads.",
			artifacts: [{ name: "notes", description: "n" }],
			steps: [
				{
					type: "action",
					name: "work",
					actor: "worker",
					instruction: "Work.",
					writes: ["notes"],
					routes: { done: "check" },
				},
				{
					type: "command",
					name: "check",
					command: 'node -e "process.exit(0)"',
					on_success: "done",
					on_failure: "done",
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
		};
		const engine = new ScriptedActorEngine(new Map([["work", [completed("done")]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(engine.callCounts().get("work")).toBe(1);
	});
});

describe("Scheduler — check result forwarding", () => {
	it("passes the prior check result to the next action step on failure", async () => {
		let capturedCheckResult: ActionRequest["priorCheckResult"] | undefined;
		const plan: PlanDraftDoc = {
			task: "Implement then verify, retry on failure.",
			artifacts: [],
			steps: [
				{
					type: "action",
					name: "implement",
					actor: "worker",
					instruction: "implement",
					reads: [],
					writes: [],
					routes: { done: "verify" },
				},
				{
					type: "command",
					name: "verify",
					command: 'node -e "process.exit(1)"',
					on_success: "done",
					on_failure: "fix",
				},
				{
					type: "action",
					name: "fix",
					actor: "worker",
					instruction: "fix the issue",
					reads: [],
					writes: [],
					routes: { done: "done" },
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
			entry_step: "implement",
		};
		const engine = new ScriptedActorEngine(
			new Map([
				["implement", [completed("done")]],
				[
					"fix",
					[
						(request) => {
							capturedCheckResult = request.priorCheckResult;
							return {
								kind: "completed",
								route: RouteId("done"),
								assistant_summary: "Completed.",
								writes: new Map(),
								usage: fakeUsage(),
								transcript: [],
							};
						},
					],
				],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		await scheduler.run();
		expect(capturedCheckResult).toBeDefined();
		expect(capturedCheckResult!.outcome).toBe("failed");
		expect(capturedCheckResult!.description).toContain("node");
		expect(unwrap(capturedCheckResult!.stepId)).toBe("verify");
	});

	it("passes the prior check result on success", async () => {
		let capturedCheckResult: ActionRequest["priorCheckResult"] | undefined;
		const plan: PlanDraftDoc = {
			task: "Check then act.",
			artifacts: [],
			steps: [
				{
					type: "command",
					name: "pre-check",
					command: 'node -e "process.exit(0)"',
					on_success: "act",
					on_failure: "fail",
				},
				{
					type: "action",
					name: "act",
					actor: "worker",
					instruction: "do work",
					reads: [],
					writes: [],
					routes: { done: "done" },
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
				{ type: "terminal", name: "fail", outcome: "failure", summary: "failed" },
			],
			entry_step: "pre-check",
		};
		const engine = new ScriptedActorEngine(
			new Map([
				[
					"act",
					[
						(request) => {
							capturedCheckResult = request.priorCheckResult;
							return {
								kind: "completed",
								route: RouteId("done"),
								assistant_summary: "Completed.",
								writes: new Map(),
								usage: fakeUsage(),
								transcript: [],
							};
						},
					],
				],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		await scheduler.run();
		expect(capturedCheckResult).toBeDefined();
		expect(capturedCheckResult!.outcome).toBe("passed");
	});

	it("does not pass check result when action follows another action", async () => {
		let capturedCheckResult: ActionRequest["priorCheckResult"] | undefined;
		const plan: PlanDraftDoc = {
			task: "Two actions in sequence.",
			artifacts: [],
			steps: [
				{
					type: "action",
					name: "first",
					actor: "worker",
					instruction: "first",
					reads: [],
					writes: [],
					routes: { done: "second" },
				},
				{
					type: "action",
					name: "second",
					actor: "worker",
					instruction: "second",
					reads: [],
					writes: [],
					routes: { done: "done" },
				},
				{ type: "terminal", name: "done", outcome: "success", summary: "ok" },
			],
			entry_step: "first",
		};
		const engine = new ScriptedActorEngine(
			new Map([
				["first", [completed("done")]],
				[
					"second",
					[
						(request) => {
							capturedCheckResult = request.priorCheckResult;
							return {
								kind: "completed",
								route: RouteId("done"),
								assistant_summary: "Completed.",
								writes: new Map(),
								usage: fakeUsage(),
								transcript: [],
							};
						},
					],
				],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		await scheduler.run();
		expect(capturedCheckResult).toBeUndefined();
	});
});
