/**
 * Actor completion protocol.
 *
 * An actor runs in a pi subprocess with restricted tools. The completion
 * signal is a single tagged block the actor emits as its final output:
 *
 *     <relay-complete>{"route":"<name>","writes":{"artifact-id": <value>}}</relay-complete>
 *
 * The scheduler treats the tag as a structured tool call:
 *
 *   - The route must match one of the action step's declared outgoing routes.
 *   - Every artifact in `writes` must be in the step's declared `writes` list.
 *     Extra ids are silently dropped (defensive), never treated as errors.
 *
 * The instruction text appended to the actor's system prompt lists the
 * allowed routes and writable artifacts explicitly, with their descriptions
 * lifted from the plan's artifact contracts. The protocol's correctness is
 * enforced by `parseCompletion` — no trust is placed in the actor's output
 * beyond "the JSON parses and the fields are the right shape."
 */

import type { ArtifactId, RouteId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import { err, ok, type Result } from "../plan/result.js";
import type { ArtifactContract } from "../plan/types.js";

const COMPLETE_TAG = "relay-complete";

const COMPLETE_OPEN = `<${COMPLETE_TAG}>`;
const COMPLETE_CLOSE = `</${COMPLETE_TAG}>`;

const COMPLETE_RE = /<relay-complete>([\s\S]*?)<\/relay-complete>/;
/** Global variant for removing EVERY occurrence of the tag when rendering. */
const COMPLETE_RE_GLOBAL = /<relay-complete>[\s\S]*?<\/relay-complete>/g;

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
export const buildCompletionInstruction = (
  input: CompletionInstructionInput,
): string => {
  const routeLines =
    input.routes.length === 0
      ? "  (none — this should not happen; report it to the caller)"
      : input.routes.map((r) => `  - ${unwrap(r)}`).join("\n");

  const writeLines =
    input.writableArtifactIds.length === 0
      ? "  (none — emit an empty object `{}`)"
      : input.writableArtifactIds
          .map((id) => {
            const contract = input.artifactContracts.get(id);
            const description = contract?.description ?? "";
            return `  - ${unwrap(id)}: ${description}`.trimEnd();
          })
          .join("\n");

  return [
    "## Relay completion protocol",
    "",
    "You are executing as one step of a Relay plan. The runtime will read",
    "your final output for a completion block in the exact format below.",
    "Do not emit this block until every task requirement is complete.",
    "",
    `${COMPLETE_OPEN}{"route":"<ROUTE>","writes":{"<artifact-id>": <value>, ...}}${COMPLETE_CLOSE}`,
    "",
    "Requirements:",
    "- Emit the block exactly once, as the VERY LAST thing in your reply.",
    "- The content between the tags must be valid JSON. Double-quote all",
    '  keys and string values. Escape newlines as \\n and quotes as \\".',
    "- Keep artifact values compact — short strings, arrays, simple objects.",
    "  Do NOT embed long prose in JSON strings. Put detailed text in your",
    "  narration (before the tag), not inside the writes object.",
    "- `route` must be one of the allowed routes listed below.",
    "- `writes` is an object mapping every writable artifact id (listed below)",
    "  to the value you want committed. Omit artifacts you do not produce;",
    "  the runtime will treat missing entries as empty.",
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
 *
 * Defensive against two common model habits:
 *   - Wrapping the JSON in a ```json ... ``` code fence inside the tag.
 *   - Leading/trailing whitespace inside the tag.
 */
export const parseCompletion = (
  text: string,
): Result<ParsedCompletion, string> => {
  const match = COMPLETE_RE.exec(text);
  if (!match?.[1]) {
    return err("completion block not found in final output");
  }

  const payload = stripCodeFence(match[1].trim());

  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    raw = tryExtractJson(payload);
    if (raw === undefined) {
      const preview =
        payload.length > 200 ? `${payload.slice(0, 200)}…` : payload;
      return err(
        `completion JSON did not parse. Payload starts with: ${preview}`,
      );
    }
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return err("completion JSON must be an object");
  }
  const obj = raw as Record<string, unknown>;

  const route = obj.route;
  if (typeof route !== "string" || route.length === 0) {
    return err("completion JSON is missing string field 'route'");
  }

  let writes: Record<string, unknown>;
  if (obj.writes === undefined || obj.writes === null) {
    writes = {};
  } else if (typeof obj.writes !== "object" || Array.isArray(obj.writes)) {
    return err("completion JSON field 'writes' must be an object");
  } else {
    writes = obj.writes as Record<string, unknown>;
  }

  return ok({ route, writes });
};

/**
 * Attempt to extract a valid JSON object from a payload that failed
 * `JSON.parse`. Handles two common model errors:
 *
 *   1. Trailing text after the JSON object (the model wrote more
 *      content after closing the braces).
 *   2. Unescaped newlines inside string values.
 *
 * Returns `undefined` if no valid JSON object can be extracted.
 */
const tryExtractJson = (payload: string): unknown | undefined => {
  const start = payload.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let i = start; i < payload.length; i++) {
    const ch = payload[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }

  if (end === -1) return undefined;

  const candidate = payload.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    const fixed = candidate.replace(/[\n\r]/g, "\\n").replace(/\t/g, "\\t");
    try {
      return JSON.parse(fixed);
    } catch {
      return undefined;
    }
  }
};

const FENCE_OPEN = /^```(?:json)?\s*\n?/i;
const FENCE_CLOSE = /\n?```$/;

/**
 * If the payload is wrapped in a markdown code fence (with optional language
 * tag), strip the fence. The model frequently does this out of habit when
 * asked to emit JSON.
 */
const stripCodeFence = (payload: string): string => {
  if (!FENCE_OPEN.test(payload)) return payload;
  return payload.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "").trim();
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
