#!/usr/bin/env node

/**
 * Relay CLI — run a relay plan template headlessly.
 *
 * Designed for CI. Point at a template file, pass parameters with `-e`,
 * get a markdown report on stdout, exit with 0 (success) or non-zero.
 *
 * Exit codes:
 *   0 — plan reached a success terminal
 *   1 — plan reached a failure terminal, incomplete, or aborted
 *   2 — bad args, missing params, file not found
 *   3 — compile error, missing actor, no model
 *   4 — runtime error
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import {
	AuthStorage,
	createAgentSessionServices,
	getAgentDir,
	type ModelRegistry,
} from "@mariozechner/pi-coding-agent";
import { actorRegistryFromDiscovery, discoverActors, loadActorsFromDir } from "../actors/discovery.js";
import type { ActorDiscovery } from "../actors/types.js";
import { findModel, validateActors } from "../actors/validate.js";
import { runPlan } from "../core/run-plan.js";
import { compile } from "../plan/compile.js";
import { formatCompileError } from "../plan/compile-error-format.js";
import { ActorId, edgeKey, RouteId, unwrap } from "../plan/ids.js";
import type { Program } from "../plan/program.js";
import { renderRunReportText } from "../runtime/run-report.js";
import { parseTemplateFile } from "../templates/discovery.js";
import { formatTemplateError } from "../templates/errors.js";
import { instantiateTemplate } from "../templates/substitute.js";
import type { TemplateWarning } from "../templates/types.js";
import { findPackageRoot } from "../utils/package-root.js";
import { type CliArgs, parseCliArgs, printHelp } from "./args.js";

async function main(args: string[]): Promise<void> {
	const parsed = parseCliArgs(args);

	if (parsed.help) {
		printHelp();
		return;
	}

	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			console.error(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`);
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exitCode = 2;
			return;
		}
	}

	const templatePath = resolve(parsed.templatePath);
	const warnings: TemplateWarning[] = [];
	const template = parseTemplateFile(templatePath, "project", warnings);
	if (!template) {
		console.error(`Failed to load template: ${parsed.templatePath}`);
		for (const w of warnings) {
			console.error(`  ${w.message}`);
		}
		process.exitCode = 2;
		return;
	}

	const params = mergeParams(parsed);
	if (!params.ok) {
		console.error(params.error);
		process.exitCode = 2;
		return;
	}

	const instantiation = instantiateTemplate(template, params.value);
	if (!instantiation.ok) {
		console.error(formatTemplateError(instantiation.error));
		process.exitCode =
			instantiation.error.kind === "invalid_plan" || instantiation.error.kind === "unresolved_placeholder" ? 3 : 2;
		return;
	}

	const plan = instantiation.value.plan;
	const cwd = plan.cwd ? resolve(process.cwd(), plan.cwd) : process.cwd();

	if (!isDirectory(cwd)) {
		console.error(`Working directory does not exist or is not a directory: ${cwd}`);
		process.exitCode = 2;
		return;
	}

	const actorDiscovery = discoverActorsForCli(cwd, parsed.actorsDir);
	const registry = actorRegistryFromDiscovery(actorDiscovery);

	const compileResult = compile(plan, registry);
	if (!compileResult.ok) {
		const actorList =
			actorDiscovery.actors.length === 0 ? "(none)" : actorDiscovery.actors.map((a) => a.name).join(", ");
		console.error(`Compile error: ${formatCompileError(compileResult.error)}`);
		console.error(`Available actors: ${actorList}`);
		process.exitCode = 3;
		return;
	}

	if (parsed.dryRun) {
		printPlanSummary(compileResult.value, actorDiscovery, cwd, parsed.templatePath);
		return;
	}

	const services = await createAgentSessionServices({
		cwd,
		agentDir: getAgentDir(),
		authStorage: AuthStorage.create(),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	const { modelRegistry, settingsManager } = services;

	const defaultModel = resolveDefaultModel(parsed.model, modelRegistry);
	if (parsed.model && !defaultModel) {
		console.error(`Model "${parsed.model}" not found in registry.`);
		process.exitCode = 3;
		return;
	}

	const defaultThinking: ThinkingLevel = parsed.thinking ?? "off";
	const validatedActors = validateActors(actorDiscovery.actors, modelRegistry, defaultModel, defaultThinking, (msg) =>
		console.error(`Warning: ${msg}`),
	);

	const unresolvedActors = validatedActors.filter((a) => !a.resolvedModel);
	if (unresolvedActors.length > 0) {
		for (const actor of unresolvedActors) {
			console.error(
				`Actor "${actor.name}" has no model configured. Use --model <provider/name> or add model: to the actor file.`,
			);
		}
		process.exitCode = 3;
		return;
	}

	const actorsByName = new Map(validatedActors.map((a) => [ActorId(a.name), a]));

	const result = await runPlan({
		program: compileResult.value,
		actorsByName,
		modelRegistry,
		cwd,
		shellPath: settingsManager.getShellPath(),
		shellCommandPrefix: settingsManager.getShellCommandPrefix(),
	});

	process.stdout.write(renderRunReportText(result.report, result.artifactStore));
	process.stdout.write("\n");

	process.exitCode = result.report.outcome === "success" ? 0 : 1;
}

// ============================================================================
// Helpers
// ============================================================================

const mergeParams = (parsed: CliArgs): { ok: true; value: Record<string, string> } | { ok: false; error: string } => {
	const fileParams: Record<string, string> = {};
	if (parsed.paramsFile) {
		try {
			const raw = readFileSync(resolve(parsed.paramsFile), "utf-8");
			const parsed_ = JSON.parse(raw);
			if (typeof parsed_ !== "object" || parsed_ === null || Array.isArray(parsed_)) {
				return { ok: false, error: `Params file must be a JSON object: ${parsed.paramsFile}` };
			}
			for (const [k, v] of Object.entries(parsed_)) {
				if (typeof v !== "string") {
					return { ok: false, error: `Params file value for "${k}" must be a string` };
				}
				fileParams[k] = v;
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			return { ok: false, error: `Failed to read params file: ${msg}` };
		}
	}
	return { ok: true, value: { ...fileParams, ...parsed.params } };
};

const resolveDefaultModel = (modelFlag: string | undefined, registry: ModelRegistry) => {
	if (!modelFlag) return undefined;
	return findModel(modelFlag, registry);
};

const discoverActorsForCli = (cwd: string, actorsDir: string | undefined): ActorDiscovery => {
	if (actorsDir) {
		const resolved = resolve(actorsDir);
		return { actors: loadActorsFromDir(resolved, "project"), projectDir: null, userDir: "" };
	}
	const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
	const bundledActorsDir = packageRoot ? resolve(packageRoot, "bundled", "actors") : undefined;
	return discoverActors(cwd, "both", { bundledDir: bundledActorsDir });
};

const isDirectory = (p: string): boolean => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

const printPlanSummary = (
	program: Program,
	actorDiscovery: ActorDiscovery,
	cwd: string,
	templatePath: string,
): void => {
	const lines: string[] = [];
	lines.push(`Template: ${templatePath}`);
	lines.push(`CWD: ${cwd}`);
	lines.push("");
	lines.push("Steps:");

	for (const stepId of program.stepOrder) {
		const step = program.steps.get(stepId);
		if (!step) continue;

		switch (step.type) {
			case "action": {
				lines.push(`  ${unwrap(stepId)} (action, actor: ${unwrap(step.actor)})`);
				for (const [route] of step.routes) {
					const target = program.edges.get(edgeKey(stepId, route));
					if (target) lines.push(`    → ${unwrap(route)} → ${unwrap(target)}`);
				}
				break;
			}
			case "command": {
				const cmd = step.command.length > 60 ? `${step.command.slice(0, 60)}…` : step.command;
				lines.push(`  ${unwrap(stepId)} (command: ${cmd})`);
				const successTarget = program.edges.get(edgeKey(stepId, RouteId("success")));
				const failureTarget = program.edges.get(edgeKey(stepId, RouteId("failure")));
				if (successTarget) lines.push(`    → success → ${unwrap(successTarget)}`);
				if (failureTarget) lines.push(`    → failure → ${unwrap(failureTarget)}`);
				break;
			}
			case "files_exist": {
				lines.push(`  ${unwrap(stepId)} (files_exist: ${step.paths.join(", ")})`);
				break;
			}
			case "terminal": {
				lines.push(`  ${unwrap(stepId)} (terminal: ${step.outcome})`);
				break;
			}
		}
	}

	if (program.artifacts.size > 0) {
		lines.push("");
		lines.push("Artifacts:");
		for (const [id, contract] of program.artifacts) {
			const writer = program.writers.get(id);
			lines.push(`  ${unwrap(id)} (${contract.shape.type}, writer: ${writer ? unwrap(writer) : "none"})`);
		}
	}

	const actorNames = new Set<string>();
	for (const stepId of program.stepOrder) {
		const step = program.steps.get(stepId);
		if (step?.type === "action") actorNames.add(unwrap(step.actor));
	}

	if (actorNames.size > 0) {
		lines.push("");
		lines.push("Actors:");
		for (const name of actorNames) {
			const actor = actorDiscovery.actors.find((a) => a.name === name);
			if (actor) {
				const tools = actor.tools ? actor.tools.join(", ") : "default";
				lines.push(`  ${name} ✓ (${actor.source}, tools: ${tools})`);
			} else {
				lines.push(`  ${name} ✗ (not found)`);
			}
		}
	}

	lines.push("");
	lines.push("Plan compiles. Ready to run.");
	process.stdout.write(`${lines.join("\n")}\n`);
};

main(process.argv.slice(2)).catch((error: unknown) => {
	const msg = error instanceof Error ? error.message : String(error);
	console.error(`Fatal: ${msg}`);
	process.exitCode = 4;
});
