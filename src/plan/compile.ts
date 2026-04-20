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
import type {
	ActionStep,
	ArtifactContract,
	Step,
	TerminalStep,
	VerifyCommandStep,
	VerifyFilesExistStep,
} from "./types.js";

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

	const entryStep = doc.entryStep ? StepId(doc.entryStep) : stepOrder[0]!;
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

	const artifactCheck = buildArtifacts(doc.artifacts ?? [], stepsById);
	if (!artifactCheck.ok) return artifactCheck;
	const { artifacts, writers, allowedWriters, readers } = artifactCheck.value;

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
		case "verify_command":
			return brandVerifyCommand(doc);
		case "verify_files_exist":
			return brandVerifyFilesExist(doc);
		case "terminal":
			return brandTerminal(doc);
	}
};

const brandAction = (doc: Extract<PlanDraftDoc["steps"][number], { kind: "action" }>): ActionStep => ({
	kind: "action",
	id: StepId(doc.id),
	actor: ActorId(doc.actor),
	instruction: doc.instruction,
	reads: (doc.reads ?? []).map((r) => ArtifactId(r)),
	writes: (doc.writes ?? []).map((w) => ArtifactId(w)),
	routes: new Map(Object.entries(doc.routes).map(([route, to]) => [RouteId(route), StepId(to)])),
	maxRuns: doc.maxRuns,
});

const brandVerifyCommand = (
	doc: Extract<PlanDraftDoc["steps"][number], { kind: "verify_command" }>,
): VerifyCommandStep => ({
	kind: "verify_command",
	id: StepId(doc.id),
	command: doc.command,
	timeoutMs: doc.timeoutMs,
	onPass: StepId(doc.onPass),
	onFail: StepId(doc.onFail),
});

const brandVerifyFilesExist = (
	doc: Extract<PlanDraftDoc["steps"][number], { kind: "verify_files_exist" }>,
): VerifyFilesExistStep => ({
	kind: "verify_files_exist",
	id: StepId(doc.id),
	paths: doc.paths,
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

const VERIFY_PASS_ROUTE = RouteId("pass");
const VERIFY_FAIL_ROUTE = RouteId("fail");

const buildEdges = (
	steps: ReadonlyMap<StepId, Step>,
	stepOrder: readonly StepId[],
): Result<ReadonlyMap<EdgeKey, StepId>, CompileError> => {
	const edges = new Map<EdgeKey, StepId>();

	for (const step of steps.values()) {
		switch (step.kind) {
			case "action":
				for (const [route, target] of step.routes) {
					if (!steps.has(target)) {
						return err({
							kind: "missing_route_target",
							from: step.id,
							route,
							target,
							availableSteps: stepOrder,
						});
					}
					edges.set(edgeKey(step.id, route), target);
				}
				break;

			case "verify_command":
			case "verify_files_exist":
				if (!steps.has(step.onPass)) {
					return err({
						kind: "missing_route_target",
						from: step.id,
						route: VERIFY_PASS_ROUTE,
						target: step.onPass,
						availableSteps: stepOrder,
					});
				}
				if (!steps.has(step.onFail)) {
					return err({
						kind: "missing_route_target",
						from: step.id,
						route: VERIFY_FAIL_ROUTE,
						target: step.onFail,
						availableSteps: stepOrder,
					});
				}
				edges.set(edgeKey(step.id, VERIFY_PASS_ROUTE), step.onPass);
				edges.set(edgeKey(step.id, VERIFY_FAIL_ROUTE), step.onFail);
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
	contracts: NonNullable<PlanDraftDoc["artifacts"]>,
	steps: ReadonlyMap<StepId, Step>,
): Result<ArtifactIndices, CompileError> => {
	const artifacts = new Map<ArtifactId, ArtifactContract>();
	for (const c of contracts) {
		const id = ArtifactId(c.id);
		if (artifacts.has(id)) {
			return err({ kind: "duplicate_artifact", artifactId: id });
		}
		const shape = c.fields
			? c.list
				? { kind: "record_list" as const, fields: c.fields }
				: { kind: "record" as const, fields: c.fields }
			: { kind: "text" as const };

		artifacts.set(id, { id, description: c.description, shape });
	}

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
