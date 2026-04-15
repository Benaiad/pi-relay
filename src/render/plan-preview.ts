/**
 * Render the PlanDraft as a tool call header — pi `renderCall` hook.
 *
 * This view is where the user reviews the plan before approving it. It
 * must show enough information that a yes/no decision is informed:
 *
 *   - The full task and success criteria, not truncated
 *   - Every step with its actor and its task-specific instruction
 *   - Every check step's concrete command or path
 *   - Every terminal's outcome and summary
 *   - Reads, writes, routes, and retry policy
 *
 * Collapsed and expanded both show the full plan. The only difference is
 * that collapsed omits the reads/writes/routes/retry metadata — everything
 * a reviewer needs in a glance is there, and the mechanics go in expanded.
 *
 * The TUI `Text` component wraps on width, so we embed literal `\n` between
 * lines and let the terminal handle wrapping long instructions. No hand
 * truncation anywhere — the whole point of the view is to be complete.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Text } from "@mariozechner/pi-tui";
import type { PlanDraftDoc } from "../plan/draft.js";
import { invalidArg, str } from "./format.js";

export const renderPlanPreview = (
	plan: PlanDraftDoc,
	theme: Theme,
	expanded: boolean,
	lastComponent: Component | undefined,
): Component => {
	const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(formatPlan(plan, theme, expanded));
	return text;
};

// ============================================================================
// Layout
// ============================================================================

const formatPlan = (plan: PlanDraftDoc, theme: Theme, expanded: boolean): string => {
	const lines: string[] = [];

	lines.push(buildHeader(plan, theme));
	if (plan.successCriteria) {
		lines.push(`  ${theme.fg("muted", "success:")} ${theme.fg("dim", plan.successCriteria)}`);
	}
	lines.push(`  ${theme.fg("muted", buildCountSummary(plan))}`);
	lines.push("");

	plan.steps.forEach((step, index) => {
		const block = buildStepBlock(step, index + 1, theme, expanded);
		for (const line of block) lines.push(line);
		lines.push("");
	});

	// Drop the final trailing blank line so the result doesn't have dangling whitespace.
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
};

// ============================================================================
// Header + counts
// ============================================================================

const buildHeader = (plan: PlanDraftDoc, theme: Theme): string => {
	const rawTask = str(plan.task);
	const taskDisplay =
		rawTask === null ? invalidArg(theme) : rawTask ? theme.fg("accent", rawTask) : theme.fg("toolOutput", "...");
	return `${theme.fg("accent", "▸")} ${theme.fg("toolTitle", theme.bold("relay"))}  ${taskDisplay}`;
};

const buildCountSummary = (plan: PlanDraftDoc): string => {
	let action = 0;
	let check = 0;
	let terminal = 0;
	const actors = new Set<string>();
	for (const step of plan.steps) {
		switch (step.kind) {
			case "action":
				action += 1;
				actors.add(step.actor);
				break;
			case "check":
				check += 1;
				break;
			case "terminal":
				terminal += 1;
				break;
		}
	}
	return `${plan.steps.length} steps (${action} action · ${check} check · ${terminal} terminal) · ${actors.size} actors · ${plan.artifacts.length} artifacts`;
};

// ============================================================================
// Per-step blocks
// ============================================================================

const buildStepBlock = (
	step: PlanDraftDoc["steps"][number],
	index: number,
	theme: Theme,
	expanded: boolean,
): string[] => {
	switch (step.kind) {
		case "action":
			return buildActionBlock(step, index, theme, expanded);
		case "check":
			return buildCheckBlock(step, index, theme, expanded);
		case "terminal":
			return buildTerminalBlock(step, index, theme);
	}
};

const buildActionBlock = (
	step: Extract<PlanDraftDoc["steps"][number], { kind: "action" }>,
	index: number,
	theme: Theme,
	expanded: boolean,
): string[] => {
	const lines: string[] = [];
	const header =
		`  ${theme.fg("accent", `${index}.`)} ` +
		`${theme.fg("toolTitle", step.id)} ` +
		`${theme.fg("muted", `action(${step.actor})`)}`;
	lines.push(header);
	// Instruction is the most important thing a reviewer needs — the task-specific
	// prompt that will be handed to the actor. Show it in full, one paragraph per
	// line. No truncation.
	for (const paragraph of step.instruction.split("\n")) {
		lines.push(`     ${theme.fg("toolOutput", paragraph)}`);
	}
	if (expanded) {
		const metaParts: string[] = [];
		if (step.reads.length > 0) metaParts.push(`reads: [${step.reads.join(", ")}]`);
		if (step.writes.length > 0) metaParts.push(`writes: [${step.writes.join(", ")}]`);
		if (metaParts.length > 0) lines.push(`     ${theme.fg("dim", metaParts.join("  "))}`);
		const routes = step.routes.map((r) => `${r.route} → ${r.to}`).join("    ");
		lines.push(`     ${theme.fg("dim", `routes: ${routes}`)}`);
		if (step.retry) {
			const backoff = step.retry.backoffMs ? ` (backoff ${step.retry.backoffMs}ms)` : "";
			lines.push(`     ${theme.fg("dim", `retry: up to ${step.retry.maxAttempts} attempts${backoff}`)}`);
		}
	}
	return lines;
};

const buildCheckBlock = (
	step: Extract<PlanDraftDoc["steps"][number], { kind: "check" }>,
	index: number,
	theme: Theme,
	expanded: boolean,
): string[] => {
	const lines: string[] = [];
	const header =
		`  ${theme.fg("warning", `${index}.`)} ` +
		`${theme.fg("toolTitle", step.id)} ` +
		`${theme.fg("muted", `check(${step.check.kind})`)}`;
	lines.push(header);
	lines.push(`     ${theme.fg("toolOutput", describeCheckForReview(step))}`);
	if (expanded) {
		lines.push(`     ${theme.fg("dim", `pass → ${step.onPass}    fail → ${step.onFail}`)}`);
	}
	return lines;
};

const buildTerminalBlock = (
	step: Extract<PlanDraftDoc["steps"][number], { kind: "terminal" }>,
	index: number,
	theme: Theme,
): string[] => {
	const color = step.outcome === "success" ? "success" : "error";
	const header =
		`  ${theme.fg(color, `${index}.`)} ` +
		`${theme.fg("toolTitle", step.id)} ` +
		`${theme.fg("muted", `terminal(${step.outcome})`)}`;
	const summary = `     ${theme.fg("dim", step.summary)}`;
	return [header, summary];
};

const describeCheckForReview = (step: Extract<PlanDraftDoc["steps"][number], { kind: "check" }>): string => {
	switch (step.check.kind) {
		case "file_exists":
			return `file_exists: ${step.check.path}`;
		case "command_exits_zero": {
			const cmd = [step.check.command, ...step.check.args].join(" ");
			const cwdSuffix = step.check.cwd ? `  (cwd: ${step.check.cwd})` : "";
			const timeoutSuffix = step.check.timeoutMs ? `  (timeout ${step.check.timeoutMs}ms)` : "";
			return `command_exits_zero: ${cmd}${cwdSuffix}${timeoutSuffix}`;
		}
	}
};
