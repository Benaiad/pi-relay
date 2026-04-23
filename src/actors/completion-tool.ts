/**
 * Dynamic completion tool construction.
 *
 * Each action step gets a `relay_complete` tool whose schema is derived from
 * the step's declared routes and writable artifacts. The model calls this tool
 * with structured JSON arguments instead of emitting XML in free-form text.
 * `terminate: true` in the tool result ends the agent turn immediately.
 *
 * The schema enforces route validity and artifact structure at the API level —
 * invalid routes and missing fields are rejected before the model's response
 * is even returned. No regex parsing, no structure inference.
 */

import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import type { ArtifactId, RouteId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import type { ArtifactContract, ArtifactShape } from "../plan/types.js";

const TOOL_NAME = "relay_complete";

/** The structured details carried by the tool result. */
export interface CompletionDetails {
	readonly route: string;
	readonly artifacts: Record<string, unknown>;
}

/**
 * Build a `relay_complete` tool definition for a specific action step.
 *
 * The tool's parameter schema is constructed from the step's declared routes
 * and writable artifacts. Route names become a string enum. Each writable
 * artifact becomes an optional property whose type matches its declared shape.
 */
export const buildCompletionTool = (
	routes: readonly RouteId[],
	writableArtifactIds: readonly ArtifactId[],
	artifactContracts: ReadonlyMap<ArtifactId, ArtifactContract>,
): ToolDefinition => {
	const routeSchema = buildRouteSchema(routes);
	const artifactProperties: Record<string, TSchema> = {};

	for (const id of writableArtifactIds) {
		const contract = artifactContracts.get(id);
		if (!contract) continue;
		artifactProperties[unwrap(id)] = Type.Optional(shapeToSchema(contract.shape, contract.description));
	}

	const hasArtifacts = Object.keys(artifactProperties).length > 0;
	const parameters = hasArtifacts
		? Type.Object({
				route: routeSchema,
				...artifactProperties,
			})
		: Type.Object({
				route: routeSchema,
			});

	return defineTool({
		name: TOOL_NAME,
		label: "Relay Complete",
		description: buildDescription(routes, writableArtifactIds, artifactContracts),
		promptSnippet: "Signal step completion with a route and optional artifact values",
		promptGuidelines: [
			"Call relay_complete exactly once, as your final action, after all work is done.",
			"Do not call relay_complete until every task requirement is met.",
			"Choose the route that best describes the outcome of your work.",
		],
		parameters,

		async execute(_toolCallId, params) {
			const { route, ...artifacts } = params as Record<string, unknown>;
			return {
				content: [{ type: "text", text: `Completion: route=${route}` }],
				details: { route: route as string, artifacts } satisfies CompletionDetails,
				terminate: true,
			};
		},
	});
};

/**
 * Build a TypeBox schema for the route parameter.
 *
 * A union of string literals when multiple routes exist; a single literal
 * when there's only one; a plain string with a description when there are
 * none (should not happen in practice — the compiler rejects steps with
 * zero routes).
 */
const buildRouteSchema = (routes: readonly RouteId[]): TSchema => {
	if (routes.length === 0) {
		return Type.String({ description: "Route name (none declared — this should not happen)" });
	}
	if (routes.length === 1) {
		return Type.Literal(unwrap(routes[0]!));
	}
	return Type.Union(routes.map((r) => Type.Literal(unwrap(r))));
};

/**
 * Convert an `ArtifactShape` into the corresponding TypeBox schema.
 *
 * - text        → string
 * - record      → object with one string property per declared field
 * - record_list → array of objects with one string property per declared field
 */
const shapeToSchema = (shape: ArtifactShape, description: string): TSchema => {
	switch (shape.kind) {
		case "text":
			return Type.String({ description });
		case "record": {
			const fields: Record<string, TSchema> = {};
			for (const field of shape.fields) {
				fields[field] = Type.String();
			}
			return Type.Object(fields, { description });
		}
		case "record_list": {
			const fields: Record<string, TSchema> = {};
			for (const field of shape.fields) {
				fields[field] = Type.String();
			}
			return Type.Array(Type.Object(fields), { description });
		}
	}
};

/**
 * Build a human-readable tool description listing routes and artifacts.
 *
 * Shorter than the old XML protocol instruction — the model already knows
 * how to call tools. The description just tells it what the parameters mean.
 */
const buildDescription = (
	routes: readonly RouteId[],
	writableArtifactIds: readonly ArtifactId[],
	artifactContracts: ReadonlyMap<ArtifactId, ArtifactContract>,
): string => {
	const routeList = routes.map((r) => `"${unwrap(r)}"`).join(", ");
	const lines = [
		"Signal that you have completed this step.",
		`Choose a route (${routeList}) and provide values for any artifacts you want to commit.`,
	];

	if (writableArtifactIds.length > 0) {
		lines.push("");
		lines.push("Writable artifacts:");
		for (const id of writableArtifactIds) {
			const contract = artifactContracts.get(id);
			const desc = contract?.description ?? "";
			lines.push(`  - ${unwrap(id)}: ${desc}`);
		}
	}

	return lines.join("\n");
};
