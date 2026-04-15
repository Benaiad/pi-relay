/**
 * Actor discovery from disk.
 *
 * Scans two directories for markdown files with YAML frontmatter:
 *
 *   - `~/.pi/agent/relay-actors/`  (user scope — always scanned unless scope="project")
 *   - `<cwd>/.pi/relay-actors/`    (project scope — scanned only when scope="project" or "both")
 *
 * Project scope is opt-in because project-local actors are repo-controlled
 * and may instruct the model to read files, run commands, etc. The `relay`
 * tool confirms with the user before running a plan whose actors are
 * project-local, matching subagent's behavior.
 *
 * Discovery is fresh on every invocation. Editing an actor `.md` file is
 * picked up on the next call without restarting pi. This mirrors subagent's
 * `agents.ts` convention.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { ActorRegistry } from "../plan/compile.js";
import { ActorId, unwrap } from "../plan/ids.js";
import type { ActorConfig, ActorDiscovery, ActorScope, ActorSource } from "./types.js";

const ACTORS_SUBDIR = "relay-actors";

export interface DiscoveryOptions {
	/** Override the user-scope directory (used by tests). Defaults to `<getAgentDir()>/relay-actors`. */
	readonly userDir?: string;
}

export const discoverActors = (cwd: string, scope: ActorScope, options: DiscoveryOptions = {}): ActorDiscovery => {
	const userDir = options.userDir ?? path.join(getAgentDir(), ACTORS_SUBDIR);
	const projectDir = findNearestProjectActorsDir(cwd);

	const wantsUser = scope === "user" || scope === "both";
	const wantsProject = (scope === "project" || scope === "both") && projectDir !== null;

	const userActors = wantsUser ? loadActorsFromDir(userDir, "user") : [];
	const projectActors = wantsProject && projectDir ? loadActorsFromDir(projectDir, "project") : [];

	// Project actors override user actors of the same name in "both" mode.
	const merged = new Map<string, ActorConfig>();
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
 *
 * Stays a thin wrapper — the compiler only needs `has` and `names`.
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

const findNearestProjectActorsDir = (cwd: string): string | null => {
	let current = cwd;
	for (;;) {
		const candidate = path.join(current, ".pi", ACTORS_SUBDIR);
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

const loadActorsFromDir = (dir: string, source: ActorSource): ActorConfig[] => {
	if (!fs.existsSync(dir)) return [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const actors: ActorConfig[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		const parsed = parseActorFile(filePath, source);
		if (parsed !== null) actors.push(parsed);
	}
	return actors;
};

const parseActorFile = (filePath: string, source: ActorSource): ActorConfig | null => {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}

	const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
	if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
		return null;
	}

	const tools = typeof frontmatter.tools === "string" ? splitCommaList(frontmatter.tools) : undefined;
	const model = typeof frontmatter.model === "string" ? frontmatter.model : undefined;

	return {
		name: frontmatter.name,
		description: frontmatter.description,
		tools: tools && tools.length > 0 ? tools : undefined,
		model,
		systemPrompt: body,
		source,
		filePath,
	};
};

const splitCommaList = (raw: string): readonly string[] =>
	raw
		.split(",")
		.map((x) => x.trim())
		.filter((x) => x.length > 0);
