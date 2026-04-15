/**
 * Render the `RelayRunState` for the `renderResult` hook.
 *
 * `renderResult` fires every time `onUpdate` publishes a new snapshot, plus
 * once on final completion. The function branches on run phase and builds a
 * collapsed or expanded Component tree. While running, we show a status
 * banner plus a live step-icon strip. On completion, we switch to a full
 * per-step breakdown in the expanded view, matching subagent's chain/parallel
 * expanded views.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Spacer, Text } from "@mariozechner/pi-tui";
import type { StepId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import type { Step } from "../plan/types.js";
import type { RelayRunState, StepRuntimeState } from "../runtime/events.js";
import { formatDuration, joinNonEmpty, truncate } from "./format.js";
import { iconFor, runIcon } from "./icons.js";
import { formatUsageStats } from "./usage.js";

export const renderRunResult = (state: RelayRunState, theme: Theme, expanded: boolean): Component => {
	if (!expanded) return renderCollapsed(state, theme);
	return renderExpanded(state, theme);
};

// ============================================================================
// Collapsed view
// ============================================================================

const renderCollapsed = (state: RelayRunState, theme: Theme): Component => {
	const phaseIcon = runIcon(state.phase);
	const header = `${theme.fg(phaseIcon.color, phaseIcon.glyph)} ${theme.fg("toolTitle", theme.bold("relay "))}${theme.fg("accent", truncate(state.program.task, 60))}`;
	const summary = `${theme.fg("muted", buildStatusLine(state))}`;
	const strip = renderStepStrip(state, theme);
	const usage = formatUsageStats(state.totalUsage);
	const footer = joinNonEmpty(
		[
			state.startedAt && state.finishedAt ? formatDuration(state.finishedAt - state.startedAt) : null,
			usage.length > 0 ? usage : null,
		],
		" · ",
	);
	const footerLine = footer.length > 0 ? `\n  ${theme.fg("dim", footer)}` : "";
	const hint = state.phase === "running" ? "" : `\n  ${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(`${header}\n  ${summary}\n  ${strip}${footerLine}${hint}`, 0, 0);
};

const buildStatusLine = (state: RelayRunState): string => {
	const total = state.program.stepOrder.length;
	const done = countStatus(state, ["succeeded"]);
	const failed = countStatus(state, ["failed"]);
	const running = countStatus(state, ["running"]);
	const retrying = countStatus(state, ["retrying"]);

	switch (state.phase) {
		case "pending":
			return `pending: ${total} steps`;
		case "running": {
			const pieces: string[] = [`${done}/${total} done`];
			if (running > 0) pieces.push(`${running} running`);
			if (retrying > 0) pieces.push(`${retrying} retrying`);
			return pieces.join(", ");
		}
		case "succeeded":
			return `${done}/${total} steps · ${state.finalSummary ?? "complete"}`;
		case "failed":
			return `${failed || "—"} failed · ${state.finalSummary ?? "failed"}`;
		case "aborted":
			return `aborted at ${done}/${total} steps`;
		case "incomplete":
			return `incomplete: ran ${done}/${total} steps without reaching a terminal`;
	}
};

const renderStepStrip = (state: RelayRunState, theme: Theme): string => {
	const parts: string[] = [];
	for (const stepId of state.program.stepOrder) {
		const runtime = state.steps.get(stepId);
		if (!runtime) continue;
		const icon = iconFor(runtime.status);
		parts.push(theme.fg(icon.color, icon.glyph));
	}
	return parts.join("");
};

const countStatus = (state: RelayRunState, statuses: readonly StepRuntimeState["status"][]): number => {
	let n = 0;
	for (const runtime of state.steps.values()) {
		if (statuses.includes(runtime.status)) n += 1;
	}
	return n;
};

// ============================================================================
// Expanded view
// ============================================================================

const renderExpanded = (state: RelayRunState, theme: Theme): Component => {
	const container = new Container();
	const phaseIcon = runIcon(state.phase);
	container.addChild(
		new Text(
			`${theme.fg(phaseIcon.color, phaseIcon.glyph)} ${theme.fg("toolTitle", theme.bold("relay "))}${theme.fg("accent", state.program.task)}`,
			0,
			0,
		),
	);
	container.addChild(new Text(theme.fg("muted", buildStatusLine(state)), 0, 0));
	if (state.finalSummary && state.finalSummary !== state.program.task) {
		container.addChild(new Text(theme.fg("muted", state.finalSummary), 0, 0));
	}
	const usage = formatUsageStats(state.totalUsage);
	if (usage.length > 0) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	container.addChild(new Spacer(1));

	for (const stepId of state.program.stepOrder) {
		const step = state.program.steps.get(stepId);
		const runtime = state.steps.get(stepId);
		if (!step || !runtime) continue;
		appendStepBlock(container, stepId, step, runtime, theme);
	}
	return container;
};

const appendStepBlock = (
	container: Container,
	stepId: StepId,
	step: Step,
	runtime: StepRuntimeState,
	theme: Theme,
): void => {
	const icon = iconFor(runtime.status);
	const id = unwrap(stepId);
	const kindLabel = step.kind === "action" ? `[${unwrap(step.actor)}]` : `[${step.kind}]`;
	const header = `${theme.fg("muted", "─── ")}${theme.fg(icon.color, icon.glyph)} ${theme.fg("toolTitle", id)} ${theme.fg("muted", kindLabel)}`;
	container.addChild(new Text(header, 0, 0));

	if (step.kind === "action") {
		container.addChild(new Text(theme.fg("dim", truncate(step.instruction, 200)), 0, 0));
		for (const item of runtime.transcript) {
			if (item.kind === "tool_call") {
				container.addChild(new Text(theme.fg("muted", `→ ${item.toolName}`), 0, 0));
			} else if (item.kind === "text" && item.text.length > 0) {
				container.addChild(new Text(theme.fg("toolOutput", truncate(item.text, 160)), 0, 0));
			}
		}
	} else if (step.kind === "check") {
		container.addChild(new Text(theme.fg("dim", `check: ${step.check.kind}`), 0, 0));
	} else {
		container.addChild(new Text(theme.fg("dim", `terminal[${step.outcome}]: ${step.summary}`), 0, 0));
	}

	if (runtime.lastRoute) {
		container.addChild(new Text(theme.fg("muted", `route: ${unwrap(runtime.lastRoute)}`), 0, 0));
	}
	if (runtime.lastReason && (runtime.status === "failed" || runtime.status === "retrying")) {
		container.addChild(new Text(theme.fg("error", `error: ${truncate(runtime.lastReason, 200)}`), 0, 0));
	}

	const stepUsage = formatUsageStats(runtime.usage);
	if (stepUsage.length > 0) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));

	if (runtime.attempts > 1) {
		container.addChild(new Text(theme.fg("dim", `attempts: ${runtime.attempts}`), 0, 0));
	}

	container.addChild(new Spacer(1));
};
