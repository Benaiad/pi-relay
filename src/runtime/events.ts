/**
 * Scheduler events and the run-state reducer.
 *
 * `RelayEvent` is the discriminated union of every state change the scheduler
 * emits. The audit log stores these events, the renderer consumes them via
 * `onUpdate`, and `applyEvent` is the pure reducer that turns an event stream
 * into a `RelayRunState` snapshot. `applyEvent` is the ONLY function that
 * mutates run state — scheduler code, audit replay, and tests all go through
 * it, which makes the audit log the single source of truth.
 *
 * A test in `audit-replay.test.ts` asserts that running the scheduler and
 * then replaying the captured audit log through `applyEvent` yields an
 * identical state. Keep this property when adding event kinds.
 */

import type { ActorUsage, TranscriptItem } from "../actors/types.js";
import type { ArtifactId, PlanId, RouteId, StepId } from "../plan/ids.js";
import { RouteId as makeRouteId } from "../plan/ids.js";
import type { Program } from "../plan/program.js";
import type { TerminalOutcome } from "../plan/types.js";
import { type ContractViolation, formatContractViolation } from "./artifacts.js";

/** The current lifecycle phase of the run as a whole. */
export type RunPhase = "pending" | "running" | "succeeded" | "failed" | "aborted" | "incomplete";

/**
 * Status of an individual step in the DAG.
 *
 *   - `pending`   — not yet ready (upstream hasn't routed to it)
 *   - `ready`     — queued, waiting for the scheduler to pick it
 *   - `running`   — actively being executed
 *   - `retrying`  — transient state between a failed attempt and the next
 *   - `succeeded` — completed successfully and committed writes
 *   - `failed`    — exhausted retries; terminal for this step
 *   - `skipped`   — reachable via a route not taken; not used in MVP
 */
export type StepStatus = "pending" | "ready" | "running" | "retrying" | "succeeded" | "failed" | "skipped";

/** Per-step runtime state, derived by `applyEvent`. */
export interface StepRuntimeState {
	readonly status: StepStatus;
	readonly attempts: number;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly lastRoute?: RouteId;
	readonly lastReason?: string;
	readonly usage: ActorUsage;
	readonly transcript: readonly TranscriptItem[];
}

/** Aggregate run state — what the renderer displays and the report builder reads. */
export interface RelayRunState {
	readonly program: Program;
	readonly phase: RunPhase;
	readonly steps: ReadonlyMap<StepId, StepRuntimeState>;
	readonly committedArtifacts: readonly ArtifactId[];
	readonly currentlyRunning: readonly StepId[];
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly totalUsage: ActorUsage;
	readonly finalOutcome?: TerminalOutcome;
	readonly finalSummary?: string;
	readonly eventCount: number;
}

/** Every state change the scheduler emits. */
export type RelayEvent =
	| { readonly kind: "run_started"; readonly at: number; readonly planId: PlanId }
	| { readonly kind: "step_ready"; readonly at: number; readonly stepId: StepId }
	| { readonly kind: "step_started"; readonly at: number; readonly stepId: StepId; readonly attempt: number }
	| {
			readonly kind: "action_progress";
			readonly at: number;
			readonly stepId: StepId;
			readonly item: TranscriptItem;
			readonly usage: ActorUsage;
	  }
	| {
			readonly kind: "action_completed";
			readonly at: number;
			readonly stepId: StepId;
			readonly route: RouteId;
			readonly usage: ActorUsage;
	  }
	| {
			readonly kind: "action_no_completion";
			readonly at: number;
			readonly stepId: StepId;
			readonly reason: string;
			readonly usage: ActorUsage;
	  }
	| {
			readonly kind: "action_engine_error";
			readonly at: number;
			readonly stepId: StepId;
			readonly reason: string;
			readonly usage: ActorUsage;
	  }
	| { readonly kind: "check_passed"; readonly at: number; readonly stepId: StepId }
	| { readonly kind: "check_failed"; readonly at: number; readonly stepId: StepId; readonly reason: string }
	| {
			readonly kind: "artifact_committed";
			readonly at: number;
			readonly artifactId: ArtifactId;
			readonly writerStep: StepId;
	  }
	| {
			readonly kind: "artifact_rejected";
			readonly at: number;
			readonly stepId: StepId;
			readonly violation: ContractViolation;
	  }
	| {
			readonly kind: "step_retry_scheduled";
			readonly at: number;
			readonly stepId: StepId;
			readonly nextAttempt: number;
			readonly reason: string;
	  }
	| { readonly kind: "step_failed"; readonly at: number; readonly stepId: StepId; readonly reason: string }
	| {
			readonly kind: "terminal_reached";
			readonly at: number;
			readonly stepId: StepId;
			readonly outcome: TerminalOutcome;
			readonly summary: string;
	  }
	| { readonly kind: "run_finished"; readonly at: number; readonly phase: RunPhase; readonly summary: string }
	| { readonly kind: "run_aborted"; readonly at: number };

// ============================================================================
// Reducer
// ============================================================================

const zeroUsage = (): ActorUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

/**
 * Construct the initial run state from a compiled program.
 *
 * Every step starts `pending` except the entry step, which starts `ready`.
 */
export const initRunState = (program: Program): RelayRunState => {
	const steps = new Map<StepId, StepRuntimeState>();
	for (const stepId of program.stepOrder) {
		steps.set(stepId, {
			status: stepId === program.entryStep ? "ready" : "pending",
			attempts: 0,
			usage: zeroUsage(),
			transcript: [],
		});
	}
	return {
		program,
		phase: "pending",
		steps,
		committedArtifacts: [],
		currentlyRunning: [],
		totalUsage: zeroUsage(),
		eventCount: 0,
	};
};

/**
 * Pure reducer from an event to the next run state.
 *
 * Returns a new state object — never mutates its input. The reducer is total:
 * every `RelayEvent` has a branch, enforced by `switch` exhaustiveness.
 */
export const applyEvent = (state: RelayRunState, event: RelayEvent): RelayRunState => {
	const nextEventCount = state.eventCount + 1;
	switch (event.kind) {
		case "run_started":
			return { ...state, phase: "running", startedAt: event.at, eventCount: nextEventCount };

		case "step_ready":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: s.status === "succeeded" ? s.status : "ready",
				})),
				eventCount: nextEventCount,
			};

		case "step_started": {
			// On re-entry, clear the per-step transcript so the display only
			// reflects the CURRENT attempt — otherwise two attempts' narrations
			// merge into an unreadable block. Users see the attempt counter to
			// know there was history; the audit log still has every event and
			// the run report reconstructs full per-attempt history from it.
			//
			// Usage does NOT reset. action_progress overwrites step.usage with
			// each event's value, so the display shows the current attempt's
			// usage as soon as the first progress event fires. totalUsage is
			// accumulated on action_completed / no_completion / engine_error
			// via direct addition (no diff math), so no reset is required for
			// correctness either.
			const priorAttempts = state.steps.get(event.stepId)?.attempts ?? 0;
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: "running",
					attempts: s.attempts + 1,
					startedAt: s.startedAt ?? event.at,
					transcript: priorAttempts > 0 ? [] : s.transcript,
				})),
				currentlyRunning: addUnique(state.currentlyRunning, event.stepId),
				eventCount: nextEventCount,
			};
		}

		case "action_progress":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					transcript: [...s.transcript, event.item],
					usage: event.usage,
				})),
				eventCount: nextEventCount,
			};

		case "action_completed":
			// event.usage is the subprocess's final usage for THIS attempt —
			// each attempt runs in its own subprocess, so summing event.usage
			// on every completion gives the correct total across attempts.
			// No diff math, no reset ceremony: just direct addition.
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: "succeeded",
					finishedAt: event.at,
					lastRoute: event.route,
					usage: event.usage,
				})),
				currentlyRunning: removeOne(state.currentlyRunning, event.stepId),
				totalUsage: addUsage(state.totalUsage, event.usage),
				eventCount: nextEventCount,
			};

		case "action_no_completion":
		case "action_engine_error":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: "retrying",
					lastReason: event.reason,
					usage: event.usage,
				})),
				currentlyRunning: removeOne(state.currentlyRunning, event.stepId),
				totalUsage: addUsage(state.totalUsage, event.usage),
				eventCount: nextEventCount,
			};

		case "check_passed":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: "succeeded",
					finishedAt: event.at,
					lastRoute: CHECK_PASS,
				})),
				currentlyRunning: removeOne(state.currentlyRunning, event.stepId),
				eventCount: nextEventCount,
			};

		case "check_failed":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: "succeeded",
					finishedAt: event.at,
					lastRoute: CHECK_FAIL,
					lastReason: event.reason,
				})),
				currentlyRunning: removeOne(state.currentlyRunning, event.stepId),
				eventCount: nextEventCount,
			};

		case "artifact_committed":
			return {
				...state,
				committedArtifacts: state.committedArtifacts.includes(event.artifactId)
					? state.committedArtifacts
					: [...state.committedArtifacts, event.artifactId],
				eventCount: nextEventCount,
			};

		case "artifact_rejected":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					lastReason: `artifact rejected: ${describeViolation(event.violation)}`,
				})),
				eventCount: nextEventCount,
			};

		case "step_retry_scheduled":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: "ready",
					lastReason: event.reason,
				})),
				eventCount: nextEventCount,
			};

		case "step_failed":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: "failed",
					finishedAt: event.at,
					lastReason: event.reason,
				})),
				currentlyRunning: removeOne(state.currentlyRunning, event.stepId),
				eventCount: nextEventCount,
			};

		case "terminal_reached":
			return {
				...state,
				steps: updateStep(state.steps, event.stepId, (s) => ({
					...s,
					status: "succeeded",
					finishedAt: event.at,
				})),
				finalOutcome: event.outcome,
				finalSummary: event.summary,
				eventCount: nextEventCount,
			};

		case "run_finished": {
			// Any step still pending/ready at finish time was never visited — the
			// path went elsewhere. Mark them skipped so the renderer can show them
			// distinctly from 'about to run' steps.
			const finishedSteps = new Map<StepId, StepRuntimeState>();
			for (const [id, runtime] of state.steps) {
				if (runtime.status === "pending" || runtime.status === "ready") {
					finishedSteps.set(id, { ...runtime, status: "skipped" });
				} else {
					finishedSteps.set(id, runtime);
				}
			}
			return {
				...state,
				phase: event.phase,
				finishedAt: event.at,
				finalSummary: state.finalSummary ?? event.summary,
				steps: finishedSteps,
				eventCount: nextEventCount,
			};
		}

		case "run_aborted": {
			// Same skipped transition as run_finished — any step that was about to
			// run but didn't get the chance is skipped, not still-pending.
			const finishedSteps = new Map<StepId, StepRuntimeState>();
			for (const [id, runtime] of state.steps) {
				if (runtime.status === "pending" || runtime.status === "ready") {
					finishedSteps.set(id, { ...runtime, status: "skipped" });
				} else {
					finishedSteps.set(id, runtime);
				}
			}
			return {
				...state,
				phase: "aborted",
				finishedAt: event.at,
				steps: finishedSteps,
				eventCount: nextEventCount,
			};
		}
	}
};

/** Replay a sequence of events into a final state. Used by tests. */
export const replay = (program: Program, events: readonly RelayEvent[]): RelayRunState => {
	let state = initRunState(program);
	for (const event of events) state = applyEvent(state, event);
	return state;
};

// ============================================================================
// Reducer helpers
// ============================================================================

const CHECK_PASS = makeRouteId("pass");
const CHECK_FAIL = makeRouteId("fail");

const getStep = (steps: ReadonlyMap<StepId, StepRuntimeState>, id: StepId): StepRuntimeState => {
	const existing = steps.get(id);
	if (!existing) {
		throw new Error(`invariant: step '${String(id)}' missing from run state`);
	}
	return existing;
};

const updateStep = (
	steps: ReadonlyMap<StepId, StepRuntimeState>,
	id: StepId,
	updater: (prev: StepRuntimeState) => StepRuntimeState,
): ReadonlyMap<StepId, StepRuntimeState> => {
	const copy = new Map(steps);
	const prev = getStep(steps, id);
	copy.set(id, updater(prev));
	return copy;
};

const addUnique = <T>(list: readonly T[], item: T): readonly T[] => (list.includes(item) ? list : [...list, item]);

const removeOne = <T>(list: readonly T[], item: T): readonly T[] => {
	const idx = list.indexOf(item);
	if (idx < 0) return list;
	return [...list.slice(0, idx), ...list.slice(idx + 1)];
};

const addUsage = (a: ActorUsage, b: ActorUsage): ActorUsage => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cacheRead: a.cacheRead + b.cacheRead,
	cacheWrite: a.cacheWrite + b.cacheWrite,
	cost: a.cost + b.cost,
	contextTokens: Math.max(a.contextTokens, b.contextTokens),
	turns: a.turns + b.turns,
});

const describeViolation = (violation: ContractViolation): string => formatContractViolation(violation);
