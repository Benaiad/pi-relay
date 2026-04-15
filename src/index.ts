/**
 * pi-relay extension entry.
 *
 * Registers a single tool (`relay`) whose parameter schema IS the plan —
 * when the model calls `relay`, it fills in a `PlanDraftDoc`. The extension
 * compiles the plan, runs it, and returns a structured `RunReport` as the
 * tool result.
 *
 * This file stays thin. All compile, runtime, and rendering logic lives in
 * the modules under src/plan, src/runtime, src/actors, and src/render. The
 * only job here is wiring pi's extension API to those modules.
 *
 * The tool description is built once at extension load and lists every
 * discovered actor. This is deliberate: rebuilding it per-turn would break
 * prompt caching and add no value, because the actor set is stable within
 * a session. Users who add or edit actor files mid-session run `/reload`
 * to pick up the changes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { actorRegistryFromDiscovery, discoverActors } from "./actors/discovery.js";
import { createSubprocessActorEngine } from "./actors/engine.js";
import type { ActorConfig } from "./actors/types.js";
import { compile } from "./plan/compile.js";
import { formatCompileError } from "./plan/compile-error-format.js";
import { PlanDraftSchema } from "./plan/draft.js";
import { ActorId } from "./plan/ids.js";
import { renderPlanPreview } from "./render/plan-preview.js";
import { renderRunResult } from "./render/run-result.js";
import { ArtifactStore } from "./runtime/artifacts.js";
import { AuditLog } from "./runtime/audit.js";
import type { RelayRunState } from "./runtime/events.js";
import { buildRunReport, renderRunReportText } from "./runtime/run-report.js";
import { Scheduler } from "./runtime/scheduler.js";

/**
 * The `details` payload carried by `onUpdate` and the final tool result.
 *
 * Three shapes because compile failures, runtime states, and user cancels are
 * very different things to render.
 */
export type RelayDetails =
	| { readonly kind: "compile_failed"; readonly message: string }
	| { readonly kind: "cancelled"; readonly reason: string }
	| { readonly kind: "state"; readonly state: RelayRunState };

export default function (pi: ExtensionAPI): void {
	// Discover actors once at extension load. The tool description embeds the
	// current actor list so the model sees it from turn 1 without per-turn
	// system prompt injection. Users `/reload` after editing actor files.
	const loadDiscovery = discoverActors(process.cwd(), "user");
	const description = buildToolDescription(loadDiscovery.actors);

	pi.registerTool<typeof PlanDraftSchema, RelayDetails>({
		name: "relay",
		label: "Relay",
		description,
		parameters: PlanDraftSchema,

		async execute(_toolCallId, plan, signal, onUpdate, ctx) {
			// Re-discover on every execute so mid-session actor file edits take
			// effect the NEXT time relay is called, without `/reload`. The tool
			// description the model saw remains stable for prompt caching; only
			// the runtime registry is fresh.
			const discovery = discoverActors(ctx.cwd, "user");
			const actorsByName = new Map<ReturnType<typeof ActorId>, ActorConfig>(
				discovery.actors.map((a) => [ActorId(a.name), a]),
			);
			const registry = actorRegistryFromDiscovery(discovery);

			const compileResult = compile(plan, registry);
			if (!compileResult.ok) {
				const message = formatCompileError(compileResult.error);
				const actorList =
					discovery.actors.length === 0
						? "(none — drop actor markdown files into ~/.pi/agent/relay-actors/)"
						: discovery.actors.map((a) => a.name).join(", ");
				return {
					content: [
						{
							type: "text",
							text: `Relay compile failed: ${message}\n\nAvailable actors: ${actorList}`,
						},
					],
					details: { kind: "compile_failed", message },
				};
			}

			const program = compileResult.value;

			// Interactive plan review. Pi's built-in bash/edit/write confirmations
			// don't fire for custom extension tools, and the subprocess actors run
			// with `pi -p --no-session` which auto-accepts everything. The outer
			// confirmation is therefore the ONLY gate on a relay plan — it has to
			// exist, and it has to carry enough information for an informed decision.
			//
			// Read-only plans (no edit/write/bash actors, no command_exits_zero
			// checks, no unknown actors) skip the dialog — nothing destructive can
			// happen, and prompting for Q&A / exploration plans is pure friction.
			if (ctx.hasUI) {
				const impact = summarizePlanImpact(plan, actorsByName);
				const needsConfirm = impact.mayEdit || impact.mayRunCommands || impact.unknownActors.length > 0;
				if (needsConfirm) {
					const title = "Run this Relay plan?";
					const body = buildConfirmationBody(plan, impact);
					const approved = await ctx.ui.confirm(title, body);
					if (!approved) {
						return {
							content: [
								{
									type: "text",
									text: `Relay plan cancelled by user. The plan was not executed. Task: ${plan.task}`,
								},
							],
							details: { kind: "cancelled", reason: "user declined plan review" },
						};
					}
				}
			}

			const clock = () => Date.now();
			const audit = new AuditLog();
			const artifactStore = new ArtifactStore(program, clock);
			const scheduler = new Scheduler({
				program,
				actorEngine: createSubprocessActorEngine(),
				actorsByName,
				cwd: ctx.cwd,
				signal,
				clock,
				audit,
				artifactStore,
			});

			let lastEmitAt = 0;
			const emitUpdate = (force: boolean): void => {
				if (!onUpdate) return;
				const now = Date.now();
				if (!force && now - lastEmitAt < 100) return;
				lastEmitAt = now;
				const state = scheduler.getState();
				const report = buildRunReport(state);
				onUpdate({
					content: [{ type: "text", text: renderRunReportText(report) }],
					details: { kind: "state", state },
				});
			};

			const subscription = scheduler.subscribe(() => emitUpdate(false));
			try {
				const report = await scheduler.run();
				emitUpdate(true);
				const finalState = scheduler.getState();
				return {
					content: [{ type: "text", text: renderRunReportText(report) }],
					details: { kind: "state", state: finalState },
				};
			} finally {
				subscription.unsubscribe();
			}
		},

		renderCall(plan, theme, context) {
			return renderPlanPreview(plan, theme, context.expanded, context.lastComponent);
		},

		renderResult(result, options, theme, context) {
			const details = result.details;
			if (details?.kind === "state") {
				return renderRunResult(details.state, theme, options.expanded, context.lastComponent);
			}
			return renderPlanPreview(context.args, theme, options.expanded, context.lastComponent);
		},
	});
}

// ============================================================================
// Plan review (confirmation dialog) helpers
// ============================================================================

/**
 * Structural impact of a plan — used to build the confirmation body.
 *
 * The model and tool set each actor brings determine whether the plan will
 * touch the filesystem, run shell commands, or only read. This summary lets
 * the user see at a glance what the plan is authorized to do, without
 * scrolling through every step.
 */
export interface PlanImpact {
	readonly actionStepCount: number;
	readonly checkStepCount: number;
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
	plan: import("./plan/draft.js").PlanDraftDoc,
	actorsByName: ReadonlyMap<ReturnType<typeof ActorId>, ActorConfig>,
): PlanImpact => {
	let actionStepCount = 0;
	let checkStepCount = 0;
	let terminalStepCount = 0;
	const uniqueActors = new Set<string>();
	const unknownActors = new Set<string>();
	const commandChecks: string[] = [];
	let mayEdit = false;
	let mayRunCommands = false;

	for (const step of plan.steps) {
		if (step.kind === "action") {
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
		} else if (step.kind === "check") {
			checkStepCount += 1;
			if (step.check.kind === "command_exits_zero") {
				const cmd = [step.check.command, ...step.check.args].join(" ");
				commandChecks.push(cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd);
				mayRunCommands = true;
			}
		} else {
			terminalStepCount += 1;
		}
	}

	return {
		actionStepCount,
		checkStepCount,
		terminalStepCount,
		artifactCount: plan.artifacts.length,
		uniqueActors: Array.from(uniqueActors),
		mayEdit,
		mayRunCommands,
		unknownActors: Array.from(unknownActors),
		commandChecks,
	};
};

/**
 * Compact confirmation body.
 *
 * The full plan is already rendered above the dialog via `renderCall` — the
 * user sees task, step list, actors, and artifacts in the chat scroll as a
 * normal tool call preview. Duplicating that inside the modal just produces
 * a truncated body users can't scroll through.
 *
 * The dialog therefore carries only the IMPACT summary (what the plan is
 * authorized to touch) plus the subprocess-actors disclaimer. Three to five
 * short lines, always visible regardless of the modal's size limits.
 */
export const buildConfirmationBody = (plan: import("./plan/draft.js").PlanDraftDoc, impact: PlanImpact): string => {
	const lines: string[] = [];

	if (impact.unknownActors.length > 0) {
		lines.push(`⚠ unknown actors: ${impact.unknownActors.join(", ")}`);
	}

	const bullets: string[] = [];
	if (impact.mayEdit) bullets.push("may create, edit, or write files");
	if (impact.mayRunCommands) bullets.push("may run shell commands");
	if (impact.commandChecks.length > 0) {
		const first = impact.commandChecks[0];
		const rest = impact.commandChecks.length - 1;
		const suffix = rest > 0 ? ` (+${rest} more)` : "";
		bullets.push(`check runs: ${first}${suffix}`);
	}
	for (const bullet of bullets) lines.push(`• ${bullet}`);

	if (bullets.length === 0) {
		lines.push("read-only (no filesystem writes or shell commands)");
	}

	lines.push("");
	lines.push("Subprocess actors run non-interactively: approving this");
	lines.push("authorizes every step in the plan. Full plan is shown above.");

	void plan;
	return lines.join("\n");
};

/**
 * Build the tool description shown to the model in the system prompt's tools
 * section.
 *
 * Includes:
 *   - A static prose block describing when to use the tool and when not to
 *   - A dynamically-rendered actor list with each actor's description and
 *     declared tool restrictions
 *   - A reminder that per-step `instruction` is the task-specific input, not
 *     the actor's persona
 *
 * Stable for the session. Users run `/reload` to refresh after editing actor
 * files.
 */
export const buildToolDescription = (actors: readonly ActorConfig[]): string => {
	const staticPart = [
		"Execute a structured multi-step workflow with typed artifacts and deterministic verification gates.",
		"Use this for tasks that require multiple specialized actors, verification gates (tests/checks),",
		"or workflows where partial success is unacceptable.",
		"Do NOT use this for single-tool edits, Q&A, explanations, or simple bug fixes — call the",
		"underlying tools directly instead.",
	].join(" ");

	if (actors.length === 0) {
		return [
			staticPart,
			"",
			"NO ACTORS ARE CURRENTLY INSTALLED. Drop actor markdown files into",
			"~/.pi/agent/relay-actors/ and run /reload to enable this tool.",
		].join("\n");
	}

	const actorLines = actors.map((actor) => {
		const toolsSuffix =
			actor.tools && actor.tools.length > 0 ? ` [allowed tools: ${actor.tools.join(", ")}]` : " [default tool set]";
		const modelSuffix = actor.model ? ` [model: ${actor.model}]` : "";
		return `  - ${actor.name}: ${actor.description}${toolsSuffix}${modelSuffix}`;
	});

	return [
		staticPart,
		"",
		"Available actors for the 'actor' field of each action step. Use these names EXACTLY:",
		...actorLines,
		"",
		"Each action step carries an 'instruction' field that is the task-specific prompt for that step.",
		"The actor's persona (tool list, coding standards, output style) stays the same across steps;",
		"the 'instruction' is how you tell the SAME actor to do DIFFERENT work at different points in the plan.",
	].join("\n");
};
