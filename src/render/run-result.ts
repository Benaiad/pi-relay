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
import type { Step, TerminalOutcome } from "../plan/types.js";
import type { RelayRunState, StepRuntimeState } from "../runtime/events.js";
import type { AttemptOutcome, AttemptSummary, AttemptTimelineEntry } from "../runtime/run-report.js";
import { formatDuration, formatToolCall, joinNonEmpty, oneLine, truncate } from "./format.js";
import { iconFor, phaseLabel, runIcon, type StatusIcon } from "./icons.js";
import { formatUsageStats } from "./usage.js";

const EXPANDED_TRANSCRIPT_LIMIT = 15;
const ERROR_REASON_TRUNCATE = 800;

export const renderRunResult = (
	state: RelayRunState,
	timeline: readonly AttemptTimelineEntry[],
	theme: Theme,
	expanded: boolean,
	lastComponent: Component | undefined,
): Component => {
	if (expanded) return renderExpanded(state, timeline, theme);
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
	const skipped = countStatus(state, ["skipped"]);
	const executed = total - skipped;
	// Skipped is the only secondary count we surface in the collapsed status
	// — it explains why N/M doesn't match the plan's total step count when a
	// branching DAG skipped some failure paths. Re-entry count is NOT shown:
	// the glyph strip and expanded per-attempt blocks already express loops,
	// and "4 re-entries across 1 step" is counting artifact that nobody asked
	// for in a default summary.
	const skippedSuffix = skipped > 0 ? theme.fg("muted", ` · ${skipped} not reached`) : "";

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
			const summary = state.finalSummary ? theme.fg("toolOutput", truncate(state.finalSummary, 90)) : "";
			const stepCount = executed === 1 ? "1 step" : `${executed} steps`;
			const lead = theme.fg("muted", `completed ${stepCount}`);
			return summary ? `${lead} · ${summary}${skippedSuffix}` : `${lead}${skippedSuffix}`;
		}

		case "failed": {
			const failedStep = findFailedStep(state);
			const where = failedStep
				? theme.fg("error", `failed at ${unwrap(failedStep.stepId)}`)
				: theme.fg("error", "failed");
			const reason = failedStep?.runtime.lastReason
				? theme.fg("error", truncate(failedStep.runtime.lastReason, 90))
				: state.finalSummary
					? theme.fg("muted", truncate(state.finalSummary, 90))
					: "";
			return (reason ? `${where} · ${reason}` : where) + skippedSuffix;
		}

		case "aborted":
			return theme.fg("warning", `aborted after ${done} of ${executed} steps`) + skippedSuffix;

		case "incomplete":
			return (
				theme.fg("warning", `stopped before finishing (${done}/${executed} done without reaching an end state)`) +
				skippedSuffix
			);
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
// Expanded — chronological Container with one block per attempt
// ============================================================================

const renderExpanded = (state: RelayRunState, timeline: readonly AttemptTimelineEntry[], theme: Theme): Component => {
	const container = new Container();
	const mdTheme = getMarkdownTheme();

	container.addChild(new Text(buildHeader(state, theme), 0, 0));
	container.addChild(new Text(`  ${buildProgressLine(state, theme)}`, 0, 0));
	const footer = buildFooter(state, theme);
	if (footer.length > 0) container.addChild(new Text(`  ${footer}`, 0, 0));

	// Walk the timeline in chronological order and emit one block per
	// attempt. For a review/fix loop this renders as:
	//   create → review (attempt 1) → fix → review (attempt 2) → done
	// so the user sees the loop iterations in the order they actually ran.
	for (const entry of timeline) {
		const step = state.program.steps.get(entry.stepId);
		if (!step) continue;
		container.addChild(new Spacer(1));
		appendAttemptBlock(container, entry.stepId, step, entry.attempt, theme, mdTheme);
	}

	// Skipped steps are not in the timeline (they never ran). Surface them
	// as a footer tally so the user knows the DAG had branches that weren't
	// taken.
	const skippedIds: string[] = [];
	for (const stepId of state.program.stepOrder) {
		const runtime = state.steps.get(stepId);
		if (runtime?.status === "skipped") skippedIds.push(unwrap(stepId));
	}
	if (skippedIds.length > 0) {
		container.addChild(new Spacer(1));
		const preview = skippedIds.slice(0, 6).join(", ");
		const more = skippedIds.length > 6 ? ` + ${skippedIds.length - 6} more` : "";
		container.addChild(
			new Text(
				`${theme.fg("muted", `— ${skippedIds.length} step${skippedIds.length === 1 ? "" : "s"} skipped (not reached):`)} ${theme.fg("dim", `${preview}${more}`)}`,
				0,
				0,
			),
		);
	}

	return container;
};

const appendAttemptBlock = (
	container: Container,
	stepId: StepId,
	step: Step,
	attempt: AttemptSummary,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): void => {
	const icon = iconForAttemptOutcome(attempt.outcome, step);
	const id = unwrap(stepId);

	// Header: `─── ✓ stepId  — actor` (for actions) or `─── ✓ stepId`
	// (for checks and terminals). No "action(actor)" label. Retries are
	// marked `(retry)` or `(retry N)` for N > 2.
	const actorTag = step.kind === "action" ? `  ${theme.fg("muted", `— ${unwrap(step.actor)}`)}` : "";
	const retryTag =
		step.kind === "action" && attempt.attemptNumber > 1
			? `  ${theme.fg("warning", attempt.attemptNumber === 2 ? "(retry)" : `(retry ${attempt.attemptNumber - 1})`)}`
			: "";
	container.addChild(
		new Text(
			`${theme.fg("muted", "───")} ${theme.fg(icon.color, icon.glyph)} ${theme.fg("accent", id)}${actorTag}${retryTag}`,
			0,
			0,
		),
	);

	if (step.kind === "action") {
		// Action body: tool calls + final narration as Markdown. No
		// instruction echo (the user saw the plan preview already), no
		// per-step usage stats (aggregate lives in the run footer).
		const toolCallItems = attempt.transcript.filter(
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

		const finalText = extractFinalText(attempt.transcript);
		if (finalText.length > 0) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(finalText, 0, 0, mdTheme));
		}
	} else if (step.kind === "check") {
		// Check body: render the check as a `$ command` or `File exists:`
		// line, matching how bash tool renders itself.
		container.addChild(new Text(`  ${theme.fg("toolOutput", describeCheckInline(step))}`, 0, 0));
	} else if (step.kind === "terminal") {
		// Terminal body: just the summary prose, nothing else. The icon
		// already conveys success vs failure.
		container.addChild(new Text(`  ${theme.fg("toolOutput", truncate(step.summary, 240))}`, 0, 0));
	}

	// Outcome line. For completed actions we surface the route name only
	// when it's non-generic — "done" / "next" / "continue" are pure flow
	// glue and carry no meaning to a user. Action failures and check
	// failures show their reason in error color.
	if (attempt.outcome === "completed" && attempt.route) {
		const routeName = unwrap(attempt.route);
		if (!GENERIC_ROUTE_NAMES.has(routeName.toLowerCase())) {
			container.addChild(new Text(`  ${theme.fg("success", `→ ${routeName}`)}`, 0, 0));
		}
	} else if (attempt.outcome === "no_completion" || attempt.outcome === "engine_error") {
		container.addChild(
			new Text(`  ${theme.fg("error", `Failed: ${truncate(attempt.reason ?? "no reason", 240)}`)}`, 0, 0),
		);
	} else if (attempt.outcome === "check_fail") {
		container.addChild(
			new Text(`  ${theme.fg("error", `Failed: ${truncate(attempt.reason ?? "no reason", 240)}`)}`, 0, 0),
		);
	}
};

const GENERIC_ROUTE_NAMES = new Set(["done", "next", "continue", "ok", "success", "pass"]);

const describeCheckInline = (step: Extract<Step, { kind: "check" }>): string => {
	switch (step.check.kind) {
		case "file_exists":
			return `File exists: ${step.check.path}`;
		case "command_exits_zero":
			return `$ ${[step.check.command, ...step.check.args].join(" ")}`;
	}
};

const iconForAttemptOutcome = (outcome: AttemptOutcome, step: Step): StatusIcon => {
	switch (outcome) {
		case "completed":
			return iconFor("succeeded");
		case "no_completion":
		case "engine_error":
			return iconFor("failed");
		case "check_pass":
			return iconFor("succeeded");
		case "check_fail":
			return iconFor("failed");
		case "terminal": {
			const terminalOutcome: TerminalOutcome = step.kind === "terminal" ? step.outcome : "success";
			return iconFor(terminalOutcome === "success" ? "succeeded" : "failed");
		}
		case "open":
			return iconFor("running");
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

// Keep these imports referenced so the runtime-state-based helpers still
// compile even though the expanded renderer no longer uses them. They are
// used by `buildProgressLine` and friends.
const _keepRuntimeReferenced = (_s: StepRuntimeState): void => {
	void _s;
};
void _keepRuntimeReferenced;

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

const _describeStepKind = (step: Step): string => {
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
