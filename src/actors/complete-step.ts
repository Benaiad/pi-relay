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
import type { ArtifactContract } from "../plan/types.js";

const COMPLETE_TAG = "relay-complete";

const COMPLETE_OPEN = `<${COMPLETE_TAG}>`;
const COMPLETE_CLOSE = `</${COMPLETE_TAG}>`;

const COMPLETE_RE = /<relay-complete>([\s\S]*?)<\/relay-complete>/;
const COMPLETE_RE_GLOBAL = /<relay-complete>[\s\S]*?<\/relay-complete>/g;

const ROUTE_RE = /<route>([\s\S]*?)<\/route>/;
const ARTIFACT_RE = /<artifact\s+id="([^"]+)">([\s\S]*?)<\/artifact>/g;

export interface ParsedCompletion {
  readonly route: string;
  readonly writes: Record<string, string>;
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
export const buildCompletionInstruction = (
  input: CompletionInstructionInput,
): string => {
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
            return `  - ${unwrap(id)}: ${description}`.trimEnd();
          })
          .join("\n");

  const exampleArtifact =
    input.writableArtifactIds.length > 0
      ? `\n<artifact id="${unwrap(input.writableArtifactIds[0]!)}">value here</artifact>`
      : "";

  return [
    "## Relay completion protocol",
    "",
    "You are executing as one step of a Relay plan. The runtime will read",
    "your final output for a completion block in the exact format below.",
    "Do not emit this block until every task requirement is complete.",
    "",
    `${COMPLETE_OPEN}`,
    `<route>ROUTE_NAME</route>${exampleArtifact}`,
    `${COMPLETE_CLOSE}`,
    "",
    "Requirements:",
    "- Emit the block exactly once, as the VERY LAST thing in your reply.",
    "- Use XML tags as shown. `<route>` is required. One `<artifact>` tag",
    "  per writable artifact you want to commit.",
    "- Artifact values are plain text between the tags. Do NOT use JSON.",
    "  Keep values compact — short summaries, not long prose.",
    "  Put detailed text in your narration (before the completion block).",
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
export const parseCompletion = (
  text: string,
): Result<ParsedCompletion, string> => {
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

  const writes: Record<string, string> = {};
  let artifactMatch: RegExpExecArray | null;
  const artifactRe = new RegExp(ARTIFACT_RE.source, ARTIFACT_RE.flags);
  while ((artifactMatch = artifactRe.exec(payload)) !== null) {
    const id = artifactMatch[1]!;
    const value = unescapeXml(artifactMatch[2]!.trim());
    writes[id] = value;
  }

  return ok({ route, writes });
};

const XML_ENTITY_RE = /&(?:lt|gt|amp|quot|apos);/g;

const XML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&amp;": "&",
  "&quot;": '"',
  "&apos;": "'",
};

const unescapeXml = (text: string): string =>
  text.replace(XML_ENTITY_RE, (entity) => XML_ENTITIES[entity] ?? entity);

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
