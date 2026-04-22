import { describe, expect, it } from "vitest";
import type { ActionOutcome, ActionRequest, ActorConfig, ActorEngine, ActorUsage } from "../../src/actors/types.js";
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

const actorConfig = (name: string): ActorConfig => ({
	name,
	description: `Fake ${name}`,
	systemPrompt: "",
	source: "user",
	filePath: `/tmp/${name}.md`,
});

const fakeActorsByName = new Map<ActorId, ActorConfig>([
	[ActorId("worker"), actorConfig("worker")],
	[ActorId("planner"), actorConfig("planner")],
	[ActorId("checker"), actorConfig("checker")],
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
		const stepKey = unwrap(request.step.id);
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
	artifacts: [{ id: "note", description: "n", fields: ["ok"] }],
	steps: [
		{
			kind: "action",
			id: "first",
			actor: "worker",
			instruction: "Produce the note.",
			reads: [],
			writes: ["note"],
			routes: { next: "end" },
		},
		{ kind: "terminal", id: "end", outcome: "success", summary: "All good." },
	],
	entryStep: "first",
};

const buildScheduler = (doc: PlanDraftDoc, engine: ActorEngine, extras: { signal?: AbortSignal } = {}) => {
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
		expect(events.some((e) => e.kind === "action_completed")).toBe(true);
		expect(events.some((e) => e.kind === "artifact_committed")).toBe(true);
		expect(events.some((e) => e.kind === "terminal_reached")).toBe(true);
		expect(events[events.length - 1]!.kind).toBe("run_finished");
	});

	it("routes a command step to its pass edge and continues", async () => {
		const plan: PlanDraftDoc = {
			task: "Run a verify that always passes.",
			artifacts: [],
			steps: [
				{
					kind: "command",
					id: "verify",
					command: 'node -e "process.exit(0)"',
					onSuccess: "ok",
					onFailure: "broken",
				},
				{ kind: "terminal", id: "ok", outcome: "success", summary: "passed" },
				{
					kind: "terminal",
					id: "broken",
					outcome: "failure",
					summary: "failed",
				},
			],
			entryStep: "verify",
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
					kind: "command",
					id: "verify",
					command: 'node -e "process.exit(2)"',
					onSuccess: "ok",
					onFailure: "broken",
				},
				{ kind: "terminal", id: "ok", outcome: "success", summary: "passed" },
				{
					kind: "terminal",
					id: "broken",
					outcome: "failure",
					summary: "failed",
				},
			],
			entryStep: "verify",
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("failure");
		expect(report.terminalOutcome).toBe("failure");
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
					kind: "action",
					id: "try",
					actor: "worker",
					instruction: "Might fail.",
					reads: [],
					writes: [],
					routes: {
						success: "good",
						failure: "bad",
					},
				},
				{ kind: "terminal", id: "good", outcome: "success", summary: "ok" },
				{ kind: "terminal", id: "bad", outcome: "failure", summary: "no good" },
			],
			entryStep: "try",
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
				{ id: "a", description: "a" },
				{ id: "b", description: "b" },
			],
			steps: [
				{
					kind: "action",
					id: "first",
					actor: "worker",
					instruction: "Write a.",
					reads: [],
					writes: ["a"],
					routes: { next: "second" },
				},
				{
					kind: "action",
					id: "second",
					actor: "worker",
					instruction: "Write b.",
					reads: ["a"],
					writes: ["b"],
					routes: { done: "end" },
				},
				{ kind: "terminal", id: "end", outcome: "success", summary: "ok" },
			],
			entryStep: "first",
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
		expect(events.some((e) => e.kind === "artifact_rejected")).toBe(true);
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
					kind: "action",
					id: "decide",
					actor: "worker",
					instruction: "decide",
					reads: [],
					writes: [],
					routes: { fail: "bad" },
				},
				{
					kind: "terminal",
					id: "bad",
					outcome: "failure",
					summary: "decided to fail",
				},
			],
			entryStep: "decide",
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
				{ id: "notes", description: "n", fields: ["v"] },
				{ id: "verdict", description: "v", fields: ["ok"] },
			],
			steps: [
				{
					kind: "action",
					id: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					kind: "action",
					id: "review",
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
					kind: "action",
					id: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict"],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					kind: "terminal",
					id: "done",
					outcome: "success",
					summary: "accepted",
				},
			],
			entryStep: "create",
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
		const timeline = buildAttemptTimeline(scheduler.getAudit().entries());

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
				{ id: "notes", description: "impl", fields: ["v"] },
				{ id: "verdict", description: "r", fields: ["ok"] },
			],
			steps: [
				{
					kind: "action",
					id: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					kind: "action",
					id: "review",
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
					kind: "action",
					id: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict"],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					kind: "terminal",
					id: "done",
					outcome: "success",
					summary: "accepted",
				},
			],
			entryStep: "create",
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
				{ id: "notes", description: "n", fields: ["v"] },
				{ id: "verdict", description: "v", fields: ["ok"] },
			],
			steps: [
				{
					kind: "action",
					id: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					kind: "action",
					id: "review",
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
					kind: "action",
					id: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict"],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					kind: "terminal",
					id: "done",
					outcome: "success",
					summary: "accepted",
				},
			],
			entryStep: "create",
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
				{ id: "notes", description: "impl", fields: ["v"] },
				{ id: "verdict", description: "review", fields: ["ok"] },
			],
			steps: [
				{
					kind: "action",
					id: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					kind: "action",
					id: "review",
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
					kind: "action",
					id: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict", "notes"],
					writes: ["notes"],
					routes: { done: "review" },
				},
				{
					kind: "terminal",
					id: "done",
					outcome: "success",
					summary: "accepted",
				},
			],
			entryStep: "create",
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
			artifacts: [{ id: "state", description: "s" }],
			steps: [
				{
					kind: "action",
					id: "a",
					actor: "worker",
					instruction: "a",
					reads: [],
					writes: ["state"],
					routes: { next: "b" },
					maxRuns: 3,
				},
				{
					kind: "action",
					id: "b",
					actor: "checker",
					instruction: "b",
					reads: ["state"],
					writes: [],
					routes: { again: "a" },
					maxRuns: 3,
				},
				{ kind: "terminal", id: "never", outcome: "success", summary: "never" },
			],
			entryStep: "a",
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
					kind: "files_exist",
					id: "check",
					paths: ["/tmp/pi-relay-nonexistent-sentinel-file"],
					onSuccess: "done",
					onFailure: "check",
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
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
			artifacts: [{ id: "diag", description: "d", fields: ["cause"] }],
			steps: [
				{
					kind: "action",
					id: "diagnose",
					actor: "worker",
					instruction: "find bug",
					writes: ["diag"],
					routes: { found: "fix", clean: "done" },
				},
				{
					kind: "action",
					id: "fix",
					actor: "worker",
					instruction: "fix it",
					reads: ["diag"],
					routes: { done: "done" },
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
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
			artifacts: [{ id: "notes", description: "n" }],
			steps: [
				{
					kind: "action",
					id: "work",
					actor: "worker",
					instruction: "do",
					writes: ["notes"],
					routes: { done: "done" },
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
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
					kind: "action",
					id: "decide",
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
					kind: "terminal",
					id: "success_terminal",
					outcome: "success",
					summary: "ok",
				},
				{
					kind: "terminal",
					id: "failure_terminal",
					outcome: "failure",
					summary: "never reached",
				},
			],
			entryStep: "decide",
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

describe("Scheduler — verify step artifact reads", () => {
	it("injects artifact values as env vars into verify commands", async () => {
		const plan: PlanDraftDoc = {
			task: "Action writes, verify reads via env var.",
			artifacts: [{ id: "candidate", description: "test value" }],
			steps: [
				{
					kind: "action",
					id: "produce",
					actor: "worker",
					instruction: "Write candidate.",
					writes: ["candidate"],
					routes: { done: "check" },
				},
				{
					kind: "command",
					id: "check",
					command: "node -e \"process.exit(process.env.candidate === 'hello' ? 0 : 1)\"",
					reads: ["candidate"],
					onSuccess: "done",
					onFailure: "failed",
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
				{ kind: "terminal", id: "failed", outcome: "failure", summary: "bad" },
			],
		};
		const engine = new ScriptedActorEngine(new Map([["produce", [completed("done", { candidate: "hello" })]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});

	it("serializes structured artifacts as JSON in env vars", async () => {
		const plan: PlanDraftDoc = {
			task: "Action writes record, verify reads JSON.",
			artifacts: [{ id: "result", description: "structured", fields: ["score", "label"] }],
			steps: [
				{
					kind: "action",
					id: "produce",
					actor: "worker",
					instruction: "Write result.",
					writes: ["result"],
					routes: { done: "check" },
				},
				{
					kind: "command",
					id: "check",
					command: 'node -e "const v = JSON.parse(process.env.result); process.exit(v.score === 42 ? 0 : 1)"',
					reads: ["result"],
					onSuccess: "done",
					onFailure: "failed",
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
				{ kind: "terminal", id: "failed", outcome: "failure", summary: "bad" },
			],
		};
		const engine = new ScriptedActorEngine(
			new Map([["produce", [completed("done", { result: { score: 42, label: "good" } })]]]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});

	it("omits env vars for artifacts not yet committed", async () => {
		const plan: PlanDraftDoc = {
			task: "Verify reads artifact that another step writes but hasn't run yet.",
			artifacts: [{ id: "data", description: "d" }],
			steps: [
				{
					kind: "action",
					id: "early",
					actor: "worker",
					instruction: "Does not write data.",
					routes: { done: "check" },
				},
				{
					kind: "command",
					id: "check",
					command: 'node -e "process.exit(process.env.data === undefined ? 0 : 1)"',
					reads: ["data"],
					onSuccess: "done",
					onFailure: "failed",
				},
				{
					kind: "action",
					id: "late",
					actor: "worker",
					instruction: "Writes data but never reached.",
					writes: ["data"],
					routes: { done: "done" },
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
				{ kind: "terminal", id: "failed", outcome: "failure", summary: "bad" },
			],
		};
		const engine = new ScriptedActorEngine(new Map([["early", [completed("done")]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
	});
});

describe("Scheduler — verify reader write enforcement", () => {
	it("retries when action routes to a verify reader without writing the required artifact", async () => {
		const plan: PlanDraftDoc = {
			task: "Action must write before verify reads.",
			artifacts: [{ id: "candidate", description: "c" }],
			steps: [
				{
					kind: "action",
					id: "produce",
					actor: "worker",
					instruction: "Write candidate.",
					writes: ["candidate"],
					routes: { done: "grade" },
				},
				{
					kind: "command",
					id: "grade",
					command: "echo $candidate",
					reads: ["candidate"],
					onSuccess: "done",
					onFailure: "done",
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
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
			artifacts: [{ id: "notes", description: "n" }],
			steps: [
				{
					kind: "action",
					id: "work",
					actor: "worker",
					instruction: "Work.",
					writes: ["notes"],
					routes: { done: "check" },
				},
				{
					kind: "command",
					id: "check",
					command: 'node -e "process.exit(0)"',
					onSuccess: "done",
					onFailure: "done",
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
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
					kind: "action",
					id: "implement",
					actor: "worker",
					instruction: "implement",
					reads: [],
					writes: [],
					routes: { done: "verify" },
				},
				{
					kind: "command",
					id: "verify",
					command: 'node -e "process.exit(1)"',
					onSuccess: "done",
					onFailure: "fix",
				},
				{
					kind: "action",
					id: "fix",
					actor: "worker",
					instruction: "fix the issue",
					reads: [],
					writes: [],
					routes: { done: "done" },
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
			],
			entryStep: "implement",
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
					kind: "command",
					id: "pre-check",
					command: 'node -e "process.exit(0)"',
					onSuccess: "act",
					onFailure: "fail",
				},
				{
					kind: "action",
					id: "act",
					actor: "worker",
					instruction: "do work",
					reads: [],
					writes: [],
					routes: { done: "done" },
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
				{ kind: "terminal", id: "fail", outcome: "failure", summary: "failed" },
			],
			entryStep: "pre-check",
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
					kind: "action",
					id: "first",
					actor: "worker",
					instruction: "first",
					reads: [],
					writes: [],
					routes: { done: "second" },
				},
				{
					kind: "action",
					id: "second",
					actor: "worker",
					instruction: "second",
					reads: [],
					writes: [],
					routes: { done: "done" },
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "ok" },
			],
			entryStep: "first",
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
