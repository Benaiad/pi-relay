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

/**
 * A theme stand-in that returns every string unchanged — used by the
 * plain-text run report where we want subagent-style tool previews
 * without ANSI colors. Pass this wherever a callsite expects a real
 * `Theme` and you want text-only output.
 */
export const plainTheme: Theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as unknown as Theme;

/**
 * One-line preview of a tool call, formatted to visually match how pi's
 * own built-in tools render the same invocation.
 *
 * Ported from subagent's `formatToolCall` (packages/coding-agent/examples/
 * extensions/subagent/index.ts L64–130) so a relay actor's transcript looks
 * identical to tool calls produced by the outer pi agent.
 *
 * Unknown tool names fall back to `<name> <JSON preview>` truncated to 50
 * chars. This keeps extension-registered tools visible without special
 * cases for every possible name.
 */
export const formatToolCall = (
	toolName: string,
	args: Record<string, unknown>,
	theme: Theme,
	bashLimit?: number,
): string => {
	const fg = theme.fg.bind(theme);
	switch (toolName) {
		case "bash": {
			const command = typeof args.command === "string" ? args.command : "...";
			const limit = bashLimit ?? 60;
			const preview = limit > 0 && command.length > limit ? `${command.slice(0, limit)}…` : command;
			return fg("muted", "$ ") + fg("toolOutput", preview);
		}
		case "read": {
			const rawPath =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
			const filePath = shortenPath(rawPath);
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let text = fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
			const filePath = shortenPath(rawPath);
			const content = typeof args.content === "string" ? args.content : "";
			const lines = content.split("\n").length;
			let text = fg("muted", "write ") + fg("accent", filePath);
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "...";
			return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = typeof args.path === "string" ? args.path : ".";
			return fg("muted", "ls ") + fg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "*";
			const rawPath = typeof args.path === "string" ? args.path : ".";
			return fg("muted", "find ") + fg("accent", pattern) + fg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const rawPath = typeof args.path === "string" ? args.path : ".";
			return fg("muted", "grep ") + fg("accent", `/${pattern}/`) + fg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}…` : argsStr;
			return fg("accent", toolName) + fg("dim", ` ${preview}`);
		}
	}
};
