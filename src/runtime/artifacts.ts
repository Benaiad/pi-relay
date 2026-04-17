/**
 * Run-scoped typed artifact store.
 *
 * The store holds every committed artifact for the current run. Steps read
 * snapshots — frozen subsets keyed by the step's declared `reads` — and
 * commit writes atomically at the end of a successful step. In-flight writes
 * are not visible to other steps: a step's writes are staged in a local
 * patch and only published via `commit()` when the step succeeds.
 *
 * Invariants enforced by the store:
 *
 *   1. Every artifact has exactly one writer. The program's compiled
 *      `writers` index is the source of truth; commits from any other
 *      step are rejected.
 *   2. Every committed value matches the artifact's compiled shape. For
 *      v0.1 this is trivially true because the only shape is `untyped_json`;
 *      for v0.2 it becomes a TypeBox check.
 *   3. Commits are all-or-nothing. If any write in a batch is invalid, none
 *      are applied.
 *
 * The store does NOT enforce which artifacts a step reads — the scheduler is
 * responsible for calling `snapshot(step.reads)` with the right id list.
 * Snapshot results are frozen so consumers can't accidentally mutate them.
 */

import type { ArtifactId, StepId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import type { Program } from "../plan/program.js";
import { err, ok, type Result } from "../plan/result.js";
import type { ArtifactContract } from "../plan/types.js";
import type { AccumulatedEntry } from "./accumulated-entry.js";

/**
 * Frozen view of a subset of committed artifacts.
 *
 * Returned by `ArtifactStore.snapshot`. Consumers read values by id. The
 * snapshot does not reflect future commits — it is a point-in-time view
 * captured when the step started.
 */
export interface ArtifactSnapshot {
	/** Look up a committed value by id. Returns `undefined` if the artifact has not been committed yet. */
	get(id: ArtifactId): unknown | undefined;
	/** Whether a value is present for this id. */
	has(id: ArtifactId): boolean;
	/** Ordered list of ids present in the snapshot. */
	ids(): readonly ArtifactId[];
}

/** A single committed artifact, including bookkeeping. */
export interface StoredArtifact {
	readonly id: ArtifactId;
	readonly value: unknown;
	readonly writerStep: StepId;
	readonly committedAt: number;
}

/** Reasons a commit may be rejected. */
export type ContractViolation =
	| { readonly kind: "unknown_artifact"; readonly artifactId: ArtifactId; readonly stepId: StepId }
	| {
			readonly kind: "wrong_writer";
			readonly artifactId: ArtifactId;
			readonly declaredWriter: StepId;
			readonly actualWriter: StepId;
	  }
	| {
			readonly kind: "shape_mismatch";
			readonly artifactId: ArtifactId;
			readonly reason: string;
	  };

export const formatContractViolation = (violation: ContractViolation): string => {
	switch (violation.kind) {
		case "unknown_artifact":
			return `Step '${unwrap(violation.stepId)}' tried to commit artifact '${unwrap(violation.artifactId)}', which has no contract in this plan.`;
		case "wrong_writer":
			return (
				`Step '${unwrap(violation.actualWriter)}' tried to commit artifact '${unwrap(violation.artifactId)}', ` +
				`but the plan declares '${unwrap(violation.declaredWriter)}' as the sole writer for that artifact.`
			);
		case "shape_mismatch":
			return `Artifact '${unwrap(violation.artifactId)}' failed shape validation: ${violation.reason}`;
	}
};

/**
 * Validate a value against an artifact's compiled shape.
 *
 * v0.1 only supports `untyped_json`, which accepts any JSON-serializable value
 * (any value that round-trips through JSON.stringify without loss). A shape
 * registry lands in v0.2.
 */
const validateShape = (value: unknown, contract: ArtifactContract): Result<void, string> => {
	switch (contract.shape.kind) {
		case "untyped_json": {
			try {
				const roundTripped = JSON.parse(JSON.stringify(value));
				void roundTripped;
				return ok(undefined);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return err(`value is not JSON-serializable: ${message}`);
			}
		}
	}
};

export class ArtifactStore {
	private readonly committed = new Map<ArtifactId, StoredArtifact>();

	constructor(
		private readonly program: Program,
		private readonly clock: () => number,
	) {}

	/**
	 * Return a frozen snapshot over the requested subset of committed artifacts.
	 *
	 * Ids that have not yet been committed are omitted; callers should treat a
	 * missing id as "not produced yet."
	 */
	snapshot(reads: readonly ArtifactId[]): ArtifactSnapshot {
		const subset = new Map<ArtifactId, unknown>();
		for (const id of reads) {
			const stored = this.committed.get(id);
			if (stored !== undefined) subset.set(id, stored.value);
		}
		const idsList: readonly ArtifactId[] = Object.freeze(Array.from(subset.keys()));
		return Object.freeze({
			get: (id: ArtifactId) => subset.get(id),
			has: (id: ArtifactId) => subset.has(id),
			ids: () => idsList,
		});
	}

	/**
	 * Commit a batch of writes atomically.
	 *
	 * Every write is validated against the program's writer map and the
	 * artifact's shape. If any write is invalid, none are applied and the
	 * store returns the first violation encountered.
	 */
	commit(stepId: StepId, writes: ReadonlyMap<ArtifactId, unknown>, attempt?: number): Result<void, ContractViolation> {
		const patch: StoredArtifact[] = [];
		const committedAt = this.clock();

		for (const [artifactId, value] of writes) {
			const contract = this.program.artifacts.get(artifactId);
			if (contract === undefined) {
				return err({ kind: "unknown_artifact", artifactId, stepId });
			}
			// Any step that declared the artifact in its `writes` is allowed.
			const permitted = this.program.allowedWriters.get(artifactId);
			if (permitted === undefined || !permitted.has(stepId)) {
				const primary = this.program.writers.get(artifactId);
				return err({
					kind: "wrong_writer",
					artifactId,
					declaredWriter: primary ?? stepId,
					actualWriter: stepId,
				});
			}
			const shapeResult = validateShape(value, contract);
			if (!shapeResult.ok) {
				return err({ kind: "shape_mismatch", artifactId, reason: shapeResult.error });
			}

			const finalValue = this.appendToAccumulator(artifactId, value, stepId, attempt ?? 1);
			patch.push({ id: artifactId, value: finalValue, writerStep: stepId, committedAt });
		}

		for (const entry of patch) {
			this.committed.set(entry.id, entry);
		}
		return ok(undefined);
	}

	/** Ordered list of every committed artifact, in commit order. */
	all(): readonly StoredArtifact[] {
		return Array.from(this.committed.values());
	}

	/** Whether a specific artifact has been committed. */
	has(id: ArtifactId): boolean {
		return this.committed.has(id);
	}

	private appendToAccumulator(id: ArtifactId, value: unknown, stepId: StepId, attempt: number): AccumulatedEntry[] {
		const existing = this.committed.get(id);
		const prior: AccumulatedEntry[] = existing !== undefined && Array.isArray(existing.value) ? existing.value : [];
		const entry: AccumulatedEntry = {
			index: prior.length,
			stepId,
			attempt,
			value,
			committedAt: this.clock(),
		};
		return [...prior, entry];
	}
}
