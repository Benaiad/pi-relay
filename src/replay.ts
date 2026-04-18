/**
 * The `replay` tool — run a saved plan template by name with arguments.
 *
 * Complements `relay` (ad-hoc plans) with a second tool for saved,
 * parameterized workflows. The model calls `replay` with a template
 * name and args; the extension substitutes, validates, compiles, and
 * runs the plan through the same pipeline relay uses.
 *
 * The tool description is built once at extension load and lists every
 * discovered template with its parameter signature.
 */

import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { type Static, Type } from "@sinclair/typebox";
import { discoverActors } from "./actors/discovery.js";
import { filterActors, filterPlans, loadRelayConfig } from "./config.js";
import { executePlan } from "./execute.js";
import type { RelayDetails, RelayRenderState } from "./index.js";
import { manageElapsedTimer, renderRelayResult } from "./index.js";
import { discoverPlanTemplates } from "./templates/discovery.js";
import { formatTemplateError } from "./templates/errors.js";
import { instantiateTemplate } from "./templates/substitute.js";
import type { PlanTemplate } from "./templates/types.js";

const ReplayParamsSchema = Type.Object({
	name: Type.String({
		description: "Name of a saved plan template to run.",
		minLength: 1,
	}),
	args: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Parameter values for the template. Keys are parameter names, values are strings.",
		}),
	),
});

type ReplayParams = Static<typeof ReplayParamsSchema>;

export interface ReplayBundledDirs {
	readonly actorsDir?: string;
	readonly plansDir?: string;
}

export const registerReplayTool = (
	pi: ExtensionAPI,
	templates: readonly PlanTemplate[],
	bundled: ReplayBundledDirs = {},
): void => {
	const description = buildReplayToolDescription(templates);

	pi.registerTool<typeof ReplayParamsSchema, RelayDetails, RelayRenderState>({
		name: "replay",
		label: "Replay",
		description,
		parameters: ReplayParamsSchema,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = loadRelayConfig();
			const fullActorDiscovery = discoverActors(ctx.cwd, "user", { bundledDir: bundled.actorsDir });
			const actorDiscovery = { ...fullActorDiscovery, actors: filterActors(fullActorDiscovery.actors, config) };
			const actorNames = new Set(actorDiscovery.actors.map((a) => a.name));
			const templateDiscovery = discoverPlanTemplates(ctx.cwd, "user", {
				actorNames,
				bundledDir: bundled.plansDir,
			});
			const enabledTemplates = filterPlans(templateDiscovery.templates, config);

			const template = enabledTemplates.find((t) => t.name === params.name);
			if (!template) {
				const message = formatTemplateError({
					kind: "missing_template",
					name: params.name,
					available: enabledTemplates.map((t) => t.name),
				});
				return {
					content: [{ type: "text", text: `Replay failed: ${message}` }],
					details: { kind: "compile_failed", message },
				};
			}

			const instantiation = instantiateTemplate(template, params.args ?? {});
			if (!instantiation.ok) {
				const message = formatTemplateError(instantiation.error);
				return {
					content: [{ type: "text", text: `Replay failed: ${message}` }],
					details: { kind: "compile_failed", message },
				};
			}

			return executePlan({
				plan: instantiation.value.plan,
				discovery: actorDiscovery,
				signal,
				onUpdate,
				ctx,
				toolName: "Replay",
			});
		},

		renderCall(params, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatReplayCall(params, theme));
			return text;
		},

		renderResult(result, options, theme, context) {
			manageElapsedTimer(options, context.state, context.invalidate);
			return renderRelayResult(result, options, theme, context);
		},
	});
};

// ============================================================================
// Tool description
// ============================================================================

export const buildReplayToolDescription = (templates: readonly PlanTemplate[]): string => {
	const staticPart = [
		"Run a saved relay plan by name with arguments.",
		"Each plan is a multi-step workflow that spawns AI agents to read, edit, and write files,",
		"run shell commands, and pass structured artifacts between steps.",
		"Deterministic verification gates (test suites, linters, type checkers) decide pass/fail — not the agents.",
		"The user reviews and approves the plan before execution begins.",
		"",
		"Use this when the task matches a saved plan. You provide only the arguments;",
		"the plan structure, actors, and verification gates are fixed by the template author.",
		"Do NOT use this for tasks that don't match any available plan — use relay for ad-hoc workflows,",
		"or call tools directly for simple one-step work.",
	].join(" ");

	if (templates.length === 0) {
		return [
			staticPart,
			"",
			"NO PLANS ARE CURRENTLY INSTALLED. Drop plan markdown files into",
			"~/.pi/agent/pi-relay/plans/ and run /reload to enable this tool.",
		].join("\n");
	}

	const lines = templates.map((t) => {
		const paramSig =
			t.parameters.length > 0
				? `(${t.parameters.map((p) => (p.required ? p.name : `${p.name}?`)).join(", ")})`
				: "()";
		const paramDetails = t.parameters.map((p) => {
			const req = p.required ? "required" : "optional";
			return `      ${p.name} (${req}): ${p.description}`;
		});
		const detailBlock = paramDetails.length > 0 ? `\n${paramDetails.join("\n")}` : "";
		return `  - ${t.name}${paramSig}: ${t.description}${detailBlock}`;
	});

	return [staticPart, "", "Available plans:", ...lines].join("\n");
};

// ============================================================================
// Render helpers
// ============================================================================

const formatReplayCall = (params: ReplayParams, theme: Theme): string => {
	const args = params.args ?? {};
	const argParts = Object.entries(args).map(([k, v]) => `${k}=${v}`);
	const argStr = argParts.length > 0 ? `  ${argParts.join(" ")}` : "";
	return `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold("replay"))}  ${theme.fg("accent", params.name)}${theme.fg("dim", argStr)}`;
};
