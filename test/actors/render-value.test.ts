import { describe, expect, it } from "vitest";
import { renderValue } from "../../src/actors/render-value.js";

describe("renderValue", () => {
	it("renders null", () => {
		expect(renderValue(null)).toBe("null");
	});

	it("renders booleans", () => {
		expect(renderValue(true)).toBe("true");
		expect(renderValue(false)).toBe("false");
	});

	it("renders numbers", () => {
		expect(renderValue(42)).toBe("42");
		expect(renderValue(3.14)).toBe("3.14");
	});

	it("renders simple strings unquoted", () => {
		expect(renderValue("hello world")).toBe("hello world");
	});

	it("quotes strings with special characters", () => {
		expect(renderValue("key: value")).toBe('"key: value"');
		expect(renderValue("line\nnewline")).toBe('"line\\nnewline"');
	});

	it("renders strings that look like booleans or null unquoted", () => {
		expect(renderValue("true")).toBe("true");
		expect(renderValue("false")).toBe("false");
		expect(renderValue("null")).toBe("null");
	});

	it("renders strings that start with digits unquoted", () => {
		expect(renderValue("42abc")).toBe("42abc");
		expect(renderValue("42")).toBe("42");
	});

	it("quotes empty strings", () => {
		expect(renderValue("")).toBe('""');
	});

	it("renders flat objects as key-value pairs", () => {
		const result = renderValue({ name: "alice", age: 30 });
		expect(result).toBe("name: alice\nage: 30");
	});

	it("renders nested objects with indentation", () => {
		const result = renderValue({ user: { name: "alice", role: "admin" } });
		expect(result).toContain("user:");
		expect(result).toContain("  name: alice");
		expect(result).toContain("  role: admin");
	});

	it("renders arrays with dash prefix", () => {
		const result = renderValue(["a", "b", "c"]);
		expect(result).toBe("- a\n- b\n- c");
	});

	it("renders arrays of objects with inline first key", () => {
		const result = renderValue([
			{ id: 1, name: "first" },
			{ id: 2, name: "second" },
		]);
		expect(result).toContain("- id: 1");
		expect(result).toContain("  name: first");
		expect(result).toContain("- id: 2");
		expect(result).toContain("  name: second");
	});

	it("renders empty object as {}", () => {
		expect(renderValue({})).toBe("{}");
	});

	it("renders empty array as []", () => {
		expect(renderValue([])).toBe("[]");
	});

	it("falls back to JSON at depth limit", () => {
		const deep = { a: { b: { c: { d: { e: "too deep" } } } } };
		const result = renderValue(deep);
		expect(result).toContain('"e"');
	});
});
