/**
 * Shared formatters for rendered output.
 *
 * These helpers match pi's built-in tool render conventions (see
 * packages/coding-agent/src/core/tools/render-utils.ts and bash.ts in the
 * pi-mono tree) so Relay's output is visually consistent with read, grep,
 * bash, etc. When pi changes its conventions, update both in lockstep —
 * never diverge.
 */

import * as os from "node:os";
import type { Theme } from "@mariozechner/pi-coding-agent";

export const shortenPath = (value: unknown): string => {
	if (typeof value !== "string") return "";
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
};

/**
 * Pass-through for known-string args, returns `""` for null/undefined, and
 * `null` for values that are neither — mirroring pi's render-utils `str`.
 *
 * Callers use `null` as the signal to render `[invalid arg]`.
 */
export const str = (value: unknown): string | null => {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
};

export const invalidArg = (theme: Theme): string => theme.fg("error", "[invalid arg]");

export const formatTokens = (count: number): string => {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
};

export const formatCost = (cost: number): string => `$${cost.toFixed(4)}`;

export const formatDuration = (ms: number): string => {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.floor((ms % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
};

export const truncate = (text: string, limit: number): string => {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}…`;
};

/** Normalize whitespace and truncate — used for one-line task summaries in headers. */
export const oneLine = (text: string, limit: number): string => truncate(text.trim().replace(/\s+/g, " "), limit);

export const joinNonEmpty = (items: readonly (string | undefined | null | false)[], sep = " · "): string =>
	items.filter((x): x is string => typeof x === "string" && x.length > 0).join(sep);

export const pluralize = (count: number, singular: string, plural?: string): string => {
	const word = count === 1 ? singular : (plural ?? `${singular}s`);
	return `${count} ${word}`;
};

/**
 * Pad a string to `width` columns on the right.
 *
 * Counts the length of the raw string — safe for plain text, NOT safe for
 * strings with ANSI escape codes. Use before coloring, not after.
 */
export const padRight = (text: string, width: number): string => {
	if (text.length >= width) return text;
	return text + " ".repeat(width - text.length);
};

/** Compute the maximum visual width of a list of strings (pre-ANSI). */
export const maxWidth = (items: readonly string[]): number => {
	let max = 0;
	for (const item of items) if (item.length > max) max = item.length;
	return max;
};
