/**
 * Types for the actor layer.
 *
 * Actors are named agents the plan's action steps delegate work to. An actor
 * is a disk-configured role — markdown with YAML frontmatter — declaring a
 * name, description, allowed tool list, optional model override, and a
 * system prompt in the body.
 *
 * `ActionRequest` is what the scheduler hands to the actor engine when it
 * executes an action step. `ActionOutcome` is what comes back: either the
 * actor completed with a chosen route and artifact writes, or it failed in
 * one of the typed failure modes.
 */

import type { ActorId, ArtifactId, RouteId, StepId } from "../plan/ids.js";
import type { ActionStep, ArtifactContract } from "../plan/types.js";
import type { ArtifactSnapshot } from "../runtime/artifacts.js";

export type ActorScope = "user" | "project" | "both";

export type ActorSource = "user" | "project";

/** Discovered actor configuration from a `.md` file with YAML frontmatter. */
export interface ActorConfig {
	readonly name: string;
	readonly description: string;
	readonly tools?: readonly string[];
	readonly model?: string;
	readonly systemPrompt: string;
	readonly source: ActorSource;
	readonly filePath: string;
}

/** Result of scanning the actor directories. */
export interface ActorDiscovery {
	readonly actors: readonly ActorConfig[];
	readonly projectDir: string | null;
	readonly userDir: string;
}

/**
 * Lightweight cost and turn counters for a single actor invocation.
 *
 * Matches the shape subagent uses so the renderer can share formatters.
 */
export interface ActorUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cost: number;
	readonly contextTokens: number;
	readonly turns: number;
}

export const emptyUsage = (): ActorUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

/** One entry in the actor's transcript, surfaced for UI display and audit. */
export type TranscriptItem =
	| { readonly kind: "text"; readonly text: string }
	| { readonly kind: "tool_call"; readonly toolName: string; readonly args: Record<string, unknown> };

/** Progress event emitted mid-run so the renderer can show live tool calls. */
export interface ActorProgressEvent {
	readonly stepId: StepId;
	readonly actor: ActorId;
	readonly item: TranscriptItem;
	readonly usage: ActorUsage;
}

/**
 * Minimal per-attempt summary handed to the actor on re-entry.
 *
 * When an action step is re-entered via a back-edge, the actor's subprocess
 * is spawned fresh with no memory of the prior run. Without this, the actor
 * cannot tell it has already executed, what it said, or what outcome it
 * reached — and a review/fix loop can spin producing identical outputs
 * forever. The scheduler builds one `PriorAttempt` per past attempt from
 * the audit log and passes them in the `ActionRequest`; the engine injects
 * them into the task prompt.
 *
 * Deliberately smaller than `AttemptSummary` in `run-report.ts` — the engine
 * only needs a short outcome label, a short narration, and the list of tool
 * names used. Full per-event detail stays in the report.
 */
export interface PriorAttempt {
	readonly attemptNumber: number;
	/** Short human-readable outcome label, e.g. "route: changes_requested" or "no_completion: missing tag". */
	readonly outcomeLabel: string;
	/** One-line summary of the actor's final narration, with the completion tag stripped. Empty if none. */
	readonly narration: string;
	/** Names of tools the actor called during this attempt, in call order. */
	readonly toolsCalled: readonly string[];
}

/**
 * Input handed to the actor engine when an action step becomes ready.
 *
 * The engine reads the step's instruction, the artifact snapshot (scoped to
 * the step's declared reads), and the set of artifact contracts the step is
 * allowed to write. On re-entry it also receives `priorAttempts` so the
 * actor can see what it did before. Returns an `ActionOutcome`.
 */
export interface ActionRequest {
	readonly step: ActionStep;
	readonly actor: ActorConfig;
	readonly artifacts: ArtifactSnapshot;
	readonly artifactContracts: ReadonlyMap<ArtifactId, ArtifactContract>;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (event: ActorProgressEvent) => void;
	/** Empty on the first activation; populated on re-entries via a back-edge. */
	readonly priorAttempts: readonly PriorAttempt[];
}

/**
 * Every way an action step can terminate.
 *
 * `completed` is the happy path: the actor picked a valid route and
 * committed its writes through the completion protocol. The scheduler uses
 * the route to decide the next step and passes the writes to the artifact
 * store for atomic commit.
 *
 * Every other variant is a failure mode. The scheduler applies the step's
 * retry policy to `no_completion` and `engine_error`; `aborted` and
 * `contract_rejected` are terminal for the current activation.
 */
export type ActionOutcome =
	| {
			readonly kind: "completed";
			readonly route: RouteId;
			readonly writes: ReadonlyMap<ArtifactId, unknown>;
			readonly usage: ActorUsage;
			readonly transcript: readonly TranscriptItem[];
	  }
	| {
			readonly kind: "no_completion";
			readonly reason: string;
			readonly usage: ActorUsage;
			readonly transcript: readonly TranscriptItem[];
	  }
	| {
			readonly kind: "engine_error";
			readonly reason: string;
			readonly usage: ActorUsage;
			readonly transcript: readonly TranscriptItem[];
	  }
	| {
			readonly kind: "aborted";
			readonly usage: ActorUsage;
			readonly transcript: readonly TranscriptItem[];
	  };

/** The contract the scheduler depends on. The default implementation spawns pi subprocesses; tests substitute fakes. */
export interface ActorEngine {
	runAction(request: ActionRequest): Promise<ActionOutcome>;
}
