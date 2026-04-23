import { describe, expect, it } from "vitest";
import { buildCompletionTool, type CompletionDetails } from "../../src/actors/completion-tool.js";
import { ArtifactId, RouteId } from "../../src/plan/ids.js";
import type { ArtifactContract } from "../../src/plan/types.js";

const textContract = (id: string, description: string): ArtifactContract => ({
	id: ArtifactId(id),
	description,
	shape: { kind: "text" },
});

const recordContract = (id: string, description: string, fields: string[]): ArtifactContract => ({
	id: ArtifactId(id),
	description,
	shape: { kind: "record", fields },
});

const recordListContract = (id: string, description: string, fields: string[]): ArtifactContract => ({
	id: ArtifactId(id),
	description,
	shape: { kind: "record_list", fields },
});

describe("buildCompletionTool", () => {
	it("produces a tool named turn_complete", () => {
		const tool = buildCompletionTool([RouteId("done")], [], new Map());
		expect(tool.name).toBe("turn_complete");
	});

	it("schema has route as a literal when one route exists", () => {
		const tool = buildCompletionTool([RouteId("done")], [], new Map());
		const schema = tool.parameters as { properties: Record<string, unknown> };
		const routeProp = schema.properties.route as { const?: string };
		expect(routeProp.const).toBe("done");
	});

	it("schema has route as a union when multiple routes exist", () => {
		const tool = buildCompletionTool([RouteId("success"), RouteId("failure")], [], new Map());
		const schema = tool.parameters as { properties: Record<string, unknown> };
		const routeProp = schema.properties.route as { anyOf?: Array<{ const: string }> };
		expect(routeProp.anyOf).toHaveLength(2);
		expect(routeProp.anyOf![0]!.const).toBe("success");
		expect(routeProp.anyOf![1]!.const).toBe("failure");
	});

	it("adds a string property for text artifacts", () => {
		const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
			[ArtifactId("notes"), textContract("notes", "Review notes")],
		]);
		const tool = buildCompletionTool([RouteId("done")], [ArtifactId("notes")], contracts);
		const schema = tool.parameters as { properties: Record<string, unknown> };
		const notesProp = schema.properties.notes as { type: string };
		expect(notesProp.type).toBe("string");
	});

	it("adds an object property for record artifacts", () => {
		const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
			[ArtifactId("result"), recordContract("result", "Analysis result", ["root_cause", "severity"])],
		]);
		const tool = buildCompletionTool([RouteId("done")], [ArtifactId("result")], contracts);
		const schema = tool.parameters as { properties: Record<string, unknown> };
		const resultProp = schema.properties.result as { type: string; properties: Record<string, unknown> };
		expect(resultProp.type).toBe("object");
		expect(resultProp.properties).toHaveProperty("root_cause");
		expect(resultProp.properties).toHaveProperty("severity");
	});

	it("adds an array property for record_list artifacts", () => {
		const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
			[ArtifactId("issues"), recordListContract("issues", "Found issues", ["file", "description"])],
		]);
		const tool = buildCompletionTool([RouteId("done")], [ArtifactId("issues")], contracts);
		const schema = tool.parameters as { properties: Record<string, unknown> };
		const issuesProp = schema.properties.issues as {
			type: string;
			items: { type: string; properties: Record<string, unknown> };
		};
		expect(issuesProp.type).toBe("array");
		expect(issuesProp.items.type).toBe("object");
		expect(issuesProp.items.properties).toHaveProperty("file");
		expect(issuesProp.items.properties).toHaveProperty("description");
	});

	it("makes artifact properties optional", () => {
		const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
			[ArtifactId("notes"), textContract("notes", "Notes")],
		]);
		const tool = buildCompletionTool([RouteId("done")], [ArtifactId("notes")], contracts);
		const schema = tool.parameters as { required?: string[] };
		const required = schema.required ?? [];
		expect(required).toContain("route");
		expect(required).not.toContain("notes");
	});

	it("skips writable artifacts that have no contract", () => {
		const tool = buildCompletionTool([RouteId("done")], [ArtifactId("missing")], new Map());
		const schema = tool.parameters as { properties: Record<string, unknown> };
		expect(schema.properties).not.toHaveProperty("missing");
	});

	it("includes route names in the description", () => {
		const tool = buildCompletionTool([RouteId("approved"), RouteId("changes_requested")], [], new Map());
		expect(tool.description).toContain('"approved"');
		expect(tool.description).toContain('"changes_requested"');
	});

	it("includes artifact descriptions in the tool description", () => {
		const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
			[ArtifactId("notes"), textContract("notes", "Review notes from the code review")],
		]);
		const tool = buildCompletionTool([RouteId("done")], [ArtifactId("notes")], contracts);
		expect(tool.description).toContain("notes: Review notes from the code review");
	});

	describe("execute", () => {
		it("returns terminate: true", async () => {
			const tool = buildCompletionTool([RouteId("done")], [], new Map());
			const result = await tool.execute("call-1", { route: "done" }, undefined, undefined, {} as any);
			expect(result.terminate).toBe(true);
		});

		it("returns route and artifacts in details", async () => {
			const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
				[ArtifactId("notes"), textContract("notes", "Notes")],
			]);
			const tool = buildCompletionTool([RouteId("done")], [ArtifactId("notes")], contracts);
			const result = await tool.execute(
				"call-1",
				{ route: "done", notes: "some text" },
				undefined,
				undefined,
				{} as any,
			);
			const details = result.details as CompletionDetails;
			expect(details.route).toBe("done");
			expect(details.artifacts).toEqual({ notes: "some text" });
		});

		it("separates route from artifact values in details", async () => {
			const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
				[ArtifactId("a"), textContract("a", "A")],
				[ArtifactId("b"), textContract("b", "B")],
			]);
			const tool = buildCompletionTool([RouteId("done")], [ArtifactId("a"), ArtifactId("b")], contracts);
			const result = await tool.execute(
				"call-1",
				{ route: "done", a: "val-a", b: "val-b" },
				undefined,
				undefined,
				{} as any,
			);
			const details = result.details as CompletionDetails;
			expect(details.route).toBe("done");
			expect(details.artifacts).toEqual({ a: "val-a", b: "val-b" });
			expect(details.artifacts).not.toHaveProperty("route");
		});
	});
});
