/**
 * Template discovery from disk.
 *
 * Scans two directories for markdown files with YAML frontmatter:
 *
 *   - `~/.pi/agent/relay/plans/`  (user scope)
 *   - `<cwd>/.pi/relay/plans/`    (project scope)
 *
 * The body of each file is parsed as YAML into a plain JS object that
 * becomes the template's `rawPlan`. The raw plan is NOT validated against
 * `PlanDraftSchema` at discovery time — it contains `{{...}}` placeholders
 * that would fail schema validation. Validation happens after substitution,
 * in `instantiateTemplate`.
 *
 * Discovery is fresh on every invocation. Editing a template `.md` file is
 * picked up on the next call without restarting pi.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import type { ActorScope } from "../actors/types.js";
import type { PlanTemplate, TemplateDiscovery, TemplateParameter, TemplateSource, TemplateWarning } from "./types.js";

const PLANS_SUBDIR = "relay/plans";

export interface TemplateDiscoveryOptions {
	readonly userDir?: string;
	readonly actorNames?: ReadonlySet<string>;
}

export const discoverPlanTemplates = (
	cwd: string,
	scope: ActorScope,
	options: TemplateDiscoveryOptions = {},
): TemplateDiscovery => {
	const userDir = options.userDir ?? path.join(getAgentDir(), PLANS_SUBDIR);
	const projectDir = findNearestProjectPlansDir(cwd);
	const warnings: TemplateWarning[] = [];

	const wantsUser = scope === "user" || scope === "both";
	const wantsProject = (scope === "project" || scope === "both") && projectDir !== null;

	const userTemplates = wantsUser ? loadTemplatesFromDir(userDir, "user", warnings) : [];
	const projectTemplates = wantsProject && projectDir ? loadTemplatesFromDir(projectDir, "project", warnings) : [];

	const merged = new Map<string, PlanTemplate>();
	for (const t of userTemplates) merged.set(t.name, t);
	for (const t of projectTemplates) merged.set(t.name, t);

	if (options.actorNames) {
		for (const template of merged.values()) {
			crossValidateActors(template, options.actorNames, warnings);
		}
	}

	return {
		templates: Array.from(merged.values()),
		userDir,
		projectDir,
		warnings,
	};
};

// ============================================================================
// Internal helpers
// ============================================================================

const findNearestProjectPlansDir = (cwd: string): string | null => {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, ".pi", PLANS_SUBDIR);
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
};

const isDirectory = (p: string): boolean => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};

const loadTemplatesFromDir = (
	dir: string,
	source: TemplateSource,
	warnings: TemplateWarning[],
): PlanTemplate[] => {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const templates: PlanTemplate[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		const parsed = parseTemplateFile(filePath, source, warnings);
		if (parsed !== null) templates.push(parsed);
	}
	return templates;
};

interface TemplateFrontmatter {
	name?: string;
	description?: string;
	parameters?: unknown;
}

const parseTemplateFile = (
	filePath: string,
	source: TemplateSource,
	warnings: TemplateWarning[],
): PlanTemplate | null => {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter<TemplateFrontmatter>(content);

	const name = frontmatter.name;
	if (typeof name !== "string" || name.trim().length === 0) {
		warnings.push({ templateName: "(unknown)", message: "Missing or empty 'name' in frontmatter", filePath });
		return null;
	}

	const description = frontmatter.description;
	if (typeof description !== "string" || description.trim().length === 0) {
		warnings.push({ templateName: name, message: "Missing or empty 'description' in frontmatter", filePath });
		return null;
	}

	const parameters = parseParameters(frontmatter.parameters, name, filePath, warnings);
	if (parameters === null) return null;

	let rawPlan: Record<string, unknown>;
	try {
		const parsed = parseYaml(body, { version: "1.2" });
		if (parsed === null || parsed === undefined || typeof parsed !== "object" || Array.isArray(parsed)) {
			warnings.push({ templateName: name, message: "YAML body must be an object", filePath });
			return null;
		}
		rawPlan = parsed as Record<string, unknown>;
	} catch (e) {
		const msg = e instanceof Error ? e.message : "unknown parse error";
		warnings.push({ templateName: name, message: `YAML parse error: ${msg}`, filePath });
		return null;
	}

	return { name, description, parameters, rawPlan, source, filePath };
};

const parseParameters = (
	raw: unknown,
	templateName: string,
	filePath: string,
	warnings: TemplateWarning[],
): readonly TemplateParameter[] | null => {
	if (raw === undefined || raw === null) return [];

	if (!Array.isArray(raw)) {
		warnings.push({ templateName, message: "'parameters' must be an array", filePath });
		return null;
	}

	const params: TemplateParameter[] = [];
	const seen = new Set<string>();

	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) {
			warnings.push({ templateName, message: "Each parameter must be an object with 'name' and 'description'", filePath });
			return null;
		}
		const e = entry as Record<string, unknown>;
		if (typeof e.name !== "string" || e.name.trim().length === 0) {
			warnings.push({ templateName, message: "Parameter missing 'name'", filePath });
			return null;
		}
		if (typeof e.description !== "string" || e.description.trim().length === 0) {
			warnings.push({ templateName, message: `Parameter "${e.name}" missing 'description'`, filePath });
			return null;
		}
		if (seen.has(e.name)) {
			warnings.push({ templateName, message: `Duplicate parameter name "${e.name}"`, filePath });
			return null;
		}
		seen.add(e.name);
		params.push({
			name: e.name,
			description: e.description,
			required: e.required !== false,
		});
	}

	return params;
};

const crossValidateActors = (
	template: PlanTemplate,
	actorNames: ReadonlySet<string>,
	warnings: TemplateWarning[],
): void => {
	const steps = template.rawPlan.steps;
	if (!Array.isArray(steps)) return;

	for (const step of steps) {
		if (typeof step !== "object" || step === null) continue;
		const s = step as Record<string, unknown>;
		if (typeof s.actor !== "string") continue;
		if (s.actor.includes("{{")) continue;
		if (!actorNames.has(s.actor)) {
			warnings.push({
				templateName: template.name,
				message: `References unknown actor "${s.actor}"`,
				filePath: template.filePath,
			});
		}
	}
};
