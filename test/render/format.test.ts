import { describe, expect, it } from "vitest";
import {
	formatCost,
	formatDuration,
	formatTokens,
	joinNonEmpty,
	pluralize,
	truncate,
} from "../../src/render/format.js";
import { iconFor, runIcon } from "../../src/render/icons.js";
import { formatUsageStats } from "../../src/render/usage.js";

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
			{ input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
			"claude-sonnet-4-6",
		);
		expect(text).toContain("claude-sonnet-4-6");
	});

	it("returns an empty string for zero usage", () => {
		expect(
			formatUsageStats({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 }),
		).toBe("");
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
