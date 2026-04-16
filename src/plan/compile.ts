/**
 * Compile a validated `PlanDraftDoc` into an executable `Program`.
 *
 * The compiler is the gate between "the model produced something" and "the
 * runtime may execute it." It is total — it returns `Result<Program, CompileError>`
 * and never throws. It is pure with respect to I/O and does not mutate its
 * inputs.
 *
 * The compiler does NOT perform reachability analysis. A plan with an
 * unreachable step compiles cleanly; the runtime discovers the dead path at
 * execution time. Reachability can be added later as a separate pass.
 *
 * The compiler DOES enforce:
 *   - At least one step
 *   - Unique step ids
 *   - Entry step is defined
 *   - Every actor reference resolves against the supplied registry
 *   - Every route target resolves to a real step
 *   - Every declared artifact is unique, has a writer, and is referenced consistently
 *   - Every read/write references an artifact that has a contract
 *   - Every artifact has exactly one writer
 *   - Only the supported context policies are used
 */

import type { CompileError } from "./compile-errors.js";
import type { PlanDraftDoc } from "./draft.js";
import { ActorId, ArtifactId, type EdgeKey, edgeKey, PlanId, RouteId, StepId } from "./ids.js";
import type { Program } from "./program.js";
import { err, ok, type Result } from "./result.js";
import type { ActionStep, ArtifactContract, CheckStep, ContextPolicy, Step, TerminalStep } from "./types.js";

/**
 * The set of actor identifiers available for this compilation.
 *
 * Populated from disk discovery in production (`actors/discovery.ts`).
 * Tests construct one inline.
 */
export interface ActorRegistry {
	has(id: ActorId): boolean;
	names(): readonly ActorId[];
}

export interface CompileOptions {
	/** Identifier generator for the compiled program. Defaults to `crypto.randomUUID()`. */
	generateId?: () => string;
}

export const compile = (
	doc: PlanDraftDoc,
	actors: ActorRegistry,
	options: CompileOptions = {},
): Result<Program, CompileError> => {
	if (doc.steps.length === 0) {
		return err({ kind: "empty_plan" });
	}

	const stepsResult = brandSteps(doc);
	if (!stepsResult.ok) return stepsResult;
	const { steps: stepsById, stepOrder } = stepsResult.value;

	const entryStep = StepId(doc.entryStep);
	if (!stepsById.has(entryStep)) {
		return err({
			kind: "missing_entry",
			entryStep,
			availableSteps: stepOrder,
		});
	}

	const actorCheck = validateActors(stepsById, actors);
	if (!actorCheck.ok) return actorCheck;
	const actorsReferenced = actorCheck.value;

	const edgeCheck = buildEdges(stepsById, stepOrder);
	if (!edgeCheck.ok) return edgeCheck;
	const edges = edgeCheck.value;

	const artifactCheck = buildArtifacts(doc.artifacts, stepsById);
	if (!artifactCheck.ok) return artifactCheck;
	const { artifacts, writers, allowedWriters, readers } = artifactCheck.value;

	const policyCheck = validateContextPolicies(stepsById);
	if (!policyCheck.ok) return policyCheck;

	const generateId = options.generateId ?? (() => crypto.randomUUID());
	const program: Program = {
		id: PlanId(generateId()),
		task: doc.task,
		successCriteria: doc.successCriteria,
		entryStep,
		steps: stepsById,
		stepOrder,
		artifacts,
		edges,
		writers,
		allowedWriters,
		readers,
		actorsReferenced,
	};
	return ok(program);
};

// ============================================================================
// Internal passes
// ============================================================================

interface BrandedStepsResult {
	steps: ReadonlyMap<StepId, Step>;
	stepOrder: readonly StepId[];
}

const brandSteps = (doc: PlanDraftDoc): Result<BrandedStepsResult, CompileError> => {
	const stepsById = new Map<StepId, Step>();
	const stepOrder: StepId[] = [];

	for (const stepDoc of doc.steps) {
		const step = brandStep(stepDoc);
		if (stepsById.has(step.id)) {
			return err({ kind: "duplicate_step", stepId: step.id });
		}
		stepsById.set(step.id, step);
		stepOrder.push(step.id);
	}
	return ok({ steps: stepsById, stepOrder });
};

const brandStep = (doc: PlanDraftDoc["steps"][number]): Step => {
	switch (doc.kind) {
		case "action":
			return brandAction(doc);
		case "check":
			return brandCheck(doc);
		case "terminal":
			return brandTerminal(doc);
	}
};

const brandAction = (doc: Extract<PlanDraftDoc["steps"][number], { kind: "action" }>): ActionStep => ({
	kind: "action",
	id: StepId(doc.id),
	actor: ActorId(doc.actor),
	instruction: doc.instruction,
	reads: doc.reads.map((r) => ArtifactId(r)),
	writes: doc.writes.map((w) => ArtifactId(w)),
	routes: doc.routes.map((edge) => ({ route: RouteId(edge.route), to: StepId(edge.to) })),
	retry: doc.retry,
	maxRuns: doc.maxRuns,
	contextPolicy: doc.contextPolicy,
});

const brandCheck = (doc: Extract<PlanDraftDoc["steps"][number], { kind: "check" }>): CheckStep => ({
	kind: "check",
	id: StepId(doc.id),
	check: doc.check,
	onPass: StepId(doc.onPass),
	onFail: StepId(doc.onFail),
});

const brandTerminal = (doc: Extract<PlanDraftDoc["steps"][number], { kind: "terminal" }>): TerminalStep => ({
	kind: "terminal",
	id: StepId(doc.id),
	outcome: doc.outcome,
	summary: doc.summary,
});

const validateActors = (
	steps: ReadonlyMap<StepId, Step>,
	actors: ActorRegistry,
): Result<ReadonlySet<ActorId>, CompileError> => {
	const referenced = new Set<ActorId>();
	for (const step of steps.values()) {
		if (step.kind !== "action") continue;
		if (!actors.has(step.actor)) {
			return err({
				kind: "missing_actor",
				stepId: step.id,
				actor: step.actor,
				availableActors: actors.names(),
			});
		}
		referenced.add(step.actor);
	}
	return ok(referenced);
};

const CHECK_PASS_ROUTE = RouteId("pass");
const CHECK_FAIL_ROUTE = RouteId("fail");

const buildEdges = (
	steps: ReadonlyMap<StepId, Step>,
	stepOrder: readonly StepId[],
): Result<ReadonlyMap<EdgeKey, StepId>, CompileError> => {
	const edges = new Map<EdgeKey, StepId>();

	for (const step of steps.values()) {
		switch (step.kind) {
			case "action":
				for (const edge of step.routes) {
					if (!steps.has(edge.to)) {
						return err({
							kind: "missing_route_target",
							from: step.id,
							route: edge.route,
							target: edge.to,
							availableSteps: stepOrder,
						});
					}
					edges.set(edgeKey(step.id, edge.route), edge.to);
				}
				break;

			case "check":
				if (!steps.has(step.onPass)) {
					return err({
						kind: "missing_route_target",
						from: step.id,
						route: CHECK_PASS_ROUTE,
						target: step.onPass,
						availableSteps: stepOrder,
					});
				}
				if (!steps.has(step.onFail)) {
					return err({
						kind: "missing_route_target",
						from: step.id,
						route: CHECK_FAIL_ROUTE,
						target: step.onFail,
						availableSteps: stepOrder,
					});
				}
				edges.set(edgeKey(step.id, CHECK_PASS_ROUTE), step.onPass);
				edges.set(edgeKey(step.id, CHECK_FAIL_ROUTE), step.onFail);
				break;

			case "terminal":
				// Terminal steps contribute no outgoing edges.
				break;
		}
	}
	return ok(edges);
};

interface ArtifactIndices {
	artifacts: ReadonlyMap<ArtifactId, ArtifactContract>;
	writers: ReadonlyMap<ArtifactId, StepId>;
	allowedWriters: ReadonlyMap<ArtifactId, ReadonlySet<StepId>>;
	readers: ReadonlyMap<ArtifactId, ReadonlySet<StepId>>;
}

const buildArtifacts = (
	contracts: PlanDraftDoc["artifacts"],
	steps: ReadonlyMap<StepId, Step>,
): Result<ArtifactIndices, CompileError> => {
	const artifacts = new Map<ArtifactId, ArtifactContract>();
	for (const c of contracts) {
		const id = ArtifactId(c.id);
		if (artifacts.has(id)) {
			return err({ kind: "duplicate_artifact", artifactId: id });
		}
		artifacts.set(id, {
			id,
			description: c.description,
			shape: c.shape,
			multiWriter: c.multiWriter === true,
		});
	}

	// `writers` stores the FIRST writer seen for each artifact — used by the
	// runtime for attribution and display. `allowedWriters` stores the
	// complete permitted set, which the runtime uses on every commit to
	// authorize the writing step. For single-writer artifacts both maps
	// agree. For multi-writer artifacts allowedWriters is a superset.
	const writers = new Map<ArtifactId, StepId>();
	const allowedWriters = new Map<ArtifactId, Set<StepId>>();
	const readers = new Map<ArtifactId, Set<StepId>>();

	for (const step of steps.values()) {
		if (step.kind !== "action") continue;

		for (const writeId of step.writes) {
			const contract = artifacts.get(writeId);
			if (contract === undefined) {
				return err({
					kind: "missing_artifact_contract",
					artifactId: writeId,
					stepId: step.id,
					direction: "write",
				});
			}
			const prior = writers.get(writeId);
			if (prior !== undefined && prior !== step.id && !contract.multiWriter) {
				return err({
					kind: "multiple_artifact_writers",
					artifactId: writeId,
					writers: [prior, step.id],
				});
			}
			if (prior === undefined) writers.set(writeId, step.id);
			const bucket = allowedWriters.get(writeId) ?? new Set<StepId>();
			bucket.add(step.id);
			allowedWriters.set(writeId, bucket);
		}

		for (const readId of step.reads) {
			if (!artifacts.has(readId)) {
				return err({
					kind: "missing_artifact_contract",
					artifactId: readId,
					stepId: step.id,
					direction: "read",
				});
			}
			const set = readers.get(readId) ?? new Set<StepId>();
			set.add(step.id);
			readers.set(readId, set);
		}
	}

	for (const id of artifacts.keys()) {
		if (!writers.has(id)) {
			return err({ kind: "missing_artifact_producer", artifactId: id });
		}
	}

	return ok({ artifacts, writers, allowedWriters, readers });
};

const SUPPORTED_CONTEXT_POLICIES: readonly ContextPolicy[] = ["fresh_per_run"];

const validateContextPolicies = (steps: ReadonlyMap<StepId, Step>): Result<void, CompileError> => {
	for (const step of steps.values()) {
		if (step.kind !== "action") continue;
		const policy = step.contextPolicy ?? "fresh_per_run";
		if (!SUPPORTED_CONTEXT_POLICIES.includes(policy)) {
			return err({ kind: "unsupported_context_policy", stepId: step.id, policy });
		}
	}
	return ok(undefined);
};
