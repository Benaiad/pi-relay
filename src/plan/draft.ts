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

const ArtifactIdField = (description: string) =>
	Type.String({
		description,
		minLength: 1,
		maxLength: 128,
		pattern: "^[a-z][a-z0-9_]*$",
	});

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
		reads: Type.Optional(
			Type.Array(ArtifactIdField("An ArtifactId this actor may read."), {
				description:
					"Artifacts visible to this step's actor in its input snapshot. Every read must have a writer. Defaults to none.",
			}),
		),
		writes: Type.Optional(
			Type.Array(ArtifactIdField("An ArtifactId this step may commit."), {
				description:
					"Artifacts this step is allowed to produce. Each artifact has at most one writing step. Defaults to none.",
			}),
		),
		routes: Type.Record(
			Type.String({
				minLength: 1,
				maxLength: 128,
				pattern: "^[a-zA-Z0-9_.:-]+$",
			}),
			IdField("StepId the runtime transitions to when this route is emitted."),
			{
				minProperties: 1,
				description:
					'Map of route names to target step IDs, e.g. { "done": "next-step", "failure": "handle-error" }. ' +
					"The actor must emit exactly one of these route names on completion.",
			},
		),
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
	},
	{
		description:
			"An LLM-backed step. The actor runs with the declared tool list and must call `complete_step` with " +
			"the chosen route and any artifact writes.",
	},
);

const CommandStepSchema = Type.Object(
	{
		kind: Type.Literal("command"),
		id: IdField("Unique step identifier within this plan."),
		command: Type.String({
			minLength: 1,
			description: "Shell command to run, e.g. 'npm test' or 'cargo test && cargo clippy'. " + "Executed via bash.",
		}),
		reads: Type.Optional(
			Type.Array(ArtifactIdField("An artifact ID this command step may access."), {
				description:
					"Artifacts injected as environment variables when the command runs. " +
					"Each read artifact is available as $artifact_id containing the value " +
					"(raw text for text artifacts, JSON for structured artifacts). Defaults to none.",
			}),
		),
		writes: Type.Optional(
			Type.Array(ArtifactIdField("An artifact ID this command step may produce."), {
				description:
					"Artifacts this step may write. The runtime creates a directory and sets $RELAY_OUT " +
					"to its path. Write files named after the artifact ID: echo value > $RELAY_OUT/artifact_id. " +
					"The runtime reads them back after exit. Do NOT mkdir $RELAY_OUT — it already exists. " +
					"Defaults to none.",
			}),
		),
		timeoutMs: Type.Optional(
			Type.Integer({
				minimum: 100,
				maximum: 600_000,
				description: "Timeout in milliseconds. Defaults to 600000 (10 minutes).",
			}),
		),
		onSuccess: IdField("StepId transitioned to when the command exits 0."),
		onFailure: IdField("StepId transitioned to when the command exits non-zero or times out."),
	},
	{
		description:
			"A deterministic step that runs a shell command. Succeeds iff the command exits 0 within " +
			"the timeout. Stdout and stderr are captured for the failure reason. " +
			"Reads artifacts as env vars, writes artifacts via the $RELAY_OUT directory.",
	},
);

const FilesExistStepSchema = Type.Object(
	{
		kind: Type.Literal("files_exist"),
		id: IdField("Unique step identifier within this plan."),
		paths: Type.Array(
			Type.String({
				minLength: 1,
				description: "Absolute or working-directory-relative path that must exist.",
			}),
			{
				minItems: 1,
				description: "Paths that must all exist for the check to pass. Failure reason lists which are missing.",
			},
		),
		onSuccess: IdField("StepId transitioned to when all paths exist."),
		onFailure: IdField("StepId transitioned to when one or more paths are missing."),
	},
	{
		description:
			"A deterministic step that checks filesystem paths. Succeeds iff every listed path exists. " +
			"Neither reads nor writes artifacts.",
	},
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

const StepSchema = Type.Union([ActionStepSchema, CommandStepSchema, FilesExistStepSchema, TerminalStepSchema], {
	description: "One node in the plan DAG. Exactly one of: action, command, files_exist, or terminal.",
});

const ArtifactContractSchema = Type.Object(
	{
		id: ArtifactIdField(
			"Unique artifact identifier within this plan. Must be snake_case (lowercase, digits, underscores).",
		),
		description: Type.String({
			minLength: 1,
			maxLength: 1000,
			description: "What this artifact represents, e.g. 'parsed requirements' or 'test output JSON'.",
		}),
		fields: Type.Optional(
			Type.Array(IdField("A field name the artifact value must contain."), {
				minItems: 1,
				description: "Named fields the artifact value must include. " + "Omit for plain text artifacts.",
			}),
		),
		list: Type.Optional(
			Type.Boolean({
				description:
					"If true, the artifact is an array of objects each with the declared fields. " +
					"Defaults to false (single object). Only meaningful when fields is present.",
			}),
		),
	},
	{
		description: "Compile-time declaration of an artifact's identity, description, and structure.",
	},
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
		artifacts: Type.Optional(
			Type.Array(ArtifactContractSchema, {
				description: "Every artifact the plan produces or consumes. Defaults to none.",
			}),
		),
		steps: Type.Array(StepSchema, {
			minItems: 1,
			maxItems: 64,
			description:
				"All steps in the plan. Must contain the entry step and at least one terminal step. Max 64 steps.",
		}),
		entryStep: Type.Optional(IdField("StepId where execution begins. Defaults to the first step in `steps`.")),
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
