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

import { getMarkdownTheme, keyHint, type Theme, truncateToVisualLines } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Markdown, Spacer, Text, truncateToWidth } from "@mariozechner/pi-tui";
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
const CHECK_OUTPUT_PREVIEW_LINES = 5;
const ERROR_REASON_TRUNCATE = 800;

export const renderRunResult = (
	state: RelayRunState,
	timeline: readonly AttemptTimelineEntry[],
	theme: Theme,
	expanded: boolean,
	lastComponent: Component | undefined,
	checkOutput?: ReadonlyMap<StepId, string>,
): Component => {
	if (expanded) return renderExpanded(state, timeline, theme, checkOutput);
	const text = (lastComponent as Text | undefined) ?? new Text("", 0, 0);
	text.setText(formatCollapsed(state, theme, checkOutput));
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

const formatCollapsed = (state: RelayRunState, theme: Theme, checkOutput?: ReadonlyMap<StepId, string>): string => {
	const lines: string[] = [];
	lines.push(buildHeader(state, theme));
	lines.push(`  ${buildProgressLine(state, theme, checkOutput)}`);

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

const buildProgressLine = (state: RelayRunState, theme: Theme, checkOutput?: ReadonlyMap<StepId, string>): string => {
	const strip = buildGlyphStrip(state, theme);
	const detail = buildProgressDetail(state, theme, checkOutput);
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

const buildProgressDetail = (state: RelayRunState, theme: Theme, checkOutput?: ReadonlyMap<StepId, string>): string => {
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
			const activity = describeActiveStep(active.step, active.runtime, theme, checkOutput?.get(active.stepId));
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

const renderExpanded = (
	state: RelayRunState,
	timeline: readonly AttemptTimelineEntry[],
	theme: Theme,
	checkOutput?: ReadonlyMap<StepId, string>,
): Component => {
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
		appendAttemptBlock(container, entry.stepId, step, entry.attempt, theme, mdTheme, checkOutput?.get(entry.stepId));
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
	liveCheckOutput?: string,
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
		// Action body: walk the transcript in its natural chronological order
		// and interleave text narration with tool calls. This captures the
		// actor's actual thought flow: "I'll add lang. → read → edit → Let me
		// verify. → read" rather than "read read edit read. All the text at
		// the end." The final text chunk gets Markdown rendering for code
		// blocks and headings; mid-reply text renders as plain truncated
		// lines for compactness.
		renderActionTranscript(container, attempt.transcript, theme, mdTheme);
	} else if (step.kind === "check") {
		container.addChild(new Text(`  ${theme.fg("toolOutput", describeCheckInline(step))}`, 0, 0));
		if (liveCheckOutput && liveCheckOutput.length > 0) {
			appendCheckOutputPreview(container, liveCheckOutput, theme);
		}
	} else if (step.kind === "terminal") {
		// Terminal body: the full summary prose. The icon already conveys
		// success vs failure; no need for a kind label or truncation.
		container.addChild(new Text(`  ${theme.fg("toolOutput", step.summary)}`, 0, 0));
	}

	// Outcome line. For completed actions we surface the route name only
	// when it's non-generic — "done" / "next" / "continue" are pure flow
	// glue and carry no meaning to a user. Action failures and check
	// failures show their reason in error color — full reason, no truncation.
	if (attempt.outcome === "completed" && attempt.route) {
		const routeName = unwrap(attempt.route);
		if (!GENERIC_ROUTE_NAMES.has(routeName.toLowerCase())) {
			container.addChild(new Text(`  ${theme.fg("success", `→ ${routeName}`)}`, 0, 0));
		}
	} else if (attempt.outcome === "no_completion" || attempt.outcome === "engine_error") {
		container.addChild(new Text(`  ${theme.fg("error", `Failed: ${attempt.reason ?? "no reason"}`)}`, 0, 0));
	} else if (attempt.outcome === "check_fail") {
		container.addChild(new Text(`  ${theme.fg("error", `Failed: ${attempt.reason ?? "no reason"}`)}`, 0, 0));
	}
};

/**
 * Walk an attempt's transcript in chronological order and emit interleaved
 * tool-call and text lines into the container.
 *
 * Design notes:
 *
 * - Tool calls always render as `→ <formatToolCall>`, matching pi's own
 *   built-in tool header style.
 * - Text chunks that appear mid-reply (before or between tool calls, but
 *   NOT the final chunk) render as plain truncated `toolOutput`-colored
 *   lines. Markdown features are stripped implicitly because the lines go
 *   through plain `Text` components.
 * - The FINAL text chunk in the transcript (if it comes after every tool
 *   call) renders as a `Markdown` block so code blocks, headings, and
 *   lists in the actor's wrap-up reply survive. Gets a leading `Spacer`
 *   to visually separate it from the interleaved log above.
 * - If the transcript ends with a tool call, there is no final text and
 *   everything renders inline.
 * - Text chunks are split on `\n` and empty lines are dropped so a
 *   multi-paragraph narration doesn't become one long wrapped blob.
 * - Completion tags are stripped before rendering anywhere.
 *
 * Tool calls are capped at `EXPANDED_TRANSCRIPT_LIMIT`; if exceeded, the
 * earliest calls are dropped and a `(N earlier tool calls)` line is shown
 * at the top. We do not cap text chunks — actor narration is almost always
 * short and losing it hurts comprehension.
 */
const renderActionTranscript = (
	container: Container,
	transcript: readonly TranscriptItem[],
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): void => {
	// Find the last text chunk's index iff it's ALSO the last item in the
	// transcript. That's the "final reply" slot; everything else is
	// mid-reply commentary rendered inline.
	let finalTextIndex = -1;
	if (transcript.length > 0) {
		const last = transcript[transcript.length - 1];
		if (last?.kind === "text" && stripCompletionTag(last.text).trim().length > 0) {
			finalTextIndex = transcript.length - 1;
		}
	}

	// Drop the oldest tool calls if we're over the display cap. We count
	// tool calls only (not text) so a chatty actor with many narrations
	// isn't penalized.
	const toolCallPositions: number[] = [];
	transcript.forEach((item, idx) => {
		if (item.kind === "tool_call") toolCallPositions.push(idx);
	});
	const droppedToolCalls = Math.max(0, toolCallPositions.length - EXPANDED_TRANSCRIPT_LIMIT);
	const droppedToolCallIndices = new Set(toolCallPositions.slice(0, droppedToolCalls));
	if (droppedToolCalls > 0) {
		container.addChild(new Text(`  ${theme.fg("muted", `(${droppedToolCalls} earlier tool calls)`)}`, 0, 0));
	}

	for (let i = 0; i < transcript.length; i += 1) {
		const item = transcript[i];
		if (!item) continue;
		if (droppedToolCallIndices.has(i)) continue;

		if (item.kind === "tool_call") {
			container.addChild(
				new Text(`  ${theme.fg("muted", "→ ")}${formatToolCall(item.toolName, item.args, theme)}`, 0, 0),
			);
			continue;
		}

		// Text item. The final one (after every tool call) gets Markdown
		// treatment; mid-reply chunks get inline plain-text treatment.
		const cleaned = stripCompletionTag(item.text).trim();
		if (cleaned.length === 0) continue;

		if (i === finalTextIndex) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(cleaned, 0, 0, mdTheme));
			continue;
		}

		// Emit text lines unwrapped — the TUI Text component handles
		// width-aware wrapping, and artificial truncation here only cuts
		// mid-sentence and loses information.
		for (const rawLine of cleaned.split("\n")) {
			const line = rawLine.trim();
			if (line.length === 0) continue;
			container.addChild(new Text(`  ${theme.fg("toolOutput", line)}`, 0, 0));
		}
	}
};

const appendCheckOutputPreview = (container: Container, output: string, theme: Theme): void => {
	const styledOutput = output
		.split("\n")
		.map((line) => theme.fg("toolOutput", line))
		.join("\n");

	container.addChild({
		render: (width: number) => {
			const preview = truncateToVisualLines(styledOutput, CHECK_OUTPUT_PREVIEW_LINES, width);
			const lines: string[] = [""];
			if (preview.skippedCount > 0) {
				const hint =
					theme.fg("muted", `... (${preview.skippedCount} earlier lines,`) +
					` ${keyHint("app.tools.expand", "to expand")})`;
				lines.push(truncateToWidth(hint, width, "..."));
			}
			lines.push(...preview.visualLines);
			return lines;
		},
		invalidate: () => {},
	});
};

const GENERIC_ROUTE_NAMES = new Set(["done", "next", "continue", "ok", "success", "pass"]);

const describeCheckInline = (step: Extract<Step, { kind: "check" }>): string => {
	switch (step.check.kind) {
		case "file_exists":
			return `File exists: ${step.check.path}`;
		case "command_exits_zero":
			return `$ ${step.check.command}`;
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

const describeActiveStep = (step: Step, runtime: StepRuntimeState, theme: Theme, liveCheckOutput?: string): string => {
	if (step.kind === "check") {
		const lastLine = lastNonEmptyLine(liveCheckOutput);
		if (lastLine) return theme.fg("toolOutput", truncate(lastLine, 80));
		return theme.fg("dim", describeCheck(step));
	}
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

const describeCheck = (step: Extract<Step, { kind: "check" }>): string => {
	switch (step.check.kind) {
		case "file_exists":
			return `file_exists: ${step.check.path}`;
		case "command_exits_zero":
			return `command_exits_zero: ${step.check.command}`;
	}
};

const lastNonEmptyLine = (text: string | undefined): string | undefined => {
	if (!text) return undefined;
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i]?.trim();
		if (line && line.length > 0) return line;
	}
	return undefined;
};
