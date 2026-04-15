/**
 * Render the `RelayRunState` as a tool result body — pi `renderResult` hook.
 *
 * Two layouts, one per `expanded` state:
 *
 * Collapsed (3 rows max):
 *   1. Header:    <run icon> relay <task> — <phase label>
 *   2. Progress:  <glyph strip>  N/M done · <active step or final summary>
 *   3. Footer:    [elapsed/took · usage stats]
 *
 *   The glyph strip is one char per step, not a full table. The progress
 *   row also shows what the active step is currently doing via the same
 *   `formatToolCall` preview pi's built-in tools use. No per-step table.
 *
 * Expanded (Container with mixed children):
 *   Header + status + per-step blocks. Each step block has a divider, the
 *   actor instruction, the tool calls rendered via `formatToolCall`, the
 *   final assistant text rendered as actual markdown (so code blocks and
 *   headings survive), the route taken, and per-step usage in [brackets].
 *
 * The expanded view deliberately returns a `Container` with `Text` and
 * `Markdown` children — the only place in relay where we compose a tree,
 * because Markdown rendering genuinely wants its own component.
 */

import { getMarkdownTheme, keyHint, type Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { stripCompletionTag } from "../actors/complete-step.js";
import type { TranscriptItem } from "../actors/types.js";
import type { StepId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import type { Step } from "../plan/types.js";
import type { RelayRunState, StepRuntimeState } from "../runtime/events.js";
import { formatDuration, formatToolCall, joinNonEmpty, oneLine, truncate } from "./format.js";
import { iconFor, phaseLabel, runIcon } from "./icons.js";
import { formatUsageStats } from "./usage.js";

const EXPANDED_TRANSCRIPT_LIMIT = 15;
const ERROR_REASON_TRUNCATE = 800;

export const renderRunResult = (
	state: RelayRunState,
	theme: Theme,
	expanded: boolean,
	lastComponent: Component | undefined,
): Component => {
	if (expanded) return renderExpanded(state, theme);
	const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(formatCollapsed(state, theme));
	return text;
};

/**
 * Render a compile failure as its own result component.
 *
 * The plan is already visible above the result via `renderCall`, so we
 * don't repeat it — the failure component only carries the outcome label
 * and the compiler's formatted error, which names the offending step,
 * artifact, or actor and lists candidates where applicable.
 */
export const renderCompileFailure = (
	message: string,
	theme: Theme,
	lastComponent: Component | undefined,
): Component => {
	const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const lines = [
		`${theme.fg("error", "✗")} ${theme.fg("toolTitle", theme.bold("relay"))}  ${theme.fg("error", "compile failed")}`,
		"",
		...wrapReason(message, theme, "error"),
	];
	text.setText(lines.join("\n"));
	return text;
};

/**
 * Render a user-cancelled review as its own result component.
 *
 * Same rationale as `renderCompileFailure`: the plan is already visible
 * above, so we only show the outcome label and the cancel reason.
 */
export const renderCancelled = (reason: string, theme: Theme, lastComponent: Component | undefined): Component => {
	const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const lines = [
		`${theme.fg("warning", "⊘")} ${theme.fg("toolTitle", theme.bold("relay"))}  ${theme.fg("warning", "cancelled")}`,
		"",
		...wrapReason(reason, theme, "muted"),
	];
	text.setText(lines.join("\n"));
	return text;
};

/**
 * Render a user refinement request.
 *
 * The model is expected to resubmit a revised plan on its next turn.
 * The renderer shows the feedback so the user can read what they asked
 * for while the model is thinking.
 */
export const renderRefined = (feedback: string, theme: Theme, lastComponent: Component | undefined): Component => {
	const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
	const lines = [
		`${theme.fg("warning", "↻")} ${theme.fg("toolTitle", theme.bold("relay"))}  ${theme.fg("warning", "refinement requested")}`,
		"",
		`${theme.fg("muted", "Your feedback to the model:")}`,
		...wrapReason(feedback, theme, "toolOutput").map((line) => `  ${line}`),
		"",
		theme.fg("dim", "Waiting for the model to submit a revised plan."),
	];
	text.setText(lines.join("\n"));
	return text;
};

const wrapReason = (
	text: string,
	theme: Theme,
	color: "error" | "warning" | "muted" | "toolOutput" | "dim",
): string[] => {
	const limited = text.length > ERROR_REASON_TRUNCATE ? `${text.slice(0, ERROR_REASON_TRUNCATE)}…` : text;
	const paragraphs = limited.split("\n");
	return paragraphs.map((para) => `  ${theme.fg(color, para)}`);
};

// ============================================================================
// Collapsed — 3 rows max
// ============================================================================

const formatCollapsed = (state: RelayRunState, theme: Theme): string => {
	const lines: string[] = [];
	lines.push(buildHeader(state, theme));
	lines.push(`  ${buildProgressLine(state, theme)}`);

	const footer = buildFooter(state, theme);
	if (footer.length > 0) lines.push(`  ${footer}`);

	if (state.phase !== "running" && state.phase !== "pending" && hasExpandedDetail(state)) {
		const last = lines[lines.length - 1] ?? "";
		lines[lines.length - 1] = `${last}  ${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
	}

	return lines.join("\n");
};

const buildHeader = (state: RelayRunState, theme: Theme): string => {
	const phase = runIcon(state.phase);
	const label = phaseLabel(state.phase);
	const task = oneLine(state.program.task, 60);
	return (
		`${theme.fg(phase.color, phase.glyph)} ${theme.fg("toolTitle", theme.bold("relay"))} ` +
		`${theme.fg("accent", task)}  ${theme.fg("muted", "—")} ${theme.fg(phase.color, label)}`
	);
};

const buildProgressLine = (state: RelayRunState, theme: Theme): string => {
	const strip = buildGlyphStrip(state, theme);
	const detail = buildProgressDetail(state, theme);
	return `${strip}  ${detail}`;
};

const buildGlyphStrip = (state: RelayRunState, theme: Theme): string => {
	const glyphs: string[] = [];
	for (const stepId of state.program.stepOrder) {
		const runtime = state.steps.get(stepId);
		if (!runtime) continue;
		const icon = iconFor(runtime.status);
		glyphs.push(theme.fg(icon.color, icon.glyph));
	}
	return glyphs.join("");
};

const buildProgressDetail = (state: RelayRunState, theme: Theme): string => {
	const total = state.program.stepOrder.length;
	const done = countStatus(state, ["succeeded"]);

	switch (state.phase) {
		case "pending":
			return theme.fg("muted", `${total} steps pending`);

		case "running": {
			const active = findActiveStep(state);
			const prefix = theme.fg("muted", `${done}/${total} done`);
			if (!active) return prefix;
			const activeName = theme.fg("accent", unwrap(active.stepId));
			const activity = describeActiveStep(active.step, active.runtime, theme);
			const activityText = activity ? ` · ${activity}` : "";
			return `${prefix} · ${activeName}${activityText}`;
		}

		case "succeeded": {
			const summary = state.finalSummary ? theme.fg("toolOutput", truncate(state.finalSummary, 70)) : "";
			return `${theme.fg("muted", `all ${total} steps`)}${summary ? ` · ${summary}` : ""}`;
		}

		case "failed": {
			const failedStep = findFailedStep(state);
			const where = failedStep
				? theme.fg("error", `failed at ${unwrap(failedStep.stepId)}`)
				: theme.fg("error", "failed");
			const reason = failedStep?.runtime.lastReason
				? theme.fg("error", truncate(failedStep.runtime.lastReason, 80))
				: state.finalSummary
					? theme.fg("muted", truncate(state.finalSummary, 80))
					: "";
			return reason ? `${where} · ${reason}` : where;
		}

		case "aborted":
			return theme.fg("warning", `aborted after ${done}/${total}`);

		case "incomplete":
			return theme.fg("warning", `incomplete · ran ${done}/${total} steps without reaching a terminal`);
	}
};

const buildFooter = (state: RelayRunState, theme: Theme): string => {
	const bits: (string | null)[] = [];
	if (state.startedAt && state.finishedAt) {
		bits.push(`took ${formatDuration(state.finishedAt - state.startedAt)}`);
	} else if (state.startedAt && state.phase === "running") {
		bits.push(`elapsed ${formatDuration(Date.now() - state.startedAt)}`);
	}
	const usage = formatUsageStats(state.totalUsage);
	if (usage.length > 0) bits.push(usage);
	const joined = joinNonEmpty(bits, " · ");
	return joined.length > 0 ? theme.fg("muted", `[${joined}]`) : "";
};

// ============================================================================
// Expanded — Container with Text + Markdown per step
// ============================================================================

const renderExpanded = (state: RelayRunState, theme: Theme): Component => {
	const container = new Container();
	const mdTheme = getMarkdownTheme();

	container.addChild(new Text(buildHeader(state, theme), 0, 0));
	container.addChild(new Text(`  ${buildProgressLine(state, theme)}`, 0, 0));
	const footer = buildFooter(state, theme);
	if (footer.length > 0) container.addChild(new Text(`  ${footer}`, 0, 0));

	for (const stepId of state.program.stepOrder) {
		const runtime = state.steps.get(stepId);
		const step = state.program.steps.get(stepId);
		if (!runtime || !step) continue;
		// Skip pending / ready steps in the expanded view — they have nothing to show.
		if (runtime.status === "pending" || runtime.status === "ready") continue;
		container.addChild(new Spacer(1));
		appendExpandedStepBlock(container, stepId, step, runtime, theme, mdTheme);
	}

	return container;
};

const appendExpandedStepBlock = (
	container: Container,
	stepId: StepId,
	step: Step,
	runtime: StepRuntimeState,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): void => {
	const icon = iconFor(runtime.status);
	const id = unwrap(stepId);
	const kindLabel = describeStepKind(step);
	container.addChild(
		new Text(
			`${theme.fg("muted", "───")} ${theme.fg(icon.color, icon.glyph)} ${theme.fg("accent", id)}  ${theme.fg("muted", kindLabel)}`,
			0,
			0,
		),
	);

	if (step.kind === "action") {
		container.addChild(new Text(`  ${theme.fg("dim", truncate(step.instruction, 400))}`, 0, 0));

		const toolCallItems = runtime.transcript.filter(
			(item): item is Extract<TranscriptItem, { kind: "tool_call" }> => item.kind === "tool_call",
		);
		const shownToolCalls = toolCallItems.slice(-EXPANDED_TRANSCRIPT_LIMIT);
		const skippedToolCalls = toolCallItems.length - shownToolCalls.length;
		if (skippedToolCalls > 0) {
			container.addChild(new Text(`  ${theme.fg("muted", `... ${skippedToolCalls} earlier tool calls`)}`, 0, 0));
		}
		for (const tc of shownToolCalls) {
			container.addChild(
				new Text(`  ${theme.fg("muted", "→ ")}${formatToolCall(tc.toolName, tc.args, theme)}`, 0, 0),
			);
		}

		const finalText = extractFinalText(runtime.transcript);
		if (finalText.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalText, 0, 0, mdTheme));
		}
	} else if (step.kind === "check") {
		container.addChild(new Text(`  ${theme.fg("dim", describeCheck(step))}`, 0, 0));
	} else {
		container.addChild(new Text(`  ${theme.fg("dim", `[${step.outcome}] ${truncate(step.summary, 200)}`)}`, 0, 0));
	}

	if (runtime.lastRoute) {
		container.addChild(new Text(`  ${theme.fg("muted", `route: ${unwrap(runtime.lastRoute)}`)}`, 0, 0));
	}
	if (runtime.lastReason && (runtime.status === "failed" || runtime.status === "retrying")) {
		container.addChild(new Text(`  ${theme.fg("error", `[error: ${truncate(runtime.lastReason, 200)}]`)}`, 0, 0));
	}
	if (runtime.attempts > 1) {
		container.addChild(new Text(`  ${theme.fg("dim", `attempts: ${runtime.attempts}`)}`, 0, 0));
	}
	const stepUsage = formatUsageStats(runtime.usage);
	if (stepUsage.length > 0) {
		container.addChild(new Text(`  ${theme.fg("dim", `[${stepUsage}]`)}`, 0, 0));
	}
};

// ============================================================================
// Helpers
// ============================================================================

const findActiveStep = (state: RelayRunState): { stepId: StepId; step: Step; runtime: StepRuntimeState } | null => {
	for (const stepId of state.program.stepOrder) {
		const runtime = state.steps.get(stepId);
		const step = state.program.steps.get(stepId);
		if (!runtime || !step) continue;
		if (runtime.status === "running" || runtime.status === "retrying") {
			return { stepId, step, runtime };
		}
	}
	return null;
};

const findFailedStep = (state: RelayRunState): { stepId: StepId; runtime: StepRuntimeState } | null => {
	for (const stepId of state.program.stepOrder) {
		const runtime = state.steps.get(stepId);
		if (!runtime) continue;
		if (runtime.status === "failed") return { stepId, runtime };
	}
	return null;
};

const describeActiveStep = (step: Step, runtime: StepRuntimeState, theme: Theme): string => {
	if (step.kind === "check") return theme.fg("dim", describeCheck(step));
	if (step.kind === "terminal") return theme.fg("dim", `[${step.outcome}]`);
	const lastCall = [...runtime.transcript]
		.reverse()
		.find((item): item is Extract<TranscriptItem, { kind: "tool_call" }> => item.kind === "tool_call");
	if (lastCall) return formatToolCall(lastCall.toolName, lastCall.args, theme);
	const lastText = [...runtime.transcript]
		.reverse()
		.find((item): item is Extract<TranscriptItem, { kind: "text" }> => item.kind === "text");
	if (lastText) {
		const cleaned = stripCompletionTag(lastText.text).replace(/\s+/g, " ");
		if (cleaned.length > 0) return theme.fg("dim", truncate(cleaned, 80));
	}
	return "";
};

const extractFinalText = (transcript: readonly TranscriptItem[]): string => {
	const parts: string[] = [];
	for (const item of transcript) {
		if (item.kind === "text" && item.text.trim().length > 0) parts.push(item.text);
	}
	return stripCompletionTag(parts.join("\n"));
};

const countStatus = (state: RelayRunState, statuses: readonly StepRuntimeState["status"][]): number => {
	let n = 0;
	for (const runtime of state.steps.values()) {
		if (statuses.includes(runtime.status)) n += 1;
	}
	return n;
};

const hasExpandedDetail = (state: RelayRunState): boolean => {
	for (const runtime of state.steps.values()) {
		if (runtime.transcript.length > 0) return true;
		if (runtime.status === "failed" || runtime.status === "succeeded") return true;
	}
	return false;
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
