/**
 * pi-relay extension entry.
 *
 * Registers two tools:
 *   - `relay`  — the model builds an ad-hoc PlanDraftDoc from scratch
 *   - `replay` — the model invokes a saved plan template by name with args
 *
 * Both tools share the compile → review → schedule pipeline in `execute.ts`.
 * This file stays thin: it discovers actors and templates at extension load,
 * builds tool descriptions, and wires the pi extension API to the modules.
 *
 * Tool descriptions are built once at extension load and embed the current
 * actor and template lists. This is deliberate: rebuilding per-turn would
 * break prompt caching. Users run `/reload` after editing files.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverActors } from "./actors/discovery.js";
import type { ActorConfig } from "./actors/types.js";
import { executePlan } from "./execute.js";
import { PlanDraftSchema } from "./plan/draft.js";
import { renderPlanPreview } from "./render/plan-preview.js";
import { renderCancelled, renderCompileFailure, renderRefined, renderRunResult } from "./render/run-result.js";
import { registerReplayTool } from "./replay.js";
import type { RelayRunState } from "./runtime/events.js";
import type { AttemptTimelineEntry } from "./runtime/run-report.js";
import { discoverPlanTemplates } from "./templates/discovery.js";

/**
 * The `details` payload carried by `onUpdate` and the final tool result.
 *
 * Four shapes because compile failures, user cancels, user refinement
 * requests, and runtime states are very different things to render.
 */
export type RelayDetails =
	| { readonly kind: "compile_failed"; readonly message: string }
	| { readonly kind: "cancelled"; readonly reason: string }
	| { readonly kind: "refined"; readonly feedback: string }
	| {
			readonly kind: "state";
			readonly state: RelayRunState;
			readonly attemptTimeline: readonly AttemptTimelineEntry[];
	  };

export default function (pi: ExtensionAPI): void {
	const loadDiscovery = discoverActors(process.cwd(), "user");
	const actorNames = new Set(loadDiscovery.actors.map((a) => a.name));

	const templateDiscovery = discoverPlanTemplates(process.cwd(), "user", { actorNames });
	for (const warning of templateDiscovery.warnings) {
		console.error(`[relay] Template "${warning.templateName}": ${warning.message} (${warning.filePath})`);
	}

	const relayDescription = buildToolDescription(loadDiscovery.actors);

	pi.registerTool<typeof PlanDraftSchema, RelayDetails>({
		name: "relay",
		label: "Relay",
		description: relayDescription,
		parameters: PlanDraftSchema,

		async execute(_toolCallId, plan, signal, onUpdate, ctx) {
			const discovery = discoverActors(ctx.cwd, "user");
			return executePlan({ plan, discovery, signal, onUpdate, ctx, toolName: "Relay" });
		},

		renderCall(plan, theme, context) {
			return renderPlanPreview(plan, theme, context.expanded, context.lastComponent);
		},

		renderResult(result, options, theme, context) {
			return renderRelayResult(result, options, theme, context);
		},
	});

	registerReplayTool(pi, templateDiscovery.templates);
}

// ============================================================================
// Shared result renderer (used by both relay and replay)
// ============================================================================

export const renderRelayResult = (
	result: { details?: RelayDetails; content: Array<{ type: string; text?: string }> },
	options: { expanded: boolean },
	theme: Parameters<typeof renderRunResult>[2],
	context: { lastComponent?: Parameters<typeof renderRunResult>[4]; args?: any },
): ReturnType<typeof renderRunResult> => {
	const details = result.details;
	if (details?.kind === "state") {
		return renderRunResult(details.state, details.attemptTimeline, theme, options.expanded, context.lastComponent);
	}
	if (details?.kind === "compile_failed") {
		return renderCompileFailure(details.message, theme, context.lastComponent);
	}
	if (details?.kind === "cancelled") {
		return renderCancelled(details.reason, theme, context.lastComponent);
	}
	if (details?.kind === "refined") {
		return renderRefined(details.feedback, theme, context.lastComponent);
	}
	return renderPlanPreview(context.args, theme, options.expanded, context.lastComponent);
};

// ============================================================================
// Tool description builder
// ============================================================================

export const buildToolDescription = (actors: readonly ActorConfig[]): string => {
	const staticPart = [
		"Execute a structured multi-step workflow with typed artifacts and deterministic verification gates.",
		"Use this for tasks that require multiple specialized actors, verification gates (tests/checks),",
		"or workflows where partial success is unacceptable.",
		"Do NOT use this for single-tool edits, Q&A, explanations, or simple bug fixes — call the",
		"underlying tools directly instead.",
		"YOU are the planner: when you submit a plan, the step instructions must already contain concrete",
		"file paths, commands, and decisions you have reasoned through. Do NOT add a 'planner' actor to",
		"the plan expecting a second round of planning to happen at runtime — actors execute, they do not",
		"plan. If you need to scout the codebase, use your own read/grep/find tools before calling relay,",
		"then bake the findings into the plan's instructions.",
	].join(" ");

	if (actors.length === 0) {
		return [
			staticPart,
			"",
			"NO ACTORS ARE CURRENTLY INSTALLED. Drop actor markdown files into",
			"~/.pi/agent/relay/actors/ and run /reload to enable this tool.",
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
		"",
		"For review/fix loops, mark the looped artifacts with 'multiWriter: true' in the artifacts list.",
		"This lets multiple steps (or the same step re-entered via a back-edge) write to the same artifact",
		"id with latest-wins semantics. Without multiWriter the compiler rejects multi-writer plans. A clean",
		"review loop looks like: create writes notes → review reads notes writes verdict → fix reads verdict",
		"writes notes → (back-edge) review → accepted terminates. notes and verdict are both multiWriter.",
	].join("\n");
};
