/**
 * TypeBox schema for the `relay` tool's parameters.
 *
 * This schema IS the tool schema — when the model calls `relay`, it fills in
 * a value that matches this shape. Every field carries a `description` that
 * the model reads as part of the tool's prompt; these descriptions are the
 * primary instructional surface for how Relay should be used.
 *
 * The static type `PlanDraftDoc` is the "wire format" — plain strings for
 * identifiers. The compiler's job is to read a validated `PlanDraftDoc` and
 * produce a branded `PlanDraft` (see `types.ts`) with every identifier
 * checked against the plan's declared steps, actors, and artifacts.
 */

import { type Static, Type } from "@sinclair/typebox";

const IdField = (description: string) =>
	Type.String({
		description,
		minLength: 1,
		maxLength: 128,
		pattern: "^[a-zA-Z0-9_.:-]+$",
	});

const RouteEdgeSchema = Type.Object(
	{
		route: IdField("Route name emitted by the source step, e.g. 'success', 'failure', 'retry'."),
		to: IdField("StepId the runtime transitions to when this route is emitted."),
	},
	{
		description: "An outgoing edge from a step: when the step emits `route`, the runtime transitions to `to`.",
	},
);

const RetryPolicySchema = Type.Object(
	{
		maxAttempts: Type.Integer({
			minimum: 1,
			maximum: 10,
			description: "Maximum attempts before the step's failure route is taken. 1 means a single attempt.",
		}),
		backoffMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: 60_000,
				description: "Milliseconds to wait between attempts. Defaults to 0.",
			}),
		),
	},
	{ description: "Retry policy for an action step. Only applies to Action steps; checks never retry." },
);

const ContextPolicySchema = Type.Union(
	[Type.Literal("fresh_per_run"), Type.Literal("persist_per_step"), Type.Literal("persist_per_actor")],
	{
		description:
			"How the actor's conversation persists within a run. 'fresh_per_run' starts clean every call. " +
			"'persist_per_step' reuses the prior context when the same step re-enters. 'persist_per_actor' " +
			"shares context across all steps that use the same actor. v0.1 only supports 'fresh_per_run'.",
	},
);

const ActionStepSchema = Type.Object(
	{
		kind: Type.Literal("action"),
		id: IdField("Unique step identifier within this plan."),
		actor: IdField(
			"ActorId of the agent that will run this step. Must match an actor discovered in the relay-actors directory.",
		),
		instruction: Type.String({
			minLength: 1,
			maxLength: 8000,
			description: "Task instruction handed to the actor, describing exactly what to do.",
		}),
		reads: Type.Array(IdField("An ArtifactId this actor may read."), {
			description: "Artifacts visible to this step's actor in its input snapshot. Every read must have a writer.",
		}),
		writes: Type.Array(IdField("An ArtifactId this step may commit."), {
			description: "Artifacts this step is allowed to produce. Each artifact has at most one writing step.",
		}),
		routes: Type.Array(RouteEdgeSchema, {
			minItems: 1,
			description: "Outgoing edges. The actor must emit exactly one of these routes on successful completion.",
		}),
		retry: Type.Optional(RetryPolicySchema),
		maxRuns: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: 10_000,
				description:
					"Maximum times this step can be activated in a single run. Defaults to 10. " +
					"Increase for steps that are re-entered via back-edges in long-running loops " +
					"(e.g. an experiment loop that runs overnight).",
			}),
		),
		contextPolicy: Type.Optional(ContextPolicySchema),
	},
	{
		description:
			"An LLM-backed step. The actor runs with the declared tool list and must call `complete_step` with " +
			"the chosen route and any artifact writes.",
	},
);

const CheckSpecSchema = Type.Union(
	[
		Type.Object(
			{
				kind: Type.Literal("file_exists"),
				path: Type.String({
					minLength: 1,
					description: "Absolute or working-directory-relative path that must exist for the check to pass.",
				}),
			},
			{ description: "Pass iff the given path exists on the filesystem." },
		),
		Type.Object(
			{
				kind: Type.Literal("command_exits_zero"),
				command: Type.String({
					minLength: 1,
					description:
						"Shell command to run, e.g. 'npm test' or 'cargo test && cargo clippy'. " +
						"Executed through the platform shell (sh on Unix, cmd.exe on Windows).",
				}),
				cwd: Type.Optional(Type.String({ description: "Working directory override. Defaults to run cwd." })),
				timeoutMs: Type.Optional(
					Type.Integer({
						minimum: 100,
						maximum: 600_000,
						description: "Timeout in milliseconds. Defaults to 60000.",
					}),
				),
			},
			{
				description:
					"Pass iff the command runs and exits with code 0 within the timeout. Stdout and stderr are " +
					"captured for the failure reason.",
			},
		),
	],
	{
		description:
			"A deterministic check evaluated by the runtime, not the model. Use checks to gate agentic work on " +
			"verifiable outcomes (tests pass, file exists, etc.).",
	},
);

const CheckStepSchema = Type.Object(
	{
		kind: Type.Literal("check"),
		id: IdField("Unique step identifier within this plan."),
		check: CheckSpecSchema,
		onPass: IdField("StepId transitioned to when the check passes."),
		onFail: IdField("StepId transitioned to when the check fails."),
	},
	{ description: "A deterministic verification step. Neither reads nor writes artifacts." },
);

const TerminalStepSchema = Type.Object(
	{
		kind: Type.Literal("terminal"),
		id: IdField("Unique step identifier within this plan."),
		outcome: Type.Union([Type.Literal("success"), Type.Literal("failure")], {
			description: "Whether reaching this terminal represents the plan succeeding or failing.",
		}),
		summary: Type.String({
			minLength: 1,
			maxLength: 2000,
			description: "Human-readable summary of this terminal outcome, shown in the run report.",
		}),
	},
	{
		description: "A terminal step. Reaching one ends the run with the declared outcome.",
	},
);

const StepSchema = Type.Union([ActionStepSchema, CheckStepSchema, TerminalStepSchema], {
	description: "One node in the plan DAG. Exactly one of: action, check, or terminal.",
});

const ArtifactShapeSchema = Type.Object(
	{
		kind: Type.Literal("untyped_json"),
	},
	{
		description:
			"The stored shape of an artifact. v0.1 only supports `untyped_json`; named TypeBox shapes land in v0.2.",
	},
);

const ArtifactContractSchema = Type.Object(
	{
		id: IdField("Unique artifact identifier within this plan."),
		description: Type.String({
			minLength: 1,
			maxLength: 1000,
			description: "What this artifact represents, e.g. 'parsed requirements' or 'test output JSON'.",
		}),
		shape: ArtifactShapeSchema,
		multiWriter: Type.Optional(
			Type.Boolean({
				description:
					"Opt-in relaxation of the default single-writer rule. Set to true when a loop re-enters a " +
					"step via a back-edge and the step needs to update the SAME artifact across iterations. " +
					"Reads see the latest committed value; commits are still atomic. Leave unset for normal " +
					"artifacts — single-writer is the default and makes plans easier to reason about.",
			}),
		),
	},
	{ description: "Compile-time declaration of an artifact's identity, description, and shape." },
);

export const PlanDraftSchema = Type.Object(
	{
		task: Type.String({
			minLength: 1,
			maxLength: 4000,
			description: "Natural-language description of what this plan accomplishes.",
		}),
		successCriteria: Type.Optional(
			Type.String({
				maxLength: 2000,
				description: "How success will be judged. Referenced by actors and reviewers as part of their context.",
			}),
		),
		artifacts: Type.Array(ArtifactContractSchema, {
			description: "Every artifact the plan produces or consumes. Empty for plans with no intermediate state.",
		}),
		steps: Type.Array(StepSchema, {
			minItems: 1,
			maxItems: 64,
			description:
				"All steps in the plan. Must contain the entry step and at least one terminal step. Max 64 steps.",
		}),
		entryStep: IdField("StepId where execution begins. Must match one of the steps in `steps`."),
	},
	{
		description:
			"A structured plan for a multi-step workflow. Submit one of these via the `relay` tool when a task " +
			"requires multiple actors, verification gates, or outcomes where partial success is unacceptable. " +
			"For simple one-shot edits, Q&A, or single-tool work, call the underlying tools directly instead.",
	},
);

/**
 * Wire-format type derived from `PlanDraftSchema`.
 *
 * All identifiers are plain strings at this layer. The compiler consumes this
 * type, brands the IDs, and produces a `Program` (see `plan/program.ts`).
 */
export type PlanDraftDoc = Static<typeof PlanDraftSchema>;
