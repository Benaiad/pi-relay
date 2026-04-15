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
	pi.registerTool<typeof PlanDraftSchema, RelayDetails>({
		name: "relay",
		label: "Relay",
		description: [
			"Execute a structured multi-step workflow with typed artifacts and deterministic verification gates.",
			"Use this for tasks that require multiple specialized actors, verification gates (tests/checks),",
			"or workflows where partial success is unacceptable.",
			"Do NOT use this for single-tool edits, Q&A, explanations, or simple bug fixes — call the",
			"underlying tools directly instead.",
			"The plan's actor names must match actors discovered from ~/.pi/agent/relay-actors/.",
		].join(" "),
		parameters: PlanDraftSchema,

		async execute(_toolCallId, plan, signal, onUpdate, ctx) {
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
			// Compile failed (or no details yet) — fall back to the plan preview so the user still
			// sees what the model proposed, alongside the compile error text in `content`.
			return renderPlanPreview(context.args, theme, options.expanded);
		},
	});
}
