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
	| { readonly kind: "empty_plan" }
	| { readonly kind: "no_terminal" }
	| { readonly kind: "terminal_entry"; readonly entryStep: StepId }
	| { readonly kind: "duplicate_step"; readonly stepId: StepId }
	| {
			readonly kind: "missing_entry";
			readonly entryStep: StepId;
			readonly availableSteps: readonly StepId[];
	  }
	| {
			readonly kind: "missing_actor";
			readonly stepId: StepId;
			readonly actor: ActorId;
			readonly availableActors: readonly ActorId[];
	  }
	| {
			readonly kind: "missing_route_target";
			readonly from: StepId;
			readonly route: RouteId;
			readonly target: StepId;
			readonly availableSteps: readonly StepId[];
	  }
	| {
			readonly kind: "duplicate_artifact";
			readonly artifactId: ArtifactId;
	  }
	| {
			readonly kind: "missing_artifact_contract";
			readonly artifactId: ArtifactId;
			readonly stepId: StepId;
			readonly direction: "read" | "write";
	  }
	| {
			readonly kind: "missing_artifact_producer";
			readonly artifactId: ArtifactId;
	  };
