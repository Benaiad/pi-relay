/**
 * Domain types for the plan IR.
 *
 * These types use branded IDs everywhere. They are the "inside" form the
 * compiler produces and the runtime consumes. The wire format the model sees
 * (the TypeBox schema in `draft.ts`) uses plain strings; the compiler bridges
 * the two by branding IDs as it walks the doc.
 */

import type { ActorId, ArtifactId, RouteId, StepId } from "./ids.js";

/** How an actor's conversation state persists across step invocations within a single run. */
export type ContextPolicy = "fresh_per_run" | "persist_per_step" | "persist_per_actor";

/** Retry policy for an action step. `maxAttempts` of 1 means a single attempt with no retry. */
export interface RetryPolicy {
	readonly maxAttempts: number;
	readonly backoffMs?: number;
}

/** A named outgoing edge from a step: "when this step emits route X, go to step Y". */
export interface RouteEdge {
	readonly route: RouteId;
	readonly to: StepId;
}

/** Shape of an artifact's stored value. MVP only supports untyped JSON. */
export type ArtifactShape = { readonly kind: "untyped_json" };

/**
 * Compile-time declaration of an artifact.
 *
 * By default an artifact has exactly one producer (a step that declares it
 * in its `writes`) and zero or more consumers (steps that declare it in
 * their `reads`). The compiler enforces single-writer ownership; multiple
 * writers reject the plan.
 *
 * Multiple steps can write to the same artifact. Readers see the latest
 * committed value. The runtime always commits atomically — in-flight
 * writes stay invisible until the writer succeeds.
 *
 * `accumulate: true` changes write semantics from replace to append:
 * each commit adds an entry to an array, and readers see the full history.
 */
export interface ArtifactContract {
	readonly id: ArtifactId;
	readonly description: string;
	readonly shape: ArtifactShape;
	readonly accumulate?: boolean;
}

/**
 * A deterministic verification step the runtime evaluates itself.
 *
 * MVP supports two kinds: file existence and command-exit-code. Both are
 * pure shell-style checks with no LLM involvement. The check engine routes
 * to `pass` or `fail` based on the outcome.
 */
export type CheckSpec =
	| { readonly kind: "file_exists"; readonly path: string }
	| {
			readonly kind: "command_exits_zero";
			readonly command: string;
			readonly cwd?: string;
			readonly timeoutMs?: number;
	  };

/**
 * An action step: an actor (LLM-backed) is asked to do work and emit one of
 * its allowed routes when complete. Any artifacts listed in `writes` may be
 * committed by the actor via its completion tool call.
 */
export interface ActionStep {
	readonly kind: "action";
	readonly id: StepId;
	readonly actor: ActorId;
	readonly instruction: string;
	readonly reads: readonly ArtifactId[];
	readonly writes: readonly ArtifactId[];
	readonly routes: readonly RouteEdge[];
	readonly retry?: RetryPolicy;
	readonly maxRuns?: number;
	readonly contextPolicy?: ContextPolicy;
}

/**
 * A check step: a `CheckSpec` is evaluated deterministically, and the
 * runtime routes to `onPass` or `onFail` depending on the outcome. Check
 * steps never read or write artifacts and never call an LLM.
 */
export interface CheckStep {
	readonly kind: "check";
	readonly id: StepId;
	readonly check: CheckSpec;
	readonly onPass: StepId;
	readonly onFail: StepId;
}

/**
 * A terminal step: execution stops here with the given outcome. The runtime
 * emits `RunFinished` and the scheduler exits its loop.
 */
export interface TerminalStep {
	readonly kind: "terminal";
	readonly id: StepId;
	readonly outcome: TerminalOutcome;
	readonly summary: string;
}

export type TerminalOutcome = "success" | "failure";

/** The discriminated union of every step kind. Exhaustive matching is enforced. */
export type Step = ActionStep | CheckStep | TerminalStep;

/**
 * A plan as the compiler understands it — branded IDs, frozen arrays.
 *
 * `PlanDraft` is what the compiler's input becomes after it has branded all
 * the IDs from the TypeBox wire format and performed zero validation beyond
 * structural well-formedness. Real validation lives in `compile()`.
 */
export interface PlanDraft {
	readonly task: string;
	readonly successCriteria?: string;
	readonly artifacts: readonly ArtifactContract[];
	readonly steps: readonly Step[];
	readonly entryStep: StepId;
}
