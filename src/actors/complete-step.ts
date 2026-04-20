/**
 * Actor completion protocol.
 *
 * An actor runs in a pi subprocess with restricted tools. The completion
 * signal is an XML-tagged block the actor emits as its final output:
 *
 *     <relay-complete>
 *     <route>done</route>
 *     <artifact id="notes">plain text value</artifact>
 *     </relay-complete>
 *
 * The scheduler treats the tag as a structured signal:
 *
 *   - The route must match one of the action step's declared outgoing routes.
 *   - Every artifact in the block must be in the step's declared `writes` list.
 *     Extra ids are silently dropped (defensive), never treated as errors.
 *
 * The instruction text appended to the actor's system prompt lists the
 * allowed routes and writable artifacts explicitly, with their descriptions
 * lifted from the plan's artifact contracts.
 */

import type { ArtifactId, RouteId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import { err, ok, type Result } from "../plan/result.js";
import type { ArtifactContract, ArtifactShape } from "../plan/types.js";

const COMPLETE_TAG = "relay-complete";

const COMPLETE_OPEN = `<${COMPLETE_TAG}>`;
const COMPLETE_CLOSE = `</${COMPLETE_TAG}>`;

const COMPLETE_RE = /<relay-complete>([\s\S]*?)<\/relay-complete>/;
const COMPLETE_RE_GLOBAL = /<relay-complete>[\s\S]*?<\/relay-complete>/g;

const ROUTE_RE = /<route>([\s\S]*?)<\/route>/;
const ARTIFACT_RE = /<artifact\s+id="([^"]+)">([\s\S]*?)<\/artifact>/g;
const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;
const FIELD_TAG_RE = /<([a-zA-Z0-9_.:-]+)>([\s\S]*?)<\/\1>/g;

export interface ParsedCompletion {
	readonly route: string;
	readonly writes: Record<string, unknown>;
}

export interface CompletionInstructionInput {
	readonly routes: readonly RouteId[];
	readonly writableArtifactIds: readonly ArtifactId[];
	readonly artifactContracts: ReadonlyMap<ArtifactId, ArtifactContract>;
}

/**
 * Build the completion-protocol instruction text appended to an actor's
 * system prompt.
 *
 * The text is intentionally imperative. It lists the allowed routes and the
 * writable artifacts — the model's only way to signal the scheduler is via
 * the tag, so we are loud about the format.
 */
export const buildCompletionInstruction = (input: CompletionInstructionInput): string => {
	const routeLines =
		input.routes.length === 0
			? "  (none — this should not happen; report it to the caller)"
			: input.routes.map((r) => `  - ${unwrap(r)}`).join("\n");

	const writeLines =
		input.writableArtifactIds.length === 0
			? "  (none — do not include any <artifact> tags)"
			: input.writableArtifactIds
					.map((id) => {
						const contract = input.artifactContracts.get(id);
						const description = contract?.description ?? "";
						const line = `  - ${unwrap(id)}: ${description}`.trimEnd();
						const hint = contract ? formatShapeHint(contract.shape) : "";
						return hint ? `${line}\n${hint}` : line;
					})
					.join("\n");

	const exampleBlock = buildExampleBlock(input);

	return [
		"## Relay completion protocol",
		"",
		"You are executing as one step of a Relay plan. The runtime will read",
		"your final output for a completion block in the exact format below.",
		"Do not emit this block until every task requirement is complete.",
		"",
		exampleBlock,
		"",
		"Requirements:",
		"- Emit the block exactly once, as the VERY LAST thing in your reply.",
		"- Use XML tags as shown. `<route>` is required. One `<artifact>` tag",
		"  per writable artifact you want to commit.",
		"- For structured artifacts with declared fields, use one XML tag per",
		"  field (e.g. `<root_cause>value</root_cause>`). For list artifacts,",
		"  wrap each entry in `<item>` tags.",
		"- For text artifacts (no fields), put plain text directly inside the",
		"  `<artifact>` tag. Do NOT use JSON.",
		"- Keep values compact. Put detailed text in your narration (before",
		"  the completion block), not inside the artifact tags.",
		"- `route` must be one of the allowed routes listed below.",
		"",
		"Allowed routes (choose exactly one):",
		routeLines,
		"",
		"Writable artifacts:",
		writeLines,
	].join("\n");
};

/**
 * Parse the completion block from a free-form assistant message.
 *
 * Returns `Result`. The caller treats every error as `no_completion` — it is
 * not a shape_mismatch at the artifact level, it is a protocol violation by
 * the actor that the scheduler implicitly retries.
 */
export const parseCompletion = (text: string): Result<ParsedCompletion, string> => {
	const match = COMPLETE_RE.exec(text);
	if (!match?.[1]) {
		return err("completion block not found in final output");
	}

	const payload = match[1];

	const routeMatch = ROUTE_RE.exec(payload);
	if (!routeMatch) {
		return err("completion block is missing <route> tag");
	}
	const route = (routeMatch[1] ?? "").trim();
	if (route.length === 0) {
		return err("completion block has an empty <route> tag");
	}

	const writes: Record<string, unknown> = {};
	for (const artifactMatch of payload.matchAll(new RegExp(ARTIFACT_RE.source, ARTIFACT_RE.flags))) {
		const id = artifactMatch[1]!;
		const rawContent = artifactMatch[2]!.trim();
		writes[id] = parseArtifactContent(rawContent);
	}

	return ok({ route, writes });
};

const buildExampleBlock = (input: CompletionInstructionInput): string => {
	const lines: string[] = [COMPLETE_OPEN, "<route>ROUTE_NAME</route>"];

	for (const id of input.writableArtifactIds) {
		const contract = input.artifactContracts.get(id);
		const idStr = unwrap(id);
		if (!contract || contract.shape.kind === "text") {
			lines.push(`<artifact id="${idStr}">plain text value</artifact>`);
		} else if (contract.shape.kind === "record") {
			lines.push(`<artifact id="${idStr}">`);
			for (const field of contract.shape.fields) {
				lines.push(`<${field}>value</${field}>`);
			}
			lines.push("</artifact>");
		} else if (contract.shape.kind === "record_list") {
			lines.push(`<artifact id="${idStr}">`);
			for (let i = 1; i <= 2; i++) {
				lines.push("<item>");
				for (const field of contract.shape.fields) {
					lines.push(`<${field}>...</${field}>`);
				}
				lines.push("</item>");
			}
			lines.push("<!-- repeat <item> as needed -->");
			lines.push("</artifact>");
		}
		break;
	}

	lines.push(COMPLETE_CLOSE);
	return lines.join("\n");
};

/**
 * Infer structure from artifact content.
 *
 * - If `<item>` tags are present → parse each item's field tags → array
 * - If field-level tags are present (no `<item>`) → parse as single record
 * - Otherwise → plain text string
 */
const parseArtifactContent = (content: string): unknown => {
	const items: Record<string, string>[] = [];
	for (const itemMatch of content.matchAll(new RegExp(ITEM_RE.source, ITEM_RE.flags))) {
		items.push(parseFieldTags(itemMatch[1]!));
	}
	if (items.length > 0) return items;

	const fields = parseFieldTags(content);
	if (Object.keys(fields).length > 0) return fields;

	return unescapeXml(content);
};

const parseFieldTags = (content: string): Record<string, string> => {
	const fields: Record<string, string> = {};
	for (const fieldMatch of content.matchAll(new RegExp(FIELD_TAG_RE.source, FIELD_TAG_RE.flags))) {
		fields[fieldMatch[1]!] = unescapeXml(fieldMatch[2]!.trim());
	}
	return fields;
};

const XML_ENTITY_RE = /&(?:lt|gt|amp|quot|apos);/g;

const XML_ENTITIES: Record<string, string> = {
	"&lt;": "<",
	"&gt;": ">",
	"&amp;": "&",
	"&quot;": '"',
	"&apos;": "'",
};

const unescapeXml = (text: string): string => text.replace(XML_ENTITY_RE, (entity) => XML_ENTITIES[entity] ?? entity);

export const formatShapeHint = (shape: ArtifactShape): string => {
	switch (shape.kind) {
		case "text":
			return "    Value: plain text";
		case "record":
			return `    Fields: ${shape.fields.join(", ")}`;
		case "record_list":
			return `    Fields (list): ${shape.fields.join(", ")}\n    Produce one <item> per entry found.`;
	}
};

/**
 * Remove the `<relay-complete>...</relay-complete>` block from an actor's
 * text reply for display.
 *
 * The tag is protocol machinery — we parse it to extract `route` and
 * `writes`, but users should never see it in the UI. The renderer calls
 * this before handing the actor's final text to the Markdown component or
 * the inline progress preview.
 *
 * Whitespace around the removed tag is normalized so the prose doesn't
 * end up with awkward blank lines where the tag used to live.
 */
export const stripCompletionTag = (text: string): string => {
	if (!text.includes("<relay-complete>")) return text.trim();
	return text
		.replace(COMPLETE_RE_GLOBAL, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
};
