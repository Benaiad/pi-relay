import { describe, expect, it } from "vitest";
import { buildCompletionInstruction, parseCompletion } from "../../src/actors/complete-step.js";
import { ArtifactId, RouteId } from "../../src/plan/ids.js";
import { isErr, isOk } from "../../src/plan/result.js";
import type { ArtifactContract } from "../../src/plan/types.js";

const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
	[
		ArtifactId("spec"),
		{ id: ArtifactId("spec"), description: "Parsed requirements", shape: { kind: "untyped_json" } },
	],
	[
		ArtifactId("notes"),
		{ id: ArtifactId("notes"), description: "Implementer notes", shape: { kind: "untyped_json" } },
	],
]);

describe("buildCompletionInstruction", () => {
	it("lists every allowed route and writable artifact with description", () => {
		const text = buildCompletionInstruction({
			routes: [RouteId("success"), RouteId("failure")],
			writableArtifactIds: [ArtifactId("spec"), ArtifactId("notes")],
			artifactContracts: contracts,
		});
		expect(text).toContain("<relay-complete>");
		expect(text).toContain("</relay-complete>");
		expect(text).toContain("- success");
		expect(text).toContain("- failure");
		expect(text).toContain("- spec: Parsed requirements");
		expect(text).toContain("- notes: Implementer notes");
	});

	it("renders a placeholder for the empty writable-artifacts case", () => {
		const text = buildCompletionInstruction({
			routes: [RouteId("done")],
			writableArtifactIds: [],
			artifactContracts: new Map(),
		});
		expect(text).toContain("(none — emit an empty object");
	});
});

describe("parseCompletion", () => {
	it("parses a well-formed completion block", () => {
		const text = `Some preamble...
<relay-complete>{"route":"success","writes":{"spec":{"ok":true}}}</relay-complete>`;
		const result = parseCompletion(text);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(result.value.route).toBe("success");
		expect(result.value.writes).toEqual({ spec: { ok: true } });
	});

	it("parses a block with empty writes", () => {
		const text = `<relay-complete>{"route":"done","writes":{}}</relay-complete>`;
		const result = parseCompletion(text);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(result.value.writes).toEqual({});
	});

	it("parses a block with a null writes field", () => {
		const text = `<relay-complete>{"route":"done","writes":null}</relay-complete>`;
		const result = parseCompletion(text);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(result.value.writes).toEqual({});
	});

	it("fails when the completion block is missing", () => {
		const result = parseCompletion("I finished but forgot the tag.");
		expect(isErr(result)).toBe(true);
	});

	it("fails when the JSON is invalid", () => {
		const result = parseCompletion(`<relay-complete>not json</relay-complete>`);
		expect(isErr(result)).toBe(true);
	});

	it("fails when the payload is an array", () => {
		const result = parseCompletion(`<relay-complete>[1,2,3]</relay-complete>`);
		expect(isErr(result)).toBe(true);
	});

	it("fails when the route field is missing or empty", () => {
		const r1 = parseCompletion(`<relay-complete>{"writes":{}}</relay-complete>`);
		const r2 = parseCompletion(`<relay-complete>{"route":"","writes":{}}</relay-complete>`);
		expect(isErr(r1)).toBe(true);
		expect(isErr(r2)).toBe(true);
	});

	it("fails when writes is not an object", () => {
		const result = parseCompletion(`<relay-complete>{"route":"done","writes":[]}</relay-complete>`);
		expect(isErr(result)).toBe(true);
	});

	it("takes the first completion block if multiple are present", () => {
		const text = `<relay-complete>{"route":"first","writes":{}}</relay-complete> junk <relay-complete>{"route":"second","writes":{}}</relay-complete>`;
		const result = parseCompletion(text);
		expect(isOk(result)).toBe(true);
		if (!isOk(result)) return;
		expect(result.value.route).toBe("first");
	});
});
