/**
 * Shared formatters for rendered output.
 *
 * These helpers match subagent's visual conventions so Relay's output looks
 * visually identical to pi's built-in tools. When pi changes its conventions,
 * update both subagent and relay together — never diverge.
 */

import * as os from "node:os";

export const shortenPath = (p: string): string => {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
};

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

export const joinNonEmpty = (items: readonly (string | undefined | null | false)[], sep = " · "): string =>
	items.filter((x): x is string => typeof x === "string" && x.length > 0).join(sep);

export const pluralize = (count: number, singular: string, plural?: string): string => {
	const word = count === 1 ? singular : (plural ?? `${singular}s`);
	return `${count} ${word}`;
};
