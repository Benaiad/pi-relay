/**
 * Shared execute pipeline for relay and replay.
 *
 * Both tools converge after producing a `PlanDraftDoc`: compile the plan,
 * present the interactive review dialog, construct a scheduler, run it,
 * and return a structured result with `RelayDetails`.
 *
 * This module owns the compile → review → schedule flow and the plan
 * impact analysis helpers. It does NOT own tool registration, tool
 * descriptions, or `renderCall` — those differ between relay and replay.
 */

import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type ExtensionContext,
	getAgentDir,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { actorRegistryFromDiscovery } from "./actors/discovery.js";
import { createSdkActorEngine } from "./actors/sdk-engine.js";
import type { ActorConfig, ActorDiscovery } from "./actors/types.js";
import type { RelayDetails } from "./pi-relay.js";
import { compile } from "./plan/compile.js";
import { formatCompileError } from "./plan/compile-error-format.js";
import type { PlanDraftDoc } from "./plan/draft.js";
import { ActorId, type StepId } from "./plan/ids.js";
import { ArtifactStore } from "./runtime/artifacts.js";
import { AuditLog } from "./runtime/audit.js";
import type { RelayRunState } from "./runtime/events.js";
import { buildAttemptTimeline, buildRunReport, renderRunReportText } from "./runtime/run-report.js";
import { Scheduler } from "./runtime/scheduler.js";

export interface ExecuteInput {
	readonly plan: PlanDraftDoc;
	readonly discovery: ActorDiscovery;
	readonly signal: AbortSignal | undefined;
	readonly onUpdate: AgentToolUpdateCallback<RelayDetails> | undefined;
	readonly ctx: ExtensionContext;
	readonly toolName: string;
}

export const executePlan = async (input: ExecuteInput): Promise<AgentToolResult<RelayDetails>> => {
	const { plan, discovery, signal, onUpdate, ctx, toolName } = input;

	const actorsByName = new Map<ReturnType<typeof ActorId>, ActorConfig>(
		discovery.actors.map((a) => [ActorId(a.name), a]),
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

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(ctx.cwd, agentDir);

	const clock = () => Date.now();
	const audit = new AuditLog();
	const artifactStore = new ArtifactStore(program, clock);
	const scheduler = new Scheduler({
		program,
		actorEngine: createSdkActorEngine({
			modelRegistry: ctx.modelRegistry,
			defaultModel: ctx.model,
		}),
		actorsByName,
		cwd: ctx.cwd,
		signal,
		clock,
		audit,
		artifactStore,
		shellPath: settingsManager.getShellPath(),
		shellCommandPrefix: settingsManager.getShellCommandPrefix(),
	});

	let lastEmitAt = 0;
	const emitUpdate = (force: boolean): void => {
		if (!onUpdate) return;
		const now = Date.now();
		if (!force && now - lastEmitAt < 100) return;
		lastEmitAt = now;
		const state = scheduler.getState();
		const auditLog = scheduler.getAudit();
		const attemptTimeline = buildAttemptTimeline(auditLog.entries(), program);
		const report = buildRunReport(state, auditLog);
		const checkOutput = buildCheckOutputSnapshot(scheduler, state);
		onUpdate({
			content: [{ type: "text", text: renderRunReportText(report) }],
			details: { type: "state", state, attemptTimeline, checkOutput },
		});
	};

	const eventSub = scheduler.subscribe(() => emitUpdate(false));
	const outputSub = scheduler.subscribeOutput(() => emitUpdate(false));
	try {
		const report = await scheduler.run();
		emitUpdate(true);
		const finalState = scheduler.getState();
		const finalTimeline = buildAttemptTimeline(scheduler.getAudit().entries(), program);
		return {
			content: [{ type: "text", text: renderRunReportText(report, artifactStore) }],
			details: {
				type: "state",
				state: finalState,
				attemptTimeline: finalTimeline,
			},
		};
	} finally {
		eventSub.unsubscribe();
		outputSub.unsubscribe();
	}
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
	actorsByName: ReadonlyMap<ReturnType<typeof ActorId>, ActorConfig>,
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

// ============================================================================
// Check output snapshot
// ============================================================================

const buildCheckOutputSnapshot = (
	scheduler: Scheduler,
	state: RelayRunState,
): ReadonlyMap<StepId, string> | undefined => {
	let result: Map<StepId, string> | undefined;
	for (const stepId of state.currentlyRunning) {
		const output = scheduler.getCheckOutput(stepId);
		if (output === undefined) continue;
		result ??= new Map();
		result.set(stepId, output);
	}
	return result;
};
