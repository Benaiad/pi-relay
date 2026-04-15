/**
 * Render the PlanDraft as a tool call header — pi `renderCall` hook.
 *
 * This view is where the user reviews the plan before approving it. It
 * should read like a plan, not like a schema dump. No "action(worker)"
 * kind labels. No raw "reads: [...] writes: [...] routes: X → Y".
 * Instead: plain prose descriptions that match how pi's built-in tools
 * talk about their own work (bash shows `$ command`, not "bash action").
 *
 * Collapsed: task header + one-line count summary. Two lines total.
 * Expanded: header + plain-English step list with each step's actor,
 * instruction, input/output artifact names (as `Uses:` / `Produces:`),
 * and branching routes only when there are multiple options.
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
		lines.push(`  ${theme.fg("muted", `success when: ${plan.successCriteria}`)}`);
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
	const actorNames = new Set<string>();
	for (const step of plan.steps) if (step.kind === "action") actorNames.add(step.actor);
	const agentList = actorNames.size > 0 ? Array.from(actorNames).join(", ") : "none";
	return `${plan.steps.length} steps · agents: ${agentList}`;
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
			return buildCheckBlock(step, index, theme);
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
		theme.fg("muted", `— ${step.actor}`);
	lines.push(header);

	// Instruction: the task-specific prompt the actor will see. This is the
	// single most important thing for review, so it's always shown and never
	// truncated. Each paragraph gets its own line so a multi-paragraph
	// instruction doesn't wrap into a blob.
	for (const paragraph of step.instruction.split("\n")) {
		lines.push(`     ${theme.fg("toolOutput", paragraph)}`);
	}

	// Only show uses/produces when non-empty — empty declarations would add
	// noise. Use plain-English labels instead of `reads:` / `writes:`.
	if (step.reads.length > 0) {
		lines.push(`     ${theme.fg("dim", `Uses: ${step.reads.join(", ")}`)}`);
	}
	if (step.writes.length > 0) {
		lines.push(`     ${theme.fg("dim", `Produces: ${step.writes.join(", ")}`)}`);
	}

	if (expanded) {
		if (step.routes.length === 1) {
			lines.push(`     ${theme.fg("dim", `→ ${step.routes[0]!.to}`)}`);
		} else if (step.routes.length > 1) {
			const branches = step.routes.map((r) => `${r.route} → ${r.to}`).join(", ");
			lines.push(`     ${theme.fg("dim", `Branches: ${branches}`)}`);
		}
		if (step.retry) {
			const plural = step.retry.maxAttempts === 1 ? "attempt" : "attempts";
			lines.push(`     ${theme.fg("dim", `Up to ${step.retry.maxAttempts} ${plural} on failure.`)}`);
		}
	}
	return lines;
};

const buildCheckBlock = (
	step: Extract<PlanDraftDoc["steps"][number], { kind: "check" }>,
	index: number,
	theme: Theme,
): string[] => {
	const lines: string[] = [];
	// Render check steps as the command/check they actually run, matching how
	// pi's built-in bash tool renders itself — no "check(command_exits_zero)"
	// kind label anywhere in the rendered output.
	const description = describeCheckForReview(step);
	lines.push(
		`  ${theme.fg("warning", `${index}.`)} ${theme.fg("toolTitle", step.id)}  ${theme.fg("toolOutput", description)}`,
	);
	lines.push(`     ${theme.fg("dim", `Pass → ${step.onPass}, fail → ${step.onFail}`)}`);
	return lines;
};

const buildTerminalBlock = (
	step: Extract<PlanDraftDoc["steps"][number], { kind: "terminal" }>,
	index: number,
	theme: Theme,
): string[] => {
	const color = step.outcome === "success" ? "success" : "error";
	const glyph = step.outcome === "success" ? "✓" : "✗";
	const header = `  ${theme.fg(color, `${index}.`)} ${theme.fg("toolTitle", step.id)} ${theme.fg(color, glyph)}`;
	const summary = `     ${theme.fg("dim", step.summary)}`;
	return [header, summary];
};

const describeCheckForReview = (step: Extract<PlanDraftDoc["steps"][number], { kind: "check" }>): string => {
	switch (step.check.kind) {
		case "file_exists":
			return `File exists: ${step.check.path}`;
		case "command_exits_zero": {
			const cmd = [step.check.command, ...step.check.args].join(" ");
			const cwdSuffix = step.check.cwd ? `  (cwd: ${step.check.cwd})` : "";
			const timeoutSuffix = step.check.timeoutMs ? `  (timeout ${Math.round(step.check.timeoutMs / 1000)}s)` : "";
			return `$ ${cmd}${cwdSuffix}${timeoutSuffix}`;
		}
	}
};
