/**
 * Human-readable formatting for compile errors.
 *
 * Single place to control how compile failures read in the tool result. Keeps
 * message style consistent — the model sees these strings as tool errors and
 * must know what to fix.
 */

import type { CompileError } from "./compile-errors.js";
import { unwrap } from "./ids.js";

const listOrNone = (items: readonly { toString(): string }[]): string => {
	if (items.length === 0) return "none";
	return items.map((x) => `'${x}'`).join(", ");
};

export const formatCompileError = (error: CompileError): string => {
	switch (error.kind) {
		case "empty_plan":
			return "Plan has no steps. Add at least one action step and a terminal.";

		case "duplicate_step":
			return `Step id '${unwrap(error.stepId)}' appears more than once. Every step id must be unique within the plan.`;

		case "missing_entry":
			return (
				`Entry step '${unwrap(error.entryStep)}' is not defined in the plan's steps list. ` +
				`Available steps: ${listOrNone(error.availableSteps.map(unwrap))}.`
			);

		case "missing_actor":
			return (
				`Step '${unwrap(error.stepId)}' references actor '${unwrap(error.actor)}', ` +
				`which was not found in any relay-actors directory. ` +
				`Available actors: ${listOrNone(error.availableActors.map(unwrap))}.`
			);

		case "missing_route_target":
			return (
				`Step '${unwrap(error.from)}' declares route '${unwrap(error.route)}' → '${unwrap(error.target)}', ` +
				`but no step with id '${unwrap(error.target)}' exists. ` +
				`Available steps: ${listOrNone(error.availableSteps.map(unwrap))}.`
			);

		case "duplicate_artifact":
			return `Artifact '${unwrap(error.artifactId)}' is declared more than once in the plan's artifacts list.`;

		case "missing_artifact_contract":
			return (
				`Step '${unwrap(error.stepId)}' declares it ${error.direction}s artifact '${unwrap(error.artifactId)}', ` +
				`but no contract for that artifact is declared in the plan's artifacts list.`
			);

		case "missing_artifact_producer":
			return (
				`Artifact '${unwrap(error.artifactId)}' is declared in the plan's artifacts list but no step writes it. ` +
				`Either have a step declare it in its 'writes' or remove the contract.`
			);

		case "unsupported_context_policy":
			return (
				`Step '${unwrap(error.stepId)}' requests contextPolicy '${error.policy}', which is not supported in v0.1. ` +
				`Only 'fresh_per_run' is available. Remove the override or use 'fresh_per_run'.`
			);

	}
};
