import { describe, expect, it } from "vitest";
import { parseCliArgs } from "../../src/cli/args.js";

describe("parseCliArgs", () => {
	it("parses template path as first positional arg", () => {
		const result = parseCliArgs(["plans/test.md"]);
		expect(result.templatePath).toBe("plans/test.md");
		expect(result.diagnostics).toHaveLength(0);
	});

	it("parses -e key=value params", () => {
		const result = parseCliArgs(["t.md", "-e", "task=Fix the bug", "-e", "verify=npm test"]);
		expect(result.params).toEqual({ task: "Fix the bug", verify: "npm test" });
	});

	it("parses -e @file.json as paramsFile", () => {
		const result = parseCliArgs(["t.md", "-e", "@ci/params.json"]);
		expect(result.paramsFile).toBe("ci/params.json");
	});

	it("parses --model flag", () => {
		const result = parseCliArgs(["t.md", "--model", "anthropic/claude-sonnet-4-5"]);
		expect(result.model).toBe("anthropic/claude-sonnet-4-5");
	});

	it("parses --thinking flag", () => {
		const result = parseCliArgs(["t.md", "--thinking", "high"]);
		expect(result.thinking).toBe("high");
	});

	it("rejects invalid thinking level", () => {
		const result = parseCliArgs(["t.md", "--thinking", "ultra"]);
		expect(result.thinking).toBeUndefined();
		expect(result.diagnostics.some((d) => d.type === "error" && d.message.includes("ultra"))).toBe(true);
	});

	it("parses --actors-dir flag", () => {
		const result = parseCliArgs(["t.md", "--actors-dir", "./actors"]);
		expect(result.actorsDir).toBe("./actors");
	});

	it("parses --dry-run flag", () => {
		const result = parseCliArgs(["t.md", "--dry-run"]);
		expect(result.dryRun).toBe(true);
	});

	it("parses --help flag", () => {
		const result = parseCliArgs(["--help"]);
		expect(result.help).toBe(true);
		expect(result.diagnostics).toHaveLength(0);
	});

	it("errors on missing template path", () => {
		const result = parseCliArgs(["-e", "task=x"]);
		expect(result.diagnostics.some((d) => d.type === "error" && d.message.includes("Missing template"))).toBe(true);
	});

	it("errors on unknown flags", () => {
		const result = parseCliArgs(["t.md", "--foo"]);
		expect(result.diagnostics.some((d) => d.type === "error" && d.message.includes("--foo"))).toBe(true);
	});

	it("errors on invalid -e format", () => {
		const result = parseCliArgs(["t.md", "-e", "noequals"]);
		expect(result.diagnostics.some((d) => d.type === "error" && d.message.includes("key=value"))).toBe(true);
	});

	it("errors on unexpected positional args", () => {
		const result = parseCliArgs(["t.md", "extra"]);
		expect(result.diagnostics.some((d) => d.type === "error" && d.message.includes("extra"))).toBe(true);
	});

	it("handles -e with empty value", () => {
		const result = parseCliArgs(["t.md", "-e", "key="]);
		expect(result.params).toEqual({ key: "" });
	});

	it("handles -e with value containing equals", () => {
		const result = parseCliArgs(["t.md", "-e", "cmd=a=b"]);
		expect(result.params).toEqual({ cmd: "a=b" });
	});

	it("combines multiple flags", () => {
		const result = parseCliArgs([
			"plans/test.md",
			"-e",
			"task=Fix it",
			"-e",
			"verify=npm test",
			"--model",
			"anthropic/claude-sonnet-4-5",
			"--thinking",
			"medium",
			"--dry-run",
		]);
		expect(result.templatePath).toBe("plans/test.md");
		expect(result.params).toEqual({ task: "Fix it", verify: "npm test" });
		expect(result.model).toBe("anthropic/claude-sonnet-4-5");
		expect(result.thinking).toBe("medium");
		expect(result.dryRun).toBe(true);
		expect(result.diagnostics).toHaveLength(0);
	});
});
