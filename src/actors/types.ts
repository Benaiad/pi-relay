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
 * Input handed to the actor engine when an action step becomes ready.
 *
 * The engine reads the step's instruction, the artifact snapshot (scoped to
 * the step's declared reads), and the set of artifact contracts the step is
 * allowed to write. It returns an `ActionOutcome`.
 */
export interface ActionRequest {
	readonly step: ActionStep;
	readonly actor: ActorConfig;
	readonly artifacts: ArtifactSnapshot;
	readonly artifactContracts: ReadonlyMap<ArtifactId, ArtifactContract>;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (event: ActorProgressEvent) => void;
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
