/**
 * Structured compile errors.
 *
 * Every failure the compiler can surface is a variant of this union. Each
 * variant carries the offending identifiers plus, where useful, the list of
 * candidates the model might have meant — so error messages can be concrete.
 *
 * Display text lives in `compile-error-format.ts`. Keep this file types-only.
 */

import type { ActorId, ArtifactId, RouteId, StepId } from "./ids.js";

export type CompileError =
	| { readonly type: "empty_plan" }
	| { readonly type: "no_terminal" }
	| { readonly type: "terminal_entry"; readonly entryStep: StepId }
	| { readonly type: "duplicate_step"; readonly stepId: StepId }
	| {
			readonly type: "missing_entry";
			readonly entryStep: StepId;
			readonly availableSteps: readonly StepId[];
	  }
	| {
			readonly type: "missing_actor";
			readonly stepId: StepId;
			readonly actor: ActorId;
			readonly availableActors: readonly ActorId[];
	  }
	| {
			readonly type: "missing_route_target";
			readonly from: StepId;
			readonly route: RouteId;
			readonly target: StepId;
			readonly availableSteps: readonly StepId[];
	  }
	| {
			readonly type: "duplicate_artifact";
			readonly artifactId: ArtifactId;
	  }
	| {
			readonly type: "missing_artifact_contract";
			readonly artifactId: ArtifactId;
			readonly stepId: StepId;
			readonly direction: "read" | "write";
	  }
	| {
			readonly type: "missing_artifact_producer";
			readonly artifactId: ArtifactId;
	  };
