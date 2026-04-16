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
 * Tool descriptions are built once at extension load and list the current
 * actors and templates. Adding, removing, or renaming actors/templates
 * requires `/reload` to update what the model sees. Edits to system
 * prompts, plan bodies, and tool lists are picked up on the next
 * execution without reloading.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, getAgentDir, getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, matchesKey, Text } from "@mariozechner/pi-tui";
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
import type { PlanTemplate } from "./templates/types.js";

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
	seedBundledFiles();

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

	pi.registerCommand("relay", {
		description: "Show available relay actors and plan templates",
		async handler(_args, ctx) {
			if (!ctx.hasUI) return;
			const discovery = discoverActors(ctx.cwd, "user");
			const actorNameSet = new Set(discovery.actors.map((a) => a.name));
			const templates = discoverPlanTemplates(ctx.cwd, "user", { actorNames: actorNameSet });
			const md = formatRelayOverview(discovery.actors, templates.templates);

			await ctx.ui.custom((_tui, theme, _kb, done) => {
				const container = new Container();
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				container.addChild(border);
				container.addChild(new Text(theme.fg("accent", theme.bold("Relay")), 1, 0));
				container.addChild(new Markdown(md, 1, 1, getMarkdownTheme()));
				container.addChild(border);
				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
							done(undefined);
						}
					},
				};
			});
		},
	});
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
// Auto-seed bundled actors and plans
// ============================================================================

const seedBundledFiles = (): void => {
	const packageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
	if (!packageRoot) return;
	const agentDir = getAgentDir();

	seedDir(path.join(packageRoot, "actors"), path.join(agentDir, "relay", "actors"));
	seedDir(path.join(packageRoot, "plans"), path.join(agentDir, "relay", "plans"));
};

const findPackageRoot = (startDir: string): string | null => {
	let dir = fs.realpathSync(startDir);
	for (;;) {
		if (fs.existsSync(path.join(dir, "package.json"))) {
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
				if (pkg.pi?.extensions) return dir;
			} catch {
				// Not our package.json, keep walking
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
};

const seedDir = (sourceDir: string, targetDir: string): void => {
	if (!fs.existsSync(sourceDir)) return;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(sourceDir, { withFileTypes: true });
	} catch {
		return;
	}

	const mdFiles = entries.filter((e) => e.name.endsWith(".md") && (e.isFile() || e.isSymbolicLink()));
	if (mdFiles.length === 0) return;

	fs.mkdirSync(targetDir, { recursive: true });

	for (const entry of mdFiles) {
		const targetPath = path.join(targetDir, entry.name);
		if (fs.existsSync(targetPath)) continue;
		try {
			fs.copyFileSync(path.join(sourceDir, entry.name), targetPath);
		} catch {
			// Best-effort — don't fail extension load if a copy fails.
		}
	}
};

// ============================================================================
// /relay command
// ============================================================================

const formatRelayOverview = (actors: readonly ActorConfig[], templates: readonly PlanTemplate[]): string => {
	const lines: string[] = [];

	lines.push("## Actors");
	lines.push("");
	if (actors.length === 0) {
		lines.push("*None installed.* Add `.md` files to `~/.pi/agent/relay/actors/`");
	} else {
		for (const a of actors) {
			const tools = a.tools ? a.tools.join(", ") : "default tool set";
			const model = a.model ? `, model: \`${a.model}\`` : "";
			const thinking = a.thinking ? `, thinking: ${a.thinking}` : "";
			lines.push(`**${a.name}** — ${a.description}`);
			lines.push(`  tools: ${tools}${model}${thinking}`);
			lines.push("");
		}
	}

	lines.push("## Plan Templates");
	lines.push("");
	if (templates.length === 0) {
		lines.push("*None installed.* Add `.md` files to `~/.pi/agent/relay/plans/`");
	} else {
		for (const t of templates) {
			const sig =
				t.parameters.length > 0 ? t.parameters.map((p) => (p.required ? p.name : `${p.name}?`)).join(", ") : "";
			lines.push(`**${t.name}**(${sig}) — ${t.description}`);
			for (const p of t.parameters) {
				const req = p.required ? "" : ", optional";
				lines.push(`- \`${p.name}\`: ${p.description}${req}`);
			}
			lines.push("");
		}
	}

	return lines.join("\n");
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
		const thinkingSuffix = actor.thinking ? ` [thinking: ${actor.thinking}]` : "";
		return `  - ${actor.name}: ${actor.description}${toolsSuffix}${modelSuffix}${thinkingSuffix}`;
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
		"Multiple steps can write the same artifact — the latest commit wins. For loops where each iteration",
		"should see the full history of prior writes, set 'accumulate: true' on the artifact contract.",
		"A review loop looks like: create writes notes → review reads notes writes verdict → fix reads verdict",
		"writes notes → (back-edge) review → accepted terminates.",
	].join("\n");
};
