/**
 * YAML-like value renderer for artifact presentation.
 *
 * Produces human-readable, token-efficient output from artifact values.
 * Optimizes for LLM comprehension, not YAML spec compliance — the output
 * does not need to round-trip through a YAML parser.
 *
 * Rules:
 *   - Primitives render inline (unquoted strings, numbers, booleans, null)
 *   - Objects render as indented key-value pairs
 *   - Arrays render as indented `- ` prefixed items
 *   - Strings with special characters are quoted
 *   - Depth limit (4) falls back to inline JSON
 */

const MAX_DEPTH = 4;
const NEEDS_QUOTING = /[:#{}[\],&*?|>!%@`"'\n\r]/;

export const renderValue = (value: unknown, indent = 0): string => {
	if (indent >= MAX_DEPTH) return inlineJson(value);

	if (value === null || value === undefined) return "null";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") return renderString(value);

	if (Array.isArray(value)) {
		if (value.length === 0) return "[]";
		return renderArray(value, indent);
	}

	if (typeof value === "object") {
		const entries = Object.entries(value);
		if (entries.length === 0) return "{}";
		return renderObject(entries, indent);
	}

	return inlineJson(value);
};

const renderString = (str: string): string => {
	if (str.length === 0) return '""';
	if (str.includes("\n")) return `"${escapeQuoted(str)}"`;
	if (NEEDS_QUOTING.test(str)) return `"${escapeQuoted(str)}"`;
	return str;
};

const escapeQuoted = (str: string): string =>
	str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r");

const renderObject = (entries: [string, unknown][], indent: number): string => {
	const prefix = "  ".repeat(indent);
	const lines: string[] = [];
	for (const [key, val] of entries) {
		if (isPrimitive(val)) {
			lines.push(`${prefix}${key}: ${renderValue(val, indent + 1)}`);
		} else {
			lines.push(`${prefix}${key}:`);
			lines.push(renderValue(val, indent + 1));
		}
	}
	return lines.join("\n");
};

const renderArray = (items: unknown[], indent: number): string => {
	const prefix = "  ".repeat(indent);
	const lines: string[] = [];
	for (const item of items) {
		if (isPrimitive(item)) {
			lines.push(`${prefix}- ${renderValue(item, indent + 1)}`);
		} else if (typeof item === "object" && item !== null && !Array.isArray(item)) {
			const entries = Object.entries(item);
			if (entries.length > 0) {
				const [firstKey, firstVal] = entries[0]!;
				const firstLine = isPrimitive(firstVal)
					? `${prefix}- ${firstKey}: ${renderValue(firstVal, indent + 2)}`
					: `${prefix}- ${firstKey}:\n${renderValue(firstVal, indent + 2)}`;
				lines.push(firstLine);
				for (const [key, val] of entries.slice(1)) {
					if (isPrimitive(val)) {
						lines.push(`${prefix}  ${key}: ${renderValue(val, indent + 2)}`);
					} else {
						lines.push(`${prefix}  ${key}:`);
						lines.push(renderValue(val, indent + 2));
					}
				}
			} else {
				lines.push(`${prefix}- {}`);
			}
		} else {
			lines.push(`${prefix}- ${renderValue(item, indent + 1)}`);
		}
	}
	return lines.join("\n");
};

const isPrimitive = (value: unknown): boolean =>
	value === null ||
	value === undefined ||
	typeof value === "string" ||
	typeof value === "number" ||
	typeof value === "boolean";

const inlineJson = (value: unknown): string => {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
};
