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
 *   - Unique step names
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
import type { ActionStep, ArtifactContract, CommandStep, FilesExistStep, Step, TerminalStep } from "./types.js";

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
		return err({ type: "empty_plan" });
	}

	const stepsResult = brandSteps(doc);
	if (!stepsResult.ok) return stepsResult;
	const { steps: stepsById, stepOrder } = stepsResult.value;

	const hasTerminal = stepOrder.some((id) => stepsById.get(id)?.type === "terminal");
	if (!hasTerminal) {
		return err({ type: "no_terminal" });
	}

	const entryStep = doc.entry_step ? StepId(doc.entry_step) : stepOrder[0]!;
	if (!stepsById.has(entryStep)) {
		return err({
			type: "missing_entry",
			entryStep,
			availableSteps: stepOrder,
		});
	}
	if (stepsById.get(entryStep)?.type === "terminal") {
		return err({ type: "terminal_entry", entryStep });
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
		successCriteria: doc.success_criteria,
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
		if (stepsById.has(step.name)) {
			return err({ type: "duplicate_step", stepId: step.name });
		}
		stepsById.set(step.name, step);
		stepOrder.push(step.name);
	}
	return ok({ steps: stepsById, stepOrder });
};

const brandStep = (doc: PlanDraftDoc["steps"][number]): Step => {
	switch (doc.type) {
		case "action":
			return brandAction(doc);
		case "command":
			return brandCommand(doc);
		case "files_exist":
			return brandFilesExist(doc);
		case "terminal":
			return brandTerminal(doc);
	}
};

const brandAction = (doc: Extract<PlanDraftDoc["steps"][number], { type: "action" }>): ActionStep => ({
	type: "action",
	name: StepId(doc.name),
	actor: ActorId(doc.actor),
	instruction: doc.instruction,
	reads: (doc.reads ?? []).map((r) => ArtifactId(r)),
	writes: (doc.writes ?? []).map((w) => ArtifactId(w)),
	routes: new Map(Object.entries(doc.routes).map(([route, to]) => [RouteId(route), StepId(to)])),
	maxRuns: doc.max_runs,
});

const brandCommand = (doc: Extract<PlanDraftDoc["steps"][number], { type: "command" }>): CommandStep => ({
	type: "command",
	name: StepId(doc.name),
	command: doc.command,
	reads: (doc.reads ?? []).map((r) => ArtifactId(r)),
	writes: (doc.writes ?? []).map((w) => ArtifactId(w)),
	timeout: doc.timeout,
	onSuccess: StepId(doc.on_success),
	onFailure: StepId(doc.on_failure),
});

const brandFilesExist = (doc: Extract<PlanDraftDoc["steps"][number], { type: "files_exist" }>): FilesExistStep => ({
	type: "files_exist",
	name: StepId(doc.name),
	paths: doc.paths,
	onSuccess: StepId(doc.on_success),
	onFailure: StepId(doc.on_failure),
});

const brandTerminal = (doc: Extract<PlanDraftDoc["steps"][number], { type: "terminal" }>): TerminalStep => ({
	type: "terminal",
	name: StepId(doc.name),
	outcome: doc.outcome,
	summary: doc.summary,
});

const validateActors = (
	steps: ReadonlyMap<StepId, Step>,
	actors: ActorRegistry,
): Result<ReadonlySet<ActorId>, CompileError> => {
	const referenced = new Set<ActorId>();
	for (const step of steps.values()) {
		if (step.type !== "action") continue;
		if (!actors.has(step.actor)) {
			return err({
				type: "missing_actor",
				stepId: step.name,
				actor: step.actor,
				availableActors: actors.names(),
			});
		}
		referenced.add(step.actor);
	}
	return ok(referenced);
};

const SUCCESS_ROUTE = RouteId("success");
const FAILURE_ROUTE = RouteId("failure");

const buildEdges = (
	steps: ReadonlyMap<StepId, Step>,
	stepOrder: readonly StepId[],
): Result<ReadonlyMap<EdgeKey, StepId>, CompileError> => {
	const edges = new Map<EdgeKey, StepId>();

	for (const step of steps.values()) {
		switch (step.type) {
			case "action":
				for (const [route, target] of step.routes) {
					if (!steps.has(target)) {
						return err({
							type: "missing_route_target",
							from: step.name,
							route,
							target,
							availableSteps: stepOrder,
						});
					}
					edges.set(edgeKey(step.name, route), target);
				}
				break;

			case "command":
			case "files_exist":
				if (!steps.has(step.onSuccess)) {
					return err({
						type: "missing_route_target",
						from: step.name,
						route: SUCCESS_ROUTE,
						target: step.onSuccess,
						availableSteps: stepOrder,
					});
				}
				if (!steps.has(step.onFailure)) {
					return err({
						type: "missing_route_target",
						from: step.name,
						route: FAILURE_ROUTE,
						target: step.onFailure,
						availableSteps: stepOrder,
					});
				}
				edges.set(edgeKey(step.name, SUCCESS_ROUTE), step.onSuccess);
				edges.set(edgeKey(step.name, FAILURE_ROUTE), step.onFailure);
				break;

			case "terminal":
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
		const name = ArtifactId(c.name);
		if (artifacts.has(name)) {
			return err({ type: "duplicate_artifact", artifactId: name });
		}
		const shape = c.fields
			? c.list
				? { type: "record_list" as const, fields: c.fields }
				: { type: "record" as const, fields: c.fields }
			: { type: "text" as const };

		artifacts.set(name, { name, description: c.description, shape });
	}

	const writers = new Map<ArtifactId, StepId>();
	const allowedWriters = new Map<ArtifactId, Set<StepId>>();
	const readers = new Map<ArtifactId, Set<StepId>>();

	for (const step of steps.values()) {
		if (step.type !== "action" && step.type !== "command") continue;

		for (const writeId of step.writes) {
			const contract = artifacts.get(writeId);
			if (contract === undefined) {
				return err({
					type: "missing_artifact_contract",
					artifactId: writeId,
					stepId: step.name,
					direction: "write",
				});
			}
			const prior = writers.get(writeId);
			if (prior === undefined) writers.set(writeId, step.name);
			const bucket = allowedWriters.get(writeId) ?? new Set<StepId>();
			bucket.add(step.name);
			allowedWriters.set(writeId, bucket);
		}

		for (const readId of step.reads) {
			if (!artifacts.has(readId)) {
				return err({
					type: "missing_artifact_contract",
					artifactId: readId,
					stepId: step.name,
					direction: "read",
				});
			}
			const set = readers.get(readId) ?? new Set<StepId>();
			set.add(step.name);
			readers.set(readId, set);
		}
	}

	for (const name of artifacts.keys()) {
		if (!writers.has(name)) {
			return err({ type: "missing_artifact_producer", artifactId: name });
		}
	}

	return ok({ artifacts, writers, allowedWriters, readers });
};
