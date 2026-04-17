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

import { stripCompletionTag } from "../actors/complete-step.js";
import type {
	ActionOutcome,
	ActionRequest,
	ActorConfig,
	ActorEngine,
	ActorUsage,
	PriorAttempt,
} from "../actors/types.js";
import { emptyUsage } from "../actors/types.js";
import type { ActorId, ArtifactId, RouteId, StepId } from "../plan/ids.js";
import { edgeKey, RouteId as makeRouteId, unwrap } from "../plan/ids.js";
import type { Program } from "../plan/program.js";
import type { ActionStep, CheckStep, Step, TerminalStep } from "../plan/types.js";
import { ArtifactStore } from "./artifacts.js";
import { AuditLog } from "./audit.js";
import { runCheck } from "./checks.js";
import { applyEvent, initRunState, type RelayEvent, type RelayRunState, type RunPhase } from "./events.js";
import {
	type AttemptSummary,
	buildAttemptHistories,
	buildRunReport,
	type RunReport,
	SYNTHETIC_FAILURE_REASON_PREFIX,
} from "./run-report.js";

const DEFAULT_CLOCK = () => Date.now();
const DEFAULT_RETRY_MAX_ATTEMPTS = 1;
const DEFAULT_MAX_RUNS = 10;
const PRIOR_ATTEMPT_NARRATION_LIMIT = 240;
const FAILURE_ROUTE_CANDIDATES = ["failure", "error"] as const;

/** Reduce a full AttemptSummary to the compact shape the engine injects into the actor prompt. */
const summarizePriorAttempt = (attempt: AttemptSummary): PriorAttempt => {
	const toolsCalled: string[] = [];
	const narrationParts: string[] = [];
	for (const item of attempt.transcript) {
		if (item.kind === "tool_call") toolsCalled.push(item.toolName);
		else if (item.kind === "text" && item.text.trim().length > 0) narrationParts.push(item.text);
	}
	const rawNarration = stripCompletionTag(narrationParts.join("\n"));
	const narration = oneLineLimit(rawNarration, PRIOR_ATTEMPT_NARRATION_LIMIT);

	let outcomeLabel: string;
	switch (attempt.outcome) {
		case "completed":
			outcomeLabel = `route: ${attempt.route ? unwrap(attempt.route) : "?"}`;
			break;
		case "no_completion":
			outcomeLabel = `no_completion: ${attempt.reason ?? "no reason"}`;
			break;
		case "engine_error":
			outcomeLabel = `engine_error: ${attempt.reason ?? "no reason"}`;
			break;
		case "check_pass":
			outcomeLabel = "check passed";
			break;
		case "check_fail":
			outcomeLabel = `check failed: ${attempt.reason ?? "no reason"}`;
			break;
		case "terminal":
			outcomeLabel = "terminal reached";
			break;
		case "open":
			outcomeLabel = "open (did not complete)";
			break;
	}

	return { attemptNumber: attempt.attemptNumber, outcomeLabel, narration, toolsCalled };
};

const oneLineLimit = (text: string, limit: number): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= limit) return collapsed;
	return `${collapsed.slice(0, limit)}…`;
};

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

	constructor(config: SchedulerConfig) {
		this.program = config.program;
		this.actorEngine = config.actorEngine;
		this.actorsByName = config.actorsByName;
		this.cwd = config.cwd;
		this.signal = config.signal;
		this.clock = config.clock ?? DEFAULT_CLOCK;
		this.audit = config.audit ?? new AuditLog();
		this.artifactStore = config.artifactStore ?? new ArtifactStore(this.program, this.clock);
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

			const nextId = this.readyQueue.shift();
			if (nextId === undefined) break;
			const step = this.program.steps.get(nextId);
			if (!step) {
				this.finishWith("failed", `scheduler picked unknown step '${unwrap(nextId)}'`);
				return buildRunReport(this.state, this.audit);
			}

			if (step.kind === "action") {
				const maxRuns = step.maxRuns ?? DEFAULT_MAX_RUNS;
				const priorAttempts = this.state.steps.get(nextId)?.attempts ?? 0;
				if (priorAttempts >= maxRuns) {
					this.finishWith(
						"incomplete",
						`step '${unwrap(nextId)}' exceeded its maxRuns cap (${maxRuns}) — the loop through this step is not converging`,
					);
					break;
				}
			}

			await this.executeStep(step);

			if (this.state.phase === "succeeded" || this.state.phase === "failed" || this.state.phase === "aborted") {
				break;
			}
		}

		if (this.state.phase === "running" || this.state.phase === "pending") {
			this.finishWith("incomplete", `ready queue drained without reaching a terminal step`);
		}

		return buildRunReport(this.state, this.audit);
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

		// Build priorAttempts BEFORE emitting step_started, so the history we
		// pass to the actor contains only completed prior attempts — not the
		// one we're about to start. The audit log is the source of truth here
		// because the run state resets transcripts on re-entry.
		const priorAttemptHistory = buildAttemptHistories(this.audit.entries()).get(step.id) ?? [];
		const priorAttempts = priorAttemptHistory.map((entry): PriorAttempt => summarizePriorAttempt(entry));

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
			priorAttempts,
			stepActorResolver: (sid) => {
				const s = this.program.steps.get(sid);
				return s?.kind === "action" ? unwrap(s.actor) : undefined;
			},
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
		const currentAttempt = (this.state.steps.get(step.id)?.attempts ?? 0) + 1;
		const commitResult = this.artifactStore.commit(step.id, writes, currentAttempt);
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
