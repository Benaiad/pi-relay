import { describe, expect, it } from "vitest";
import type { ActionOutcome, ActionRequest, ActorConfig, ActorEngine, ActorUsage } from "../../src/actors/types.js";
import { emptyUsage } from "../../src/actors/types.js";
import { type ActorRegistry, compile } from "../../src/plan/compile.js";
import type { PlanDraftDoc } from "../../src/plan/draft.js";
import { ActorId, ArtifactId, RouteId, unwrap } from "../../src/plan/ids.js";
import { isOk } from "../../src/plan/result.js";
import { applyEvent, initRunState, type RelayEvent } from "../../src/runtime/events.js";
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
	private calls: Array<{ stepId: string; attempt: number }> = [];
	constructor(private readonly script: Map<string, ScriptEntry[]>) {}

	async runAction(request: ActionRequest): Promise<ActionOutcome> {
		const stepKey = unwrap(request.step.id);
		const entries = this.script.get(stepKey) ?? [];
		const priorCalls = this.calls.filter((c) => c.stepId === stepKey).length;
		this.calls.push({ stepId: stepKey, attempt: priorCalls + 1 });
		const entry = entries[priorCalls] ?? entries[entries.length - 1];
		if (!entry) {
			return { kind: "engine_error", reason: `no script entry for ${stepKey}`, usage: emptyUsage(), transcript: [] };
		}
		return entry(request);
	}

	callCounts(): ReadonlyMap<string, number> {
		const counts = new Map<string, number>();
		for (const c of this.calls) counts.set(c.stepId, (counts.get(c.stepId) ?? 0) + 1);
		return counts;
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
	artifacts: [{ id: "note", description: "n", shape: { kind: "untyped_json" } }],
	steps: [
		{
			kind: "action",
			id: "first",
			actor: "worker",
			instruction: "Produce the note.",
			reads: [],
			writes: ["note"],
			routes: [{ route: "next", to: "end" }],
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

	it("routes a check step to its pass edge and continues", async () => {
		const plan: PlanDraftDoc = {
			task: "Run a check that always passes.",
			artifacts: [],
			steps: [
				{
					kind: "check",
					id: "verify",
					check: { kind: "command_exits_zero", command: "node", args: ["-e", "process.exit(0)"] },
					onPass: "ok",
					onFail: "broken",
				},
				{ kind: "terminal", id: "ok", outcome: "success", summary: "passed" },
				{ kind: "terminal", id: "broken", outcome: "failure", summary: "failed" },
			],
			entryStep: "verify",
		};
		const engine = new ScriptedActorEngine(new Map());
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(report.steps.find((s) => unwrap(s.stepId) === "verify")!.lastRoute).toEqual(RouteId("pass"));
	});

	it("routes a check step to its fail edge when the check fails", async () => {
		const plan: PlanDraftDoc = {
			task: "Run a check that always fails.",
			artifacts: [],
			steps: [
				{
					kind: "check",
					id: "verify",
					check: { kind: "command_exits_zero", command: "node", args: ["-e", "process.exit(2)"] },
					onPass: "ok",
					onFail: "broken",
				},
				{ kind: "terminal", id: "ok", outcome: "success", summary: "passed" },
				{ kind: "terminal", id: "broken", outcome: "failure", summary: "failed" },
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

describe("Scheduler — retries", () => {
	it("retries an action step up to maxAttempts before failing", async () => {
		const plan: PlanDraftDoc = {
			...linearPlan,
			steps: [
				{
					...(linearPlan.steps[0] as Extract<PlanDraftDoc["steps"][number], { kind: "action" }>),
					retry: { maxAttempts: 3 },
				},
				linearPlan.steps[1]!,
			],
		};
		const engine = new ScriptedActorEngine(
			new Map([
				["first", [noCompletion("first try"), noCompletion("second try"), completed("next", { note: { ok: 1 } })]],
			]),
		);
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("success");
		expect(engine.callCounts().get("first")).toBe(3);
	});

	it("routes to a declared 'failure' edge when retries are exhausted", async () => {
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
					routes: [
						{ route: "success", to: "good" },
						{ route: "failure", to: "bad" },
					],
					retry: { maxAttempts: 2 },
				},
				{ kind: "terminal", id: "good", outcome: "success", summary: "ok" },
				{ kind: "terminal", id: "bad", outcome: "failure", summary: "no good" },
			],
			entryStep: "try",
		};
		const engine = new ScriptedActorEngine(new Map([["try", [engineError("e1"), engineError("e2")]]]));
		const { scheduler } = buildScheduler(plan, engine);
		const report = await scheduler.run();
		expect(report.outcome).toBe("failure");
		expect(report.terminalOutcome).toBe("failure");
		expect(engine.callCounts().get("try")).toBe(2);
	});

	it("emits a synthetic run_finished failure when no fallback route exists", async () => {
		const engine = new ScriptedActorEngine(new Map([["first", [engineError("boom")]]]));
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
		const { scheduler } = buildScheduler(linearPlan, engine, { signal: controller.signal });
		const report = await scheduler.run();
		expect(report.outcome).toBe("aborted");
		expect(engine.callCounts().size).toBe(0);
	});
});

describe("Scheduler — audit replay", () => {
	it("replaying the captured audit yields an identical final state", async () => {
		const engine = new ScriptedActorEngine(new Map([["first", [completed("next", { note: 1 })]]]));
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
				{ id: "a", description: "a", shape: { kind: "untyped_json" } },
				{ id: "b", description: "b", shape: { kind: "untyped_json" } },
			],
			steps: [
				{
					kind: "action",
					id: "first",
					actor: "worker",
					instruction: "Write a.",
					reads: [],
					writes: ["a"],
					routes: [{ route: "next", to: "second" }],
					retry: { maxAttempts: 2 },
				},
				{
					kind: "action",
					id: "second",
					actor: "worker",
					instruction: "Write b.",
					reads: ["a"],
					writes: ["b"],
					routes: [{ route: "done", to: "end" }],
				},
				{ kind: "terminal", id: "end", outcome: "success", summary: "ok" },
			],
			entryStep: "first",
		};
		// First attempt: try to write to b (not allowed) — should cause a rejection and a retry.
		const engine = new ScriptedActorEngine(
			new Map([
				["first", [completed("next", { b: 1 }), completed("next", { a: 1 })]],
				["second", [completed("done", { b: 2 })]],
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
					routes: [{ route: "fail", to: "bad" }],
				},
				{ kind: "terminal", id: "bad", outcome: "failure", summary: "decided to fail" },
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

	it("executes a review/fix loop via back-edges and multi-writer artifacts", async () => {
		const plan: PlanDraftDoc = {
			task: "Review-fix loop.",
			artifacts: [
				{ id: "notes", description: "impl", shape: { kind: "untyped_json" }, multiWriter: true },
				{ id: "verdict", description: "review", shape: { kind: "untyped_json" }, multiWriter: true },
			],
			steps: [
				{
					kind: "action",
					id: "create",
					actor: "worker",
					instruction: "create",
					reads: [],
					writes: ["notes"],
					routes: [{ route: "done", to: "review" }],
				},
				{
					kind: "action",
					id: "review",
					actor: "checker",
					instruction: "review",
					reads: ["notes"],
					writes: ["verdict"],
					routes: [
						{ route: "accepted", to: "done" },
						{ route: "changes_requested", to: "fix" },
					],
				},
				{
					kind: "action",
					id: "fix",
					actor: "worker",
					instruction: "fix",
					reads: ["verdict", "notes"],
					writes: ["notes"],
					routes: [{ route: "done", to: "review" }],
				},
				{ kind: "terminal", id: "done", outcome: "success", summary: "accepted" },
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

	it("halts with incomplete when a loop exceeds maxActivations", async () => {
		const plan: PlanDraftDoc = {
			task: "Infinite loop — should be capped.",
			artifacts: [{ id: "state", description: "s", shape: { kind: "untyped_json" }, multiWriter: true }],
			steps: [
				{
					kind: "action",
					id: "spin",
					actor: "worker",
					instruction: "spin",
					reads: [],
					writes: ["state"],
					routes: [{ route: "loop", to: "spin" }],
				},
				{ kind: "terminal", id: "end", outcome: "success", summary: "never" },
			],
			entryStep: "spin",
		};
		const engine = new ScriptedActorEngine(new Map([["spin", [completed("loop", { state: 1 })]]]));
		const compiled = compile(plan, actorRegistry, { generateId: () => "pid" });
		if (!isOk(compiled)) throw new Error("compile should succeed");
		const clock = new StubClock();
		const scheduler = new Scheduler({
			program: compiled.value,
			actorEngine: engine,
			actorsByName: fakeActorsByName,
			cwd: process.cwd(),
			clock: () => clock.next(),
			maxActivations: 5,
		});
		const report = await scheduler.run();
		expect(report.outcome).toBe("incomplete");
		expect(report.summary).toContain("activation limit reached");
		expect(engine.callCounts().get("spin")).toBe(5);
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
					routes: [
						{ route: "good", to: "success_terminal" },
						{ route: "bad", to: "failure_terminal" },
					],
				},
				{ kind: "terminal", id: "success_terminal", outcome: "success", summary: "ok" },
				{ kind: "terminal", id: "failure_terminal", outcome: "failure", summary: "never reached" },
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
