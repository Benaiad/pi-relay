import { describe, expect, it } from "vitest";
import type { ActorConfig } from "../src/actors/types.js";
import { buildToolDescription } from "../src/index.js";

const worker: ActorConfig = {
	name: "worker",
	description: "General-purpose implementer with read/edit/write",
	tools: ["read", "edit", "write", "bash"],
	source: "user",
	systemPrompt: "…",
	filePath: "/home/me/.pi/agent/relay-actors/worker.md",
};

const planner: ActorConfig = {
	name: "planner",
	description: "Read-only planner producing structured plans",
	tools: ["read", "grep", "find", "ls"],
	model: "claude-sonnet-4-6",
	source: "user",
	systemPrompt: "…",
	filePath: "/home/me/.pi/agent/relay-actors/planner.md",
};

const unscopedActor: ActorConfig = {
	name: "scout",
	description: "Fast recon agent",
	source: "user",
	systemPrompt: "…",
	filePath: "/home/me/.pi/agent/relay-actors/scout.md",
};

describe("buildToolDescription", () => {
	it("includes the static when-to-use prose", () => {
		const text = buildToolDescription([worker]);
		expect(text).toContain("verification gates");
		expect(text).toContain("Do NOT use this for single-tool edits");
	});

	it("lists each actor with description and tool restrictions", () => {
		const text = buildToolDescription([worker, planner]);
		expect(text).toContain("- worker: General-purpose implementer with read/edit/write");
		expect(text).toContain("[allowed tools: read, edit, write, bash]");
		expect(text).toContain("- planner: Read-only planner producing structured plans");
		expect(text).toContain("[allowed tools: read, grep, find, ls]");
	});

	it("annotates actors with model overrides", () => {
		const text = buildToolDescription([planner]);
		expect(text).toContain("[model: claude-sonnet-4-6]");
	});

	it("uses a default-tool-set marker when an actor declares no tools", () => {
		const text = buildToolDescription([unscopedActor]);
		expect(text).toContain("[default tool set]");
	});

	it("reminds the model that per-step instructions are task-specific", () => {
		const text = buildToolDescription([worker]);
		expect(text).toContain("task-specific prompt for that step");
		expect(text).toContain("SAME actor to do DIFFERENT work");
	});

	it("emits a not-installed message with zero actors", () => {
		const text = buildToolDescription([]);
		expect(text).toContain("NO ACTORS ARE CURRENTLY INSTALLED");
		expect(text).toContain("~/.pi/agent/relay-actors/");
		expect(text).toContain("/reload");
	});
});
