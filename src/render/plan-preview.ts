/**
 * Render the PlanDraft as a tool call header — pi `renderCall` hook.
 *
 * Matches pi's built-in tool call layout (see bash.ts, read.ts, grep.ts in
 * the pi-mono tree): a single `Text` component reused across updates via
 * `context.lastComponent`, producing a one-line header followed by optional
 * metadata lines below. Collapsed shows the task and step count on one line;
 * expanded shows a table of steps with their actor/check kind and routing.
 *
 * No Container/Spacer composition — the whole output is a single string
 * with embedded `\n` and theme colors, which is how every first-party pi
 * tool renders.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Text } from "@mariozechner/pi-tui";
import type { PlanDraftDoc } from "../plan/draft.js";
import { invalidArg, maxWidth, oneLine, padRight, str, truncate } from "./format.js";

export const renderPlanPreview = (
	plan: PlanDraftDoc,
	theme: Theme,
	expanded: boolean,
	lastComponent: Component | undefined,
): Component => {
	const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(expanded ? formatExpanded(plan, theme) : formatCollapsed(plan, theme));
	return text;
};

// ============================================================================
// Collapsed
// ============================================================================

const formatCollapsed = (plan: PlanDraftDoc, theme: Theme): string => {
	const header = buildHeader(plan, theme);
	const summary = buildCountSummary(plan, theme);
	return `${header}\n  ${summary}`;
};

// ============================================================================
// Expanded
// ============================================================================

const formatExpanded = (plan: PlanDraftDoc, theme: Theme): string => {
	const lines: string[] = [];
	lines.push(buildHeader(plan, theme));
	if (plan.successCriteria) {
		lines.push(`  ${theme.fg("muted", `success: ${truncate(plan.successCriteria, 200)}`)}`);
	}
	lines.push(`  ${buildCountSummary(plan, theme)}`);
	lines.push("");

	const rows = plan.steps.map((step) => buildStepRow(step, theme));
	const idWidth = maxWidth(rows.map((r) => r.idPlain));
	const kindWidth = maxWidth(rows.map((r) => r.kindPlain));

	for (const row of rows) {
		const idPadded = padRight(row.idPlain, idWidth);
		const kindPadded = padRight(row.kindPlain, kindWidth);
		lines.push(`  ${row.marker} ${theme.fg("accent", idPadded)}  ${theme.fg("muted", kindPadded)}  ${row.trailing}`);
	}
	return lines.join("\n");
};

// ============================================================================
// Shared header + counts
// ============================================================================

const buildHeader = (plan: PlanDraftDoc, theme: Theme): string => {
	const rawTask = str(plan.task);
	const taskDisplay =
		rawTask === null
			? invalidArg(theme)
			: rawTask
				? theme.fg("accent", oneLine(rawTask, 70))
				: theme.fg("toolOutput", "...");
	return `${theme.fg("toolTitle", theme.bold("relay"))} ${taskDisplay}`;
};

const buildCountSummary = (plan: PlanDraftDoc, theme: Theme): string => {
	const actorCount = new Set<string>();
	let action = 0;
	let check = 0;
	let terminal = 0;
	for (const step of plan.steps) {
		switch (step.kind) {
			case "action":
				action += 1;
				actorCount.add(step.actor);
				break;
			case "check":
				check += 1;
				break;
			case "terminal":
				terminal += 1;
				break;
		}
	}
	return theme.fg(
		"muted",
		`${plan.steps.length} steps (${action} action · ${check} check · ${terminal} terminal) · ${actorCount.size} actors · ${plan.artifacts.length} artifacts · entry: ${plan.entryStep}`,
	);
};

// ============================================================================
// Step rows
// ============================================================================

interface StepRow {
	readonly marker: string;
	readonly idPlain: string;
	readonly kindPlain: string;
	readonly trailing: string;
}

const buildStepRow = (step: PlanDraftDoc["steps"][number], theme: Theme): StepRow => {
	switch (step.kind) {
		case "action": {
			const routes = step.routes.map((r) => `${r.route}→${r.to}`).join(" ");
			const rw = buildReadsWrites(step);
			const retry = step.retry ? ` retry×${step.retry.maxAttempts}` : "";
			return {
				marker: theme.fg("accent", "▸"),
				idPlain: step.id,
				kindPlain: `action(${step.actor})`,
				trailing: theme.fg("dim", `${rw}${rw ? "  " : ""}→ ${routes}${retry}`),
			};
		}
		case "check": {
			return {
				marker: theme.fg("warning", "?"),
				idPlain: step.id,
				kindPlain: `check(${step.check.kind})`,
				trailing: theme.fg("dim", `pass→${step.onPass}  fail→${step.onFail}`),
			};
		}
		case "terminal": {
			const color = step.outcome === "success" ? "success" : "error";
			return {
				marker: theme.fg(color, "■"),
				idPlain: step.id,
				kindPlain: `terminal(${step.outcome})`,
				trailing: theme.fg("muted", truncate(step.summary, 60)),
			};
		}
	}
};

const buildReadsWrites = (step: Extract<PlanDraftDoc["steps"][number], { kind: "action" }>): string => {
	const parts: string[] = [];
	if (step.reads.length > 0) parts.push(`reads:[${step.reads.join(",")}]`);
	if (step.writes.length > 0) parts.push(`writes:[${step.writes.join(",")}]`);
	return parts.join(" ");
};
