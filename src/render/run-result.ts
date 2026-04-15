/**
 * Render the `RelayRunState` as a tool result body — pi `renderResult` hook.
 *
 * Single `Text` component reused via `context.lastComponent`. The whole
 * output is a string with embedded `\n` and theme colors, matching pi's
 * built-in tools (bash, read, grep, edit). No Container/Spacer composition.
 *
 * Layout:
 *
 *   Collapsed:
 *     <run icon> relay <task> — <phase label>
 *       <status line in muted>
 *
 *       <aligned step rows>
 *
 *       [<aggregate usage>]
 *
 *   Expanded:
 *     Same header + status + rows, plus per-step detail blocks below
 *     with instruction snippet, transcript tool calls, route taken, error
 *     reason if failed, and per-step usage.
 */

import { keyHint, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Text } from "@mariozechner/pi-tui";
import type { StepId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import type { Step } from "../plan/types.js";
import type { RelayRunState, StepRuntimeState } from "../runtime/events.js";
import { formatDuration, joinNonEmpty, maxWidth, oneLine, padRight, truncate } from "./format.js";
import { iconFor, phaseLabel, runIcon } from "./icons.js";
import { formatUsageStats } from "./usage.js";

const INLINE_TRANSCRIPT_LIMIT = 3;

export const renderRunResult = (
	state: RelayRunState,
	theme: Theme,
	expanded: boolean,
	lastComponent: Component | undefined,
): Component => {
	const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(expanded ? formatExpanded(state, theme) : formatCollapsed(state, theme));
	return text;
};

// ============================================================================
// Collapsed
// ============================================================================

const formatCollapsed = (state: RelayRunState, theme: Theme): string => {
	const lines: string[] = [];
	lines.push(buildHeader(state, theme));
	lines.push(`  ${theme.fg("muted", buildStatusLine(state))}`);
	lines.push("");

	const rows = state.program.stepOrder
		.map((id) => buildStepRow(id, state, theme))
		.filter((r): r is RenderedStepRow => r !== null);
	const idWidth = maxWidth(rows.map((r) => r.idPlain));
	const kindWidth = maxWidth(rows.map((r) => r.kindPlain));

	for (const row of rows) {
		const idPadded = padRight(row.idPlain, idWidth);
		const kindPadded = padRight(row.kindPlain, kindWidth);
		const name = row.nameColor ? theme.fg(row.nameColor, idPadded) : theme.fg("accent", idPadded);
		lines.push(`  ${row.marker} ${name}  ${theme.fg("muted", kindPadded)}  ${row.trailing}`);
	}

	const footer = buildFooter(state);
	if (footer.length > 0) {
		lines.push("");
		lines.push(`  ${theme.fg("muted", `[${footer}]`)}`);
	}

	if (state.phase !== "running" && state.phase !== "pending") {
		lines.push(`  ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`);
	}

	return lines.join("\n");
};

// ============================================================================
// Expanded
// ============================================================================

const formatExpanded = (state: RelayRunState, theme: Theme): string => {
	const lines: string[] = [];
	lines.push(buildHeader(state, theme));
	lines.push(`  ${theme.fg("muted", buildStatusLine(state))}`);
	const footer = buildFooter(state);
	if (footer.length > 0) lines.push(`  ${theme.fg("muted", `[${footer}]`)}`);

	for (const stepId of state.program.stepOrder) {
		const runtime = state.steps.get(stepId);
		const step = state.program.steps.get(stepId);
		if (!runtime || !step) continue;
		lines.push("");
		lines.push(...renderExpandedStepBlock(stepId, step, runtime, theme));
	}
	return lines.join("\n");
};

const renderExpandedStepBlock = (stepId: StepId, step: Step, runtime: StepRuntimeState, theme: Theme): string[] => {
	const lines: string[] = [];
	const icon = iconFor(runtime.status);
	const id = unwrap(stepId);
	const kindLabel = describeStepKind(step);
	const headerLine =
		`  ${theme.fg("muted", "───")} ${theme.fg(icon.color, icon.glyph)} ` +
		`${theme.fg("accent", id)}  ${theme.fg("muted", kindLabel)}`;
	lines.push(headerLine);

	if (step.kind === "action") {
		lines.push(`    ${theme.fg("dim", truncate(step.instruction, 200))}`);
		const transcriptLines = buildTranscriptLines(runtime, theme, Number.POSITIVE_INFINITY);
		for (const line of transcriptLines) lines.push(`    ${line}`);
	} else if (step.kind === "check") {
		lines.push(`    ${theme.fg("dim", describeCheck(step))}`);
	} else {
		lines.push(`    ${theme.fg("dim", `[${step.outcome}] ${truncate(step.summary, 160)}`)}`);
	}

	if (runtime.lastRoute) {
		lines.push(`    ${theme.fg("muted", `route: ${unwrap(runtime.lastRoute)}`)}`);
	}
	if (runtime.lastReason && (runtime.status === "failed" || runtime.status === "retrying")) {
		lines.push(`    ${theme.fg("error", `[error: ${truncate(runtime.lastReason, 200)}]`)}`);
	}
	if (runtime.attempts > 1) {
		lines.push(`    ${theme.fg("dim", `attempts: ${runtime.attempts}`)}`);
	}
	const stepUsage = formatUsageStats(runtime.usage);
	if (stepUsage.length > 0) lines.push(`    ${theme.fg("dim", `[${stepUsage}]`)}`);

	return lines;
};

// ============================================================================
// Shared building blocks
// ============================================================================

const buildHeader = (state: RelayRunState, theme: Theme): string => {
	const phase = runIcon(state.phase);
	const label = phaseLabel(state.phase);
	const labelColor = phase.color;
	const task = oneLine(state.program.task, 60);
	return (
		`${theme.fg(phase.color, phase.glyph)} ${theme.fg("toolTitle", theme.bold("relay"))} ` +
		`${theme.fg("accent", task)}  ${theme.fg("muted", "—")} ${theme.fg(labelColor, label)}`
	);
};

const buildStatusLine = (state: RelayRunState): string => {
	const total = state.program.stepOrder.length;
	const done = countStatus(state, ["succeeded"]);
	const failed = countStatus(state, ["failed"]);
	const running = countStatus(state, ["running"]);
	const retrying = countStatus(state, ["retrying"]);

	switch (state.phase) {
		case "pending":
			return `pending · ${total} steps`;
		case "running": {
			const pieces: string[] = [`${done}/${total} done`];
			if (running > 0) pieces.push(`${running} running`);
			if (retrying > 0) pieces.push(`${retrying} retrying`);
			return pieces.join(" · ");
		}
		case "succeeded":
			return `${done}/${total} steps succeeded`;
		case "failed":
			return `${failed} failed · ${done}/${total} steps finished`;
		case "aborted":
			return `aborted after ${done}/${total} steps`;
		case "incomplete":
			return `incomplete · ${done}/${total} steps ran without reaching a terminal`;
	}
};

const buildFooter = (state: RelayRunState): string =>
	joinNonEmpty(
		[
			state.startedAt && state.finishedAt
				? `Took ${formatDuration(state.finishedAt - state.startedAt)}`
				: state.startedAt && state.phase === "running"
					? `Elapsed ${formatDuration(Date.now() - state.startedAt)}`
					: null,
			formatUsageStats(state.totalUsage),
		],
		" · ",
	);

// ============================================================================
// Step rows (collapsed)
// ============================================================================

interface RenderedStepRow {
	readonly marker: string;
	readonly idPlain: string;
	readonly kindPlain: string;
	readonly trailing: string;
	readonly nameColor?: "accent" | "error" | "muted" | "success";
}

const buildStepRow = (stepId: StepId, state: RelayRunState, theme: Theme): RenderedStepRow | null => {
	const step = state.program.steps.get(stepId);
	const runtime = state.steps.get(stepId);
	if (!step || !runtime) return null;

	const icon = iconFor(runtime.status);
	const marker = theme.fg(icon.color, icon.glyph);
	const kindLabel = describeStepKind(step);
	const nameColor: RenderedStepRow["nameColor"] =
		runtime.status === "failed"
			? "error"
			: runtime.status === "succeeded"
				? "success"
				: runtime.status === "pending" || runtime.status === "ready"
					? "muted"
					: "accent";

	const trailing = buildStepRowTrailing(step, runtime, theme);

	return {
		marker,
		idPlain: unwrap(stepId),
		kindPlain: kindLabel,
		trailing,
		nameColor,
	};
};

const buildStepRowTrailing = (step: Step, runtime: StepRuntimeState, theme: Theme): string => {
	if (runtime.status === "failed" && runtime.lastReason) {
		return theme.fg("error", truncate(runtime.lastReason, 80));
	}
	if (runtime.status === "retrying" && runtime.lastReason) {
		return theme.fg("warning", `retrying: ${truncate(runtime.lastReason, 60)}`);
	}
	if (runtime.status === "running" && step.kind === "action") {
		const transcript = buildTranscriptLines(runtime, theme, INLINE_TRANSCRIPT_LIMIT);
		return transcript.length > 0 ? theme.fg("dim", "running · ") + transcript[0] : theme.fg("dim", "running");
	}
	if (runtime.status === "succeeded") {
		const route = runtime.lastRoute ? unwrap(runtime.lastRoute) : null;
		const usage = formatUsageStats(runtime.usage);
		return theme.fg("dim", joinNonEmpty([route ? `route: ${route}` : null, usage], " · "));
	}
	return "";
};

const buildTranscriptLines = (runtime: StepRuntimeState, theme: Theme, limit: number): string[] => {
	const lines: string[] = [];
	let count = 0;
	for (let i = runtime.transcript.length - 1; i >= 0 && count < limit; i -= 1) {
		const item = runtime.transcript[i];
		if (!item) continue;
		if (item.kind === "tool_call") {
			lines.unshift(theme.fg("muted", `→ ${item.toolName}`));
			count += 1;
		} else if (item.kind === "text" && item.text.trim().length > 0) {
			lines.unshift(theme.fg("toolOutput", truncate(item.text.trim().replace(/\s+/g, " "), 160)));
			count += 1;
		}
	}
	return lines;
};

const countStatus = (state: RelayRunState, statuses: readonly StepRuntimeState["status"][]): number => {
	let n = 0;
	for (const runtime of state.steps.values()) {
		if (statuses.includes(runtime.status)) n += 1;
	}
	return n;
};

const describeStepKind = (step: Step): string => {
	switch (step.kind) {
		case "action":
			return `action(${unwrap(step.actor)})`;
		case "check":
			return `check(${step.check.kind})`;
		case "terminal":
			return `terminal(${step.outcome})`;
	}
};

const describeCheck = (step: Extract<Step, { kind: "check" }>): string => {
	switch (step.check.kind) {
		case "file_exists":
			return `file_exists: ${step.check.path}`;
		case "command_exits_zero":
			return `command_exits_zero: ${[step.check.command, ...step.check.args].join(" ")}`;
	}
};
