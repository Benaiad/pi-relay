/**
 * Domain types for the plan IR.
 *
 * These types use branded IDs everywhere. They are the "inside" form the
 * compiler produces and the runtime consumes. The wire format the model sees
 * (the TypeBox schema in `draft.ts`) uses plain strings; the compiler bridges
 * the two by branding IDs as it walks the doc.
 */

import type { ActorId, ArtifactId, RouteId, StepId } from "./ids.js";

export type ArtifactShape =
	| { readonly kind: "text" }
	| { readonly kind: "record"; readonly fields: readonly string[] }
	| { readonly kind: "record_list"; readonly fields: readonly string[] };

/**
 * Compile-time declaration of an artifact.
 *
 * By default an artifact has exactly one producer (a step that declares it
 * in its `writes`) and zero or more consumers (steps that declare it in
 * their `reads`). The compiler enforces single-writer ownership; multiple
 * writers reject the plan.
 *
 * Multiple steps can write to the same artifact. Every commit appends
 * an entry with attribution metadata (step, attempt, timestamp).
 * Readers see the full history as an array of entries.
 */
export interface ArtifactContract {
	readonly id: ArtifactId;
	readonly description: string;
	readonly shape: ArtifactShape;
}

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
	readonly routes: ReadonlyMap<RouteId, StepId>;
	readonly maxRuns?: number;
}

/**
 * A command step that runs a shell command and routes based on exit code.
 * Succeeds iff the command exits 0 within the timeout.
 */
export interface CommandStep {
	readonly kind: "command";
	readonly id: StepId;
	readonly command: string;
	readonly reads: readonly ArtifactId[];
	readonly writes: readonly ArtifactId[];
	readonly timeoutMs?: number;
	readonly onSuccess: StepId;
	readonly onFailure: StepId;
}

/**
 * A step that checks whether all listed paths exist on the filesystem.
 * Succeeds iff every path exists. Failure reason lists which paths are missing.
 */
export interface FilesExistStep {
	readonly kind: "files_exist";
	readonly id: StepId;
	readonly paths: readonly string[];
	readonly onSuccess: StepId;
	readonly onFailure: StepId;
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
export type Step = ActionStep | CommandStep | FilesExistStep | TerminalStep;

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
	readonly entryStep?: StepId;
}
