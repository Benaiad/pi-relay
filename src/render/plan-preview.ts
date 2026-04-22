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
		case "command":
			return buildCommandBlock(step, index, theme);
		case "files_exist":
			return buildFilesExistBlock(step, index, theme);
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
	if (step.reads && step.reads.length > 0) {
		lines.push(`     ${theme.fg("dim", `Uses: ${step.reads.join(", ")}`)}`);
	}
	if (step.writes && step.writes.length > 0) {
		lines.push(`     ${theme.fg("dim", `Produces: ${step.writes.join(", ")}`)}`);
	}

	if (expanded) {
		const routeEntries = Object.entries(step.routes);
		if (routeEntries.length === 1) {
			lines.push(`     ${theme.fg("dim", `→ ${routeEntries[0]![1]}`)}`);
		} else if (routeEntries.length > 1) {
			const branches = routeEntries.map(([route, to]) => `${route} → ${to}`).join(", ");
			lines.push(`     ${theme.fg("dim", `Branches: ${branches}`)}`);
		}
	}
	return lines;
};

const buildCommandBlock = (
	step: Extract<PlanDraftDoc["steps"][number], { kind: "command" }>,
	index: number,
	theme: Theme,
): string[] => {
	const timeoutSuffix = step.timeoutMs ? `  (timeout ${Math.round(step.timeoutMs / 1000)}s)` : "";
	const description = `$ ${step.command}${timeoutSuffix}`;
	const lines = [
		`  ${theme.fg("warning", `${index}.`)} ${theme.fg("toolTitle", step.id)}  ${theme.fg("toolOutput", description)}`,
	];
	if (step.reads && step.reads.length > 0) {
		lines.push(`     ${theme.fg("dim", `Uses: ${step.reads.join(", ")}`)}`);
	}
	if (step.writes && step.writes.length > 0) {
		lines.push(`     ${theme.fg("dim", `Produces: ${step.writes.join(", ")}`)}`);
	}
	lines.push(`     ${theme.fg("dim", `Success → ${step.onSuccess}, failure → ${step.onFailure}`)}`);
	return lines;
};

const buildFilesExistBlock = (
	step: Extract<PlanDraftDoc["steps"][number], { kind: "files_exist" }>,
	index: number,
	theme: Theme,
): string[] => {
	const description =
		step.paths.length === 1 ? `File exists: ${step.paths[0]}` : `Files exist: ${step.paths.join(", ")}`;
	return [
		`  ${theme.fg("warning", `${index}.`)} ${theme.fg("toolTitle", step.id)}  ${theme.fg("toolOutput", description)}`,
		`     ${theme.fg("dim", `Success → ${step.onSuccess}, failure → ${step.onFailure}`)}`,
	];
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
