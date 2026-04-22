import { describe, expect, it, vi } from "vitest";
import factory from "../src/pi-relay.js";
import { buildReplayToolDescription } from "../src/replay.js";
import type { PlanTemplate } from "../src/templates/types.js";

const template = (name: string, params: PlanTemplate["parameters"] = []): PlanTemplate => ({
	name,
	description: `${name} template.`,
	parameters: params,
	rawPlan: { task: "test", entryStep: "a", artifacts: [], steps: [] },
	source: "user",
	filePath: `/tmp/${name}.md`,
});

describe("buildReplayToolDescription", () => {
	it("lists templates with parameter signatures", () => {
		const desc = buildReplayToolDescription([
			template("refactor", [
				{ name: "module", description: "Module path.", required: true },
				{ name: "symbol", description: "Symbol name.", required: true },
				{ name: "note", description: "Optional note.", required: false },
			]),
		]);
		expect(desc).toContain("refactor(module, symbol, note?)");
		expect(desc).toContain("refactor template.");
		expect(desc).toContain("module (required): Module path.");
		expect(desc).toContain("note (optional): Optional note.");
	});

	it("shows empty parens for parameterless templates", () => {
		const desc = buildReplayToolDescription([template("lint-all")]);
		expect(desc).toContain("lint-all()");
	});

	it("shows a not-installed message when no templates exist", () => {
		const desc = buildReplayToolDescription([]);
		expect(desc).toContain("NO PLANS ARE CURRENTLY INSTALLED");
		expect(desc).toContain("~/.pi/agent/pi-relay/plans/");
	});

	it("lists multiple templates", () => {
		const desc = buildReplayToolDescription([
			template("refactor", [{ name: "module", description: "m", required: true }]),
			template("deploy", [{ name: "env", description: "e", required: true }]),
		]);
		expect(desc).toContain("refactor(module)");
		expect(desc).toContain("deploy(env)");
	});
});

describe("replay tool registration", () => {
	it("registers a tool named 'replay'", () => {
		const registered: Array<{ name: string }> = [];
		const stubApi = {
			registerTool(tool: { name: string }) {
				registered.push({ name: tool.name });
			},
			on: vi.fn(),
			registerCommand: vi.fn(),
			registerShortcut: vi.fn(),
			registerFlag: vi.fn(),
			registerMessageRenderer: vi.fn(),
			sendMessage: vi.fn(),
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
			setSessionName: vi.fn(),
			getSessionName: vi.fn(),
			setLabel: vi.fn(),
			exec: vi.fn(),
			getActiveTools: vi.fn(),
			getAllTools: vi.fn(),
			setActiveTools: vi.fn(),
			getCommands: vi.fn(),
			setModel: vi.fn(),
			getThinkingLevel: vi.fn(),
			setThinkingLevel: vi.fn(),
			registerProvider: vi.fn(),
			unregisterProvider: vi.fn(),
			getFlag: vi.fn(),
			events: {} as never,
		};
		factory(stubApi as never);
		expect(registered.some((r) => r.name === "replay")).toBe(true);
	});
});
