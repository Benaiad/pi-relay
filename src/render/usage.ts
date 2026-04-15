/**
 * Usage aggregation and formatting.
 *
 * Produces the same `3 turns ↑1.2k ↓890 R5.4k W100 $0.0234 ctx:12k <model>`
 * summary subagent uses, applied to a Relay run instead of a single agent.
 */

import type { ActorUsage } from "../actors/types.js";
import { formatCost, formatTokens, joinNonEmpty, pluralize } from "./format.js";

export const formatUsageStats = (usage: ActorUsage, model?: string): string => {
	const parts: (string | null)[] = [];
	if (usage.turns > 0) parts.push(pluralize(usage.turns, "turn"));
	if (usage.input > 0) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output > 0) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead > 0) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite > 0) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost > 0) parts.push(formatCost(usage.cost));
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return joinNonEmpty(parts, " ");
};

export const addUsage = (a: ActorUsage, b: ActorUsage): ActorUsage => ({
	input: a.input + b.input,
	output: a.output + b.output,
	cacheRead: a.cacheRead + b.cacheRead,
	cacheWrite: a.cacheWrite + b.cacheWrite,
	cost: a.cost + b.cost,
	contextTokens: Math.max(a.contextTokens, b.contextTokens),
	turns: a.turns + b.turns,
});
