/**
 * Sequential ready-queue scheduler.
 *
 * The scheduler executes a compiled `Program` as a DAG of `Action`, `Check`,
 * and `Terminal` steps. The MVP implementation is strictly sequential: one
 * step runs at a time. Parallel execution and `Join` steps land in v0.2 and
 * will slot in without changing the event protocol or the reducer.
 *
 * Loop:
 *
 *   1. Seed the ready queue with the program's entry step.
 *   2. While the queue is non-empty and not aborted:
 *      a. Pop the next step.
 *      b. Dispatch by kind. Action → actor engine. Check → check engine.
 *         Terminal → emit `terminal_reached` and stop.
 *      c. Apply retry policy on action failures.
 *      d. On successful completion, commit writes via the artifact store
 *         and follow the emitted route to the next step.
 *   3. On abort, drain in-flight work (there is only ever one in sequential
 *      mode, but the signal is forwarded to its AbortController so the
 *      subprocess sees it).
 *
 * Retry policy: an action step that returns `no_completion` or
 * `engine_error` increments its attempt count. If attempts < `maxAttempts`
 * (default 1 — single attempt, no retry), the step is re-queued. Otherwise
 * the scheduler looks for a route named `failure` or `error` on the step
 * and follows it; if neither exists, it emits a synthetic `step_failed`
 * event and falls back to a terminal failure.
 *
 * Time is injected via `clock` so tests can pin timestamps. The scheduler
 * never calls `Date.now` directly.
 */

import type { ActionOutcome, ActionRequest, ActorConfig, ActorEngine, ActorUsage } from "../actors/types.js";
import { emptyUsage } from "../actors/types.js";
import type { ActorId, ArtifactId, RouteId, StepId } from "../plan/ids.js";
import { edgeKey, RouteId as makeRouteId, unwrap } from "../plan/ids.js";
import type { Program } from "../plan/program.js";
import type { ActionStep, CheckStep, Step, TerminalStep } from "../plan/types.js";
import { ArtifactStore } from "./artifacts.js";
import { AuditLog } from "./audit.js";
import { runCheck } from "./checks.js";
import { applyEvent, initRunState, type RelayEvent, type RelayRunState, type RunPhase } from "./events.js";
import { buildRunReport, type RunReport, SYNTHETIC_FAILURE_REASON_PREFIX } from "./run-report.js";

const DEFAULT_CLOCK = () => Date.now();
const DEFAULT_RETRY_MAX_ATTEMPTS = 1;
const DEFAULT_MAX_ACTIVATIONS = 64;
const DEFAULT_MAX_STEP_RUNS = 10;
const FAILURE_ROUTE_CANDIDATES = ["failure", "error"] as const;

export interface SchedulerConfig {
	readonly program: Program;
	readonly actorEngine: ActorEngine;
	readonly actorsByName: ReadonlyMap<ActorId, ActorConfig>;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly clock?: () => number;
	readonly artifactStore?: ArtifactStore;
	readonly audit?: AuditLog;
	readonly maxConcurrency?: number;
	/**
	 * Maximum total step activations per run, across all steps.
	 *
	 * Global safety net — catches plans with many steps where no single
	 * step trips its per-step cap. Defaults to 64, which allows a
	 * sequential 60-step plan with some retries or a 2-step review/fix
	 * loop that runs up to 32 iterations.
	 */
	readonly maxActivations?: number;

	/**
	 * Maximum times any single step may run within one scheduler run.
	 *
	 * Primary guard against non-converging loops between actors. A
	 * review/fix pair that keeps ping-ponging without making progress
	 * will trip this cap on the first side that reaches it, and the run
	 * halts with an `incomplete` outcome naming the offending step.
	 * Defaults to 10 — enough for legitimate loops (most review cycles
	 * converge in 1–3 iterations), tight enough that a pathology is
	 * caught early.
	 */
	readonly maxStepRuns?: number;
}

export interface SchedulerSubscription {
	unsubscribe(): void;
}

export type SchedulerEventHandler = (event: RelayEvent) => void;

export class Scheduler {
	private readonly program: Program;
	private readonly actorEngine: ActorEngine;
	private readonly actorsByName: ReadonlyMap<ActorId, ActorConfig>;
	private readonly cwd: string;
	private readonly signal?: AbortSignal;
	private readonly clock: () => number;
	private readonly audit: AuditLog;
	private readonly artifactStore: ArtifactStore;

	private state: RelayRunState;
	private readyQueue: StepId[] = [];
	private handlers: SchedulerEventHandler[] = [];
	private hasRun = false;
	private activationCount = 0;
	private readonly maxActivations: number;
	private readonly maxStepRuns: number;

	constructor(config: SchedulerConfig) {
		this.program = config.program;
		this.actorEngine = config.actorEngine;
		this.actorsByName = config.actorsByName;
		this.cwd = config.cwd;
		this.signal = config.signal;
		this.clock = config.clock ?? DEFAULT_CLOCK;
		this.audit = config.audit ?? new AuditLog();
		this.artifactStore = config.artifactStore ?? new ArtifactStore(this.program, this.clock);
		this.maxActivations = config.maxActivations ?? DEFAULT_MAX_ACTIVATIONS;
		this.maxStepRuns = config.maxStepRuns ?? DEFAULT_MAX_STEP_RUNS;
		this.state = initRunState(this.program);
	}

	subscribe(handler: SchedulerEventHandler): SchedulerSubscription {
		this.handlers.push(handler);
		return {
			unsubscribe: () => {
				this.handlers = this.handlers.filter((h) => h !== handler);
			},
		};
	}

	getAudit(): AuditLog {
		return this.audit;
	}

	getState(): RelayRunState {
		return this.state;
	}

	async run(): Promise<RunReport> {
		if (this.hasRun) {
			throw new Error("Scheduler.run() may only be called once per instance");
		}
		this.hasRun = true;

		this.emit({ kind: "run_started", at: this.clock(), planId: this.program.id });
		this.enqueueReady(this.program.entryStep);

		while (this.readyQueue.length > 0) {
			if (this.signal?.aborted) {
				this.emit({ kind: "run_aborted", at: this.clock() });
				break;
			}

			if (this.activationCount >= this.maxActivations) {
				this.finishWith(
					"incomplete",
					`activation limit reached (${this.maxActivations}) — the plan is looping without converging on a terminal`,
				);
				break;
			}

			const nextId = this.readyQueue.shift();
			if (nextId === undefined) break;
			const step = this.program.steps.get(nextId);
			if (!step) {
				this.finishWith("failed", `scheduler picked unknown step '${unwrap(nextId)}'`);
				return buildRunReport(this.state);
			}

			// Per-step run cap. The primary guard against non-converging loops
			// between actors: once any step has run `maxStepRuns` times, we
			// assume the loop isn't making progress and halt. The offending
			// step id goes in the summary so the model and user can see
			// which actor was spinning.
			const priorAttempts = this.state.steps.get(nextId)?.attempts ?? 0;
			if (priorAttempts >= this.maxStepRuns) {
				this.finishWith(
					"incomplete",
					`step '${unwrap(nextId)}' exceeded the per-step run cap (${this.maxStepRuns}) — the loop through this step is not converging`,
				);
				break;
			}

			this.activationCount += 1;
			await this.executeStep(step);

			if (this.state.phase === "succeeded" || this.state.phase === "failed" || this.state.phase === "aborted") {
				break;
			}
		}

		if (this.state.phase === "running" || this.state.phase === "pending") {
			this.finishWith("incomplete", `ready queue drained without reaching a terminal step`);
		}

		return buildRunReport(this.state);
	}

	// ==========================================================================
	// Internal: event emission
	// ==========================================================================

	private emit(event: RelayEvent): void {
		this.audit.append(event);
		this.state = applyEvent(this.state, event);
		for (const handler of this.handlers) {
			try {
				handler(event);
			} catch {
				// Subscribers are best-effort; a throwing renderer must not kill the scheduler.
			}
		}
	}

	private enqueueReady(stepId: StepId): void {
		this.emit({ kind: "step_ready", at: this.clock(), stepId });
		this.readyQueue.push(stepId);
	}

	private finishWith(phase: RunPhase, summary: string): void {
		this.emit({ kind: "run_finished", at: this.clock(), phase, summary });
	}

	// ==========================================================================
	// Internal: step dispatch
	// ==========================================================================

	private async executeStep(step: Step): Promise<void> {
		switch (step.kind) {
			case "action":
				await this.executeAction(step);
				return;
			case "check":
				await this.executeCheck(step);
				return;
			case "terminal":
				this.executeTerminal(step);
				return;
		}
	}

	private async executeAction(step: ActionStep): Promise<void> {
		const actor = this.actorsByName.get(step.actor);
		if (!actor) {
			this.emit({
				kind: "step_failed",
				at: this.clock(),
				stepId: step.id,
				reason: `actor '${unwrap(step.actor)}' not found at runtime`,
			});
			this.followFailureOrTerminal(step, `actor '${unwrap(step.actor)}' not found`);
			return;
		}

		const attempt = (this.state.steps.get(step.id)?.attempts ?? 0) + 1;
		this.emit({ kind: "step_started", at: this.clock(), stepId: step.id, attempt });

		const snapshot = this.artifactStore.snapshot(step.reads);
		const request: ActionRequest = {
			step,
			actor,
			artifacts: snapshot,
			artifactContracts: this.program.artifacts,
			cwd: this.cwd,
			signal: this.signal,
			onProgress: (progress) => {
				this.emit({
					kind: "action_progress",
					at: this.clock(),
					stepId: step.id,
					item: progress.item,
					usage: progress.usage,
				});
			},
		};

		let outcome: ActionOutcome;
		try {
			outcome = await this.actorEngine.runAction(request);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			outcome = { kind: "engine_error", reason, usage: emptyUsage(), transcript: [] };
		}

		switch (outcome.kind) {
			case "completed":
				this.handleActionCompleted(step, outcome.route, outcome.writes, outcome.usage);
				return;
			case "no_completion":
				this.emit({
					kind: "action_no_completion",
					at: this.clock(),
					stepId: step.id,
					reason: outcome.reason,
					usage: outcome.usage,
				});
				this.applyRetryOrFail(step, outcome.reason);
				return;
			case "engine_error":
				this.emit({
					kind: "action_engine_error",
					at: this.clock(),
					stepId: step.id,
					reason: outcome.reason,
					usage: outcome.usage,
				});
				this.applyRetryOrFail(step, outcome.reason);
				return;
			case "aborted":
				this.emit({ kind: "run_aborted", at: this.clock() });
				return;
		}
	}

	private handleActionCompleted(
		step: ActionStep,
		route: RouteId,
		writes: ReadonlyMap<ArtifactId, unknown>,
		usage: ActorUsage,
	): void {
		const commitResult = this.artifactStore.commit(step.id, writes);
		if (!commitResult.ok) {
			this.emit({
				kind: "artifact_rejected",
				at: this.clock(),
				stepId: step.id,
				violation: commitResult.error,
			});
			this.applyRetryOrFail(step, `artifact commit rejected: ${commitResult.error.kind}`);
			return;
		}
		for (const artifactId of writes.keys()) {
			this.emit({
				kind: "artifact_committed",
				at: this.clock(),
				artifactId,
				writerStep: step.id,
			});
		}
		this.emit({ kind: "action_completed", at: this.clock(), stepId: step.id, route, usage });
		this.followRoute(step.id, route);
	}

	private async executeCheck(step: CheckStep): Promise<void> {
		const attempt = (this.state.steps.get(step.id)?.attempts ?? 0) + 1;
		this.emit({ kind: "step_started", at: this.clock(), stepId: step.id, attempt });

		const outcome = await runCheck(step.check, { cwd: this.cwd, signal: this.signal });
		if (outcome.kind === "pass") {
			this.emit({ kind: "check_passed", at: this.clock(), stepId: step.id });
			this.followRoute(step.id, makeRouteId("pass"));
		} else {
			this.emit({ kind: "check_failed", at: this.clock(), stepId: step.id, reason: outcome.reason });
			this.followRoute(step.id, makeRouteId("fail"));
		}
	}

	private executeTerminal(step: TerminalStep): void {
		this.emit({
			kind: "terminal_reached",
			at: this.clock(),
			stepId: step.id,
			outcome: step.outcome,
			summary: step.summary,
		});
		this.finishWith(step.outcome === "success" ? "succeeded" : "failed", step.summary);
	}

	// ==========================================================================
	// Internal: retry, routing, terminal
	// ==========================================================================

	private applyRetryOrFail(step: ActionStep, reason: string): void {
		const runtime = this.state.steps.get(step.id);
		const attempts = runtime?.attempts ?? 1;
		const maxAttempts = step.retry?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS;
		if (attempts < maxAttempts) {
			this.emit({
				kind: "step_retry_scheduled",
				at: this.clock(),
				stepId: step.id,
				nextAttempt: attempts + 1,
				reason,
			});
			this.readyQueue.unshift(step.id);
			return;
		}
		this.emit({ kind: "step_failed", at: this.clock(), stepId: step.id, reason });
		this.followFailureOrTerminal(step, `${SYNTHETIC_FAILURE_REASON_PREFIX}${reason}`);
	}

	private followFailureOrTerminal(step: ActionStep, reason: string): void {
		for (const candidate of FAILURE_ROUTE_CANDIDATES) {
			const routeId = makeRouteId(candidate);
			const target = this.program.edges.get(edgeKey(step.id, routeId));
			if (target !== undefined) {
				this.followRoute(step.id, routeId);
				return;
			}
		}
		this.finishWith("failed", reason);
	}

	private followRoute(fromStep: StepId, route: RouteId): void {
		const target = this.program.edges.get(edgeKey(fromStep, route));
		if (target === undefined) {
			this.finishWith(
				"incomplete",
				`no edge from '${unwrap(fromStep)}' on route '${unwrap(route)}'; plan is missing a handler for that outcome`,
			);
			return;
		}
		this.enqueueReady(target);
	}
}
