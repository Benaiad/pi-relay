/**
 * Shared execute pipeline for relay and replay.
 *
 * Both tools converge after producing a `PlanDraftDoc`: compile the plan,
 * present the interactive review dialog, run it via `runPlan`, and return
 * a structured result with `RelayDetails`.
 *
 * This module owns the compile → review → run flow and the plan impact
 * analysis helpers. The scheduler lifecycle lives in `core/run-plan.ts`.
 */

import { resolve } from "node:path";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { actorRegistryFromDiscovery } from "./actors/discovery.js";
import type { ActorDiscovery, ValidatedActor } from "./actors/types.js";
import { validateActors } from "./actors/validate.js";
import { runPlan } from "./core/run-plan.js";
import type { RelayDetails } from "./pi-relay.js";
import { compile } from "./plan/compile.js";
import { formatCompileError } from "./plan/compile-error-format.js";
import type { PlanDraftDoc } from "./plan/draft.js";
import { ActorId } from "./plan/ids.js";
import { renderRunReportText } from "./runtime/run-report.js";

export interface ExecuteInput {
	readonly plan: PlanDraftDoc;
	readonly discovery: ActorDiscovery;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: AgentToolUpdateCallback<RelayDetails> | undefined;
	readonly ctx: ExtensionContext;
	readonly pi: ExtensionAPI;
	readonly toolName: string;
}

export const executePlan = async (input: ExecuteInput): Promise<AgentToolResult<RelayDetails>> => {
	const { plan, discovery, signal, onUpdate, ctx, pi, toolName } = input;

	const referencedActorNames = new Set(plan.steps.filter((s) => s.type === "action").map((s) => s.actor));
	const referencedActors = discovery.actors.filter((a) => referencedActorNames.has(a.name));

	const validatedActors = validateActors(
		referencedActors,
		ctx.modelRegistry,
		ctx.model,
		pi.getThinkingLevel(),
		(msg) => ctx.ui.notify(msg, "warning"),
	);
	const actorsByName = new Map<ReturnType<typeof ActorId>, ValidatedActor>(
		validatedActors.map((a) => [ActorId(a.name), a]),
	);
	const registry = actorRegistryFromDiscovery(discovery);

	const compileResult = compile(plan, registry);
	if (!compileResult.ok) {
		const message = formatCompileError(compileResult.error);
		const actorList =
			discovery.actors.length === 0
				? "(none — drop actor markdown files into ~/.pi/agent/pi-relay/actors/)"
				: discovery.actors.map((a) => a.name).join(", ");
		return {
			content: [
				{
					type: "text",
					text: `${toolName} compile failed: ${message}\n\nAvailable actors: ${actorList}`,
				},
			],
			details: { type: "compile_failed", message },
		};
	}

	const program = compileResult.value;

	if (ctx.hasUI) {
		const impact = summarizePlanImpact(plan, actorsByName);
		const needsReview = impact.mayEdit || impact.mayRunCommands || impact.unknownActors.length > 0;
		if (needsReview) {
			const title = buildSelectTitle(plan, impact);
			const choice = await ctx.ui.select(title, [CHOICE_RUN, CHOICE_REFINE, CHOICE_CANCEL]);

			if (choice === CHOICE_REFINE) {
				const feedback = await ctx.ui.editor("Refine the plan — what should the model change?", "");
				const trimmed = feedback?.trim() ?? "";
				if (trimmed.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `${toolName} plan cancelled: user opened the refine editor but submitted no feedback.`,
							},
						],
						details: { type: "cancelled", reason: "empty refinement feedback" },
					};
				}
				return {
					content: [
						{
							type: "text",
							text: [
								`The user reviewed this ${toolName} plan and requested refinements instead of running it.`,
								"Their feedback:",
								"---",
								trimmed,
								"---",
								`Revise the plan according to this feedback and call ${toolName} again with the updated plan.`,
								"Do NOT run the original plan.",
							].join("\n"),
						},
					],
					details: { type: "refined", feedback: trimmed },
				};
			}

			if (choice !== CHOICE_RUN) {
				return {
					content: [
						{
							type: "text",
							text: `${toolName} plan cancelled by user. The plan was not executed. Task: ${plan.task}`,
						},
					],
					details: { type: "cancelled", reason: "user declined plan review" },
				};
			}
		}
	}

	const effectiveCwd = "cwd" in plan && typeof plan.cwd === "string" ? resolve(ctx.cwd, plan.cwd) : ctx.cwd;
	const settingsManager = SettingsManager.create(effectiveCwd, getAgentDir());

	let lastEmitAt = 0;

	const result = await runPlan({
		program,
		actorsByName,
		modelRegistry: ctx.modelRegistry,
		cwd: effectiveCwd,
		signal,
		onProgress: onUpdate
			? (progress) => {
					const now = Date.now();
					if (now - lastEmitAt < 100) return;
					lastEmitAt = now;
					onUpdate({
						content: [{ type: "text", text: renderRunReportText(progress.report) }],
						details: {
							type: "state",
							state: progress.state,
							attemptTimeline: progress.report.timeline,
							checkOutput: progress.checkOutput,
						},
					});
				}
			: undefined,
		shellPath: settingsManager.getShellPath(),
		shellCommandPrefix: settingsManager.getShellCommandPrefix(),
	});

	// Final update with artifacts included in the report text
	if (onUpdate) {
		onUpdate({
			content: [{ type: "text", text: renderRunReportText(result.report, result.artifactStore) }],
			details: {
				type: "state",
				state: result.state,
				attemptTimeline: result.report.timeline,
			},
		});
	}

	return {
		content: [{ type: "text", text: renderRunReportText(result.report, result.artifactStore) }],
		details: {
			type: "state",
			state: result.state,
			attemptTimeline: result.report.timeline,
		},
	};
};

// ============================================================================
// Plan review helpers
// ============================================================================

const CHOICE_RUN = "Run the plan";
const CHOICE_REFINE = "Refine (tell the model what to change)";
const CHOICE_CANCEL = "Cancel";

export interface PlanImpact {
	readonly actionStepCount: number;
	readonly commandStepCount: number;
	readonly terminalStepCount: number;
	readonly artifactCount: number;
	readonly uniqueActors: readonly string[];
	readonly mayEdit: boolean;
	readonly mayRunCommands: boolean;
	readonly unknownActors: readonly string[];
	readonly commandChecks: readonly string[];
}

const EDIT_TOOLS = new Set(["edit", "write"]);
const COMMAND_TOOLS = new Set(["bash"]);

export const summarizePlanImpact = (
	plan: PlanDraftDoc,
	actorsByName: ReadonlyMap<ReturnType<typeof ActorId>, ValidatedActor>,
): PlanImpact => {
	let actionStepCount = 0;
	let commandStepCount = 0;
	let terminalStepCount = 0;
	const uniqueActors = new Set<string>();
	const unknownActors = new Set<string>();
	const commandChecks: string[] = [];
	let mayEdit = false;
	let mayRunCommands = false;

	for (const step of plan.steps) {
		if (step.type === "action") {
			actionStepCount += 1;
			uniqueActors.add(step.actor);
			const actor = actorsByName.get(ActorId(step.actor));
			if (!actor) {
				unknownActors.add(step.actor);
				continue;
			}
			const toolSet = new Set(actor.tools ?? []);
			for (const tool of toolSet) {
				if (EDIT_TOOLS.has(tool)) mayEdit = true;
				if (COMMAND_TOOLS.has(tool)) mayRunCommands = true;
			}
		} else if (step.type === "command") {
			commandStepCount += 1;
			const cmd = step.command;
			commandChecks.push(cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd);
			mayRunCommands = true;
		} else if (step.type === "files_exist") {
			commandStepCount += 1;
		} else {
			terminalStepCount += 1;
		}
	}

	return {
		actionStepCount,
		commandStepCount,
		terminalStepCount,
		artifactCount: (plan.artifacts ?? []).length,
		uniqueActors: Array.from(uniqueActors),
		mayEdit,
		mayRunCommands,
		unknownActors: Array.from(unknownActors),
		commandChecks,
	};
};

export const buildSelectTitle = (plan: PlanDraftDoc, impact: PlanImpact): string => {
	const parts: string[] = [`${plan.steps.length} steps`];

	if (impact.unknownActors.length > 0) {
		parts.push(`⚠ unknown actors: ${impact.unknownActors.join(", ")}`);
	}

	const bullets: string[] = [];
	if (impact.mayEdit) bullets.push("may edit files");
	if (impact.mayRunCommands) bullets.push("runs shell");
	if (impact.commandChecks.length > 0) {
		const first = impact.commandChecks[0];
		const rest = impact.commandChecks.length - 1;
		const suffix = rest > 0 ? ` (+${rest})` : "";
		bullets.push(`check: ${first}${suffix}`);
	}
	if (bullets.length === 0) {
		bullets.push("read-only");
	}
	parts.push(...bullets);

	return `Relay plan · ${parts.join(" · ")}`;
};
