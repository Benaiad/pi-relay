import { describe, expect, it } from "vitest";
import {
	formatCost,
	formatDuration,
	formatTokens,
	formatToolCall,
	joinNonEmpty,
	pluralize,
	truncate,
} from "../../src/render/format.js";
import { iconFor, runIcon } from "../../src/render/icons.js";
import { formatUsageStats } from "../../src/render/usage.js";

// Fake theme that returns just the text, ignoring colors, so we can string-match.
const bareTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
} as unknown as import("@mariozechner/pi-coding-agent").Theme;

describe("formatTokens", () => {
	it.each([
		[0, "0"],
		[42, "42"],
		[999, "999"],
		[1000, "1.0k"],
		[1234, "1.2k"],
		[9999, "10.0k"],
		[10_000, "10k"],
		[123_000, "123k"],
		[1_000_000, "1.0M"],
		[1_250_000, "1.3M"],
	])("formats %d as %s", (input, expected) => {
		expect(formatTokens(input)).toBe(expected);
	});
});

describe("formatCost", () => {
	it("formats a cost to four decimal places with a dollar sign", () => {
		expect(formatCost(0.0123)).toBe("$0.0123");
		expect(formatCost(0)).toBe("$0.0000");
		expect(formatCost(1.5)).toBe("$1.5000");
	});
});

describe("formatDuration", () => {
	it.each([
		[0, "0ms"],
		[500, "500ms"],
		[999, "999ms"],
		[1000, "1.0s"],
		[1500, "1.5s"],
		[60_000, "1m0s"],
		[61_500, "1m1s"],
	])("formats %d ms as %s", (input, expected) => {
		expect(formatDuration(input)).toBe(expected);
	});
});

describe("truncate", () => {
	it("leaves short strings alone", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("truncates long strings with an ellipsis", () => {
		expect(truncate("the quick brown fox", 10)).toBe("the quick …");
	});
});

describe("joinNonEmpty", () => {
	it("filters out empty and false entries", () => {
		expect(joinNonEmpty(["a", "", null, "b", false, undefined, "c"])).toBe("a · b · c");
	});

	it("respects a custom separator", () => {
		expect(joinNonEmpty(["x", "y"], ", ")).toBe("x, y");
	});
});

describe("pluralize", () => {
	it("uses the singular for one and adds 's' by default for other counts", () => {
		expect(pluralize(1, "step")).toBe("1 step");
		expect(pluralize(2, "step")).toBe("2 steps");
		expect(pluralize(0, "step")).toBe("0 steps");
	});

	it("uses an explicit plural form when provided", () => {
		expect(pluralize(2, "mouse", "mice")).toBe("2 mice");
	});
});

describe("formatUsageStats", () => {
	it("omits zero fields and formats the rest", () => {
		const text = formatUsageStats({
			input: 1234,
			output: 5678,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.0123,
			contextTokens: 5000,
			turns: 3,
		});
		expect(text).toContain("3 turns");
		expect(text).toContain("↑1.2k");
		expect(text).toContain("↓5.7k");
		expect(text).toContain("$0.0123");
		expect(text).toContain("ctx:5.0k");
		expect(text).not.toContain("R0");
		expect(text).not.toContain("W0");
	});

	it("appends the model name when provided", () => {
		const text = formatUsageStats(
			{
				input: 100,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 1,
			},
			"claude-sonnet-4-6",
		);
		expect(text).toContain("claude-sonnet-4-6");
	});

	it("returns an empty string for zero usage", () => {
		expect(
			formatUsageStats({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
				turns: 0,
			}),
		).toBe("");
	});
});

describe("formatToolCall", () => {
	it("formats bash as $ command", () => {
		expect(formatToolCall("bash", { command: "npm test" }, bareTheme)).toBe("$ npm test");
	});

	it("truncates long bash commands", () => {
		const long = "x".repeat(100);
		const out = formatToolCall("bash", { command: long }, bareTheme);
		expect(out.length).toBeLessThan(long.length);
		expect(out).toContain("…");
	});

	it("formats read with path and offset/limit", () => {
		expect(formatToolCall("read", { path: "/tmp/foo.ts", offset: 10, limit: 5 }, bareTheme)).toBe(
			"read /tmp/foo.ts:10-14",
		);
	});

	it("formats read with file_path alias", () => {
		expect(formatToolCall("read", { file_path: "/tmp/foo.ts" }, bareTheme)).toBe("read /tmp/foo.ts");
	});

	it("formats write with line count", () => {
		expect(formatToolCall("write", { path: "/tmp/a.md", content: "a\nb\nc" }, bareTheme)).toBe(
			"write /tmp/a.md (3 lines)",
		);
	});

	it("formats edit as edit path", () => {
		expect(formatToolCall("edit", { file_path: "/tmp/foo.ts" }, bareTheme)).toBe("edit /tmp/foo.ts");
	});

	it("formats grep as grep /pattern/ in path", () => {
		expect(formatToolCall("grep", { pattern: "foo", path: "src" }, bareTheme)).toBe("grep /foo/ in src");
	});

	it("formats find as find pattern in path", () => {
		expect(formatToolCall("find", { pattern: "*.ts", path: "src" }, bareTheme)).toBe("find *.ts in src");
	});

	it("formats ls with path", () => {
		expect(formatToolCall("ls", { path: "src" }, bareTheme)).toBe("ls src");
	});

	it("formats unknown tool with name and truncated JSON preview", () => {
		const out = formatToolCall("mystery", { a: 1, b: "two" }, bareTheme);
		expect(out).toContain("mystery");
		expect(out).toContain('{"a":1,"b":"two"}');
	});
});

describe("iconFor / runIcon", () => {
	it("returns distinct glyphs for each step status", () => {
		const glyphs = new Set([
			iconFor("pending").glyph,
			iconFor("running").glyph,
			iconFor("retrying").glyph,
			iconFor("succeeded").glyph,
			iconFor("failed").glyph,
		]);
		expect(glyphs.size).toBe(5);
	});

	it("returns a theme color for every run phase", () => {
		const phases = ["pending", "running", "succeeded", "failed", "aborted", "incomplete"] as const;
		for (const phase of phases) {
			expect(runIcon(phase).glyph.length).toBeGreaterThan(0);
			expect(runIcon(phase).color.length).toBeGreaterThan(0);
		}
	});
});
