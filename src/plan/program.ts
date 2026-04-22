/**
 * `Program` — the compiled, executable form of a plan.
 *
 * `Program` is the output of `compile()` and the input of the runtime. It is
 * intentionally shaped differently from `PlanDraft`: the draft is flat arrays
 * for the model to fill in; the program is indexed maps for the scheduler to
 * look up. Every identifier is branded, every invariant the compiler proved
 * is locked in by the type of the stored value (e.g. `writers` has exactly
 * one `StepId` per `ArtifactId`).
 *
 * There is no public constructor. The only way to obtain a `Program` is
 * through `compile()` in `compile.ts`. The runtime does not mutate a
 * `Program`; it only reads it.
 */

import type { ActorId, ArtifactId, EdgeKey, PlanId, StepId } from "./ids.js";
import type { ArtifactContract, Step } from "./types.js";

export interface Program {
	/** Unique identifier for this compiled plan instance. */
	readonly id: PlanId;

	/** Human-readable task description, preserved from the draft. */
	readonly task: string;

	/** Optional success criteria, preserved from the draft. */
	readonly successCriteria?: string;

	/** Step where execution begins. Guaranteed to be a key of `steps`. */
	readonly entryStep: StepId;

	/** All steps indexed by id. */
	readonly steps: ReadonlyMap<StepId, Step>;

	/** Stable insertion order for deterministic display and iteration. */
	readonly stepOrder: readonly StepId[];

	/** Every artifact contract, indexed by id. */
	readonly artifacts: ReadonlyMap<ArtifactId, ArtifactContract>;

	/**
	 * Edge index: `(fromStep, route)` → `toStep`.
	 *
	 * Contains one entry per outgoing edge declared by any action step plus
	 * two entries per command step (`success` and `failure`). Terminal steps contribute
	 * no edges.
	 */
	readonly edges: ReadonlyMap<EdgeKey, StepId>;

	/** Primary producer: the first step the compiler sees writing each artifact. Used for attribution. */
	readonly writers: ReadonlyMap<ArtifactId, StepId>;

	/** Every step authorized to commit each artifact. The artifact store checks this on every commit. */
	readonly allowedWriters: ReadonlyMap<ArtifactId, ReadonlySet<StepId>>;

	/** Consumer index: which steps declared they read each artifact. */
	readonly readers: ReadonlyMap<ArtifactId, ReadonlySet<StepId>>;

	/** Every actor referenced by any action step. */
	readonly actorsReferenced: ReadonlySet<ActorId>;
}
