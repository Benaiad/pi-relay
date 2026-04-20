/**
 * Actor discovery from disk.
 *
 * Scans up to three directories for markdown files with YAML frontmatter,
 * merged in ascending priority:
 *
 *   1. `<package-root>/actors/`           (bundled — ships with the extension, read-only)
 *   2. `~/.pi/agent/pi-relay/actors/`     (user scope — user overrides and custom actors)
 *   3. `<cwd>/.pi/pi-relay/actors/`       (project scope — repo-controlled actors)
 *
 * Higher-priority sources shadow lower-priority sources by name.
 *
 * Project scope is opt-in because project-local actors are repo-controlled
 * and may instruct the model to read files, run commands, etc. The `relay`
 * tool confirms with the user before running a plan whose actors are
 * project-local, matching subagent's behavior.
 *
 * Discovery is fresh on every invocation. Editing an actor `.md` file is
 * picked up on the next call without restarting pi.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { ActorRegistry } from "../plan/compile.js";
import { ActorId, unwrap } from "../plan/ids.js";
import type { ActorConfig, ActorDiscovery, ActorScope, ActorSource, ThinkingLevel } from "./types.js";

const RELAY_SUBDIR = "pi-relay/actors";

export interface DiscoveryOptions {
	/** Override the user-scope directory (used by tests). */
	readonly userDir?: string;
	/** Package-root actors directory. When set, bundled actors are included at lowest priority. */
	readonly bundledDir?: string;
}

export const discoverActors = (cwd: string, scope: ActorScope, options: DiscoveryOptions = {}): ActorDiscovery => {
	const userDir = options.userDir ?? join(getAgentDir(), RELAY_SUBDIR);
	const projectDir = findProjectDir(cwd);

	const wantsUser = scope === "user" || scope === "both";
	const wantsProject = (scope === "project" || scope === "both") && projectDir !== null;

	const bundledActors = options.bundledDir ? loadActorsFromDir(options.bundledDir, "bundled") : [];
	const userActors = wantsUser ? loadActorsFromDir(userDir, "user") : [];
	const projectActors = wantsProject && projectDir ? loadActorsFromDir(projectDir, "project") : [];

	// Merge in ascending priority: bundled < user < project.
	const merged = new Map<string, ActorConfig>();
	for (const actor of bundledActors) merged.set(actor.name, actor);
	for (const actor of userActors) merged.set(actor.name, actor);
	for (const actor of projectActors) merged.set(actor.name, actor);

	return {
		actors: Array.from(merged.values()),
		projectDir,
		userDir,
	};
};

/**
 * Adapt an `ActorDiscovery` into the `ActorRegistry` shape the compiler wants.
 */
export const actorRegistryFromDiscovery = (discovery: ActorDiscovery): ActorRegistry => {
	const nameSet = new Set(discovery.actors.map((a) => a.name));
	const names = discovery.actors.map((a) => ActorId(a.name));
	return {
		has: (id) => nameSet.has(unwrap(id)),
		names: () => names,
	};
};

/** Pretty-print the discovered actor set for error messages and system prompts. */
export const formatActorList = (actors: readonly ActorConfig[]): string => {
	if (actors.length === 0) return "(none)";
	return actors.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; ");
};

// ============================================================================
// Internal helpers
// ============================================================================

const findProjectDir = (cwd: string): string | null => {
	let current = cwd;
	for (;;) {
		const candidate = join(current, ".pi", RELAY_SUBDIR);
		if (isDirectory(candidate)) return candidate;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
};

const isDirectory = (p: string): boolean => {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
};

const loadActorsFromDir = (dir: string, source: ActorSource): ActorConfig[] => {
	if (!existsSync(dir)) return [];

	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const actors: ActorConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;

		const filePath = join(dir, entry.name);

		// Resolve symlinks to check the actual target type
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				isFile = statSync(filePath).isFile();
			} catch {
				// Broken symlink — skip
				continue;
			}
		}
		if (!isFile) continue;

		const parsed = parseActorFile(filePath, source);
		if (parsed !== null) actors.push(parsed);
	}
	return actors;
};

const parseActorFile = (filePath: string, source: ActorSource): ActorConfig | null => {
	let content: string;
	try {
		content = readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
		return null;
	}

	const tools = typeof frontmatter.tools === "string" ? splitCommaList(frontmatter.tools) : undefined;
	const model = typeof frontmatter.model === "string" ? frontmatter.model : undefined;
	const thinking = parseThinkingLevel(frontmatter.thinking);

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model,
		thinking,
		systemPrompt: body,
		source,
		filePath,
	};
};

const VALID_THINKING_LEVELS = new Set<string>(["off", "minimal", "low", "medium", "high", "xhigh"]);

const parseThinkingLevel = (value: unknown): ThinkingLevel | undefined => {
	if (typeof value !== "string") return undefined;
	return VALID_THINKING_LEVELS.has(value) ? (value as ThinkingLevel) : undefined;
};

const splitCommaList = (raw: string): readonly string[] =>
	raw
		.split(",")
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
