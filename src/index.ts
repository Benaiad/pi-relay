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
 * Two shapes because compile failures and runtime states are very different
 * things to render: one is a static error message, the other is a live DAG.
 */
export type RelayDetails =
	| { readonly kind: "compile_failed"; readonly message: string }
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
			return renderPlanPreview(plan, theme, context.expanded);
		},

		renderResult(result, options, theme, context) {
			const details = result.details;
			if (details?.kind === "state") {
				return renderRunResult(details.state, theme, options.expanded);
			}
			return renderPlanPreview(context.args, theme, options.expanded);
		},
	});
}

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
