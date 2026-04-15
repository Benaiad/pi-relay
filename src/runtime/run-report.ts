/**
 * Final run report.
 *
 * The report is what `relay` returns to pi as the tool result. It is built
 * from two sources: the final `RelayRunState` snapshot (for per-step status,
 * counts, and aggregate usage), and the `AuditLog` (for per-attempt history,
 * which the run state no longer retains — see `events.ts` for why re-entered
 * steps reset their transcript).
 *
 * The content text the model reads is produced by `renderRunReportText` and
 * is the ONE surface the outer assistant uses to understand what happened.
 * It must include enough structure that the model can narrate the loop —
 * every attempt, every route taken, every actor's final reply — without
 * guessing. The TUI's `renderResult` is a separate concern and gets its
 * data from `details.state`.
 */

import { stripCompletionTag } from "../actors/complete-step.js";
import type { ActorUsage, TranscriptItem } from "../actors/types.js";
import { emptyUsage } from "../actors/types.js";
import type { ArtifactId, PlanId, RouteId, StepId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import type { Step, TerminalOutcome } from "../plan/types.js";
import type { AuditLog } from "./audit.js";
import type { RelayEvent, RelayRunState, RunPhase, StepStatus } from "./events.js";

export type RunOutcome = "success" | "failure" | "aborted" | "incomplete";

/**
 * Outcome of a single attempt of a step.
 *
 *   - `completed`      → action step emitted a route cleanly
 *   - `no_completion`  → actor ran but did not produce a valid completion block
 *   - `engine_error`   → actor engine itself failed (subprocess exit, abort, etc.)
 *   - `check_pass`     → deterministic check returned pass
 *   - `check_fail`     → deterministic check returned fail with a reason
 *   - `terminal`       → terminal step was reached
 *   - `open`           → attempt started but never closed (cut off by abort or crash)
 */
export type AttemptOutcome =
	| "completed"
	| "no_completion"
	| "engine_error"
	| "check_pass"
	| "check_fail"
	| "terminal"
	| "open";

/**
 * One activation of a step, reconstructed from the audit log.
 *
 * A step with `attemptCount = 1` has one `AttemptSummary`. A re-entered step
 * has one per activation, in chronological order.
 */
export interface AttemptSummary {
	readonly attemptNumber: number;
	readonly outcome: AttemptOutcome;
	readonly route?: RouteId;
	readonly reason?: string;
	readonly transcript: readonly TranscriptItem[];
	readonly usage: ActorUsage;
	readonly startedAt?: number;
	readonly finishedAt?: number;
}

export interface StepSummary {
	readonly stepId: StepId;
	readonly kind: Step["kind"];
	readonly status: StepStatus;
	readonly attemptCount: number;
	readonly attempts: readonly AttemptSummary[];
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly durationMs?: number;
	readonly lastRoute?: RouteId;
	readonly lastReason?: string;
	readonly usage: ActorUsage;
}

export interface ArtifactSummary {
	readonly artifactId: ArtifactId;
	readonly writerStep: StepId;
	readonly description: string;
}

export interface RunReport {
	readonly planId: PlanId;
	readonly task: string;
	readonly outcome: RunOutcome;
	readonly terminalOutcome?: TerminalOutcome;
	readonly summary: string;
	readonly durationMs: number;
	readonly steps: readonly StepSummary[];
	/**
	 * Chronological attempt timeline reconstructed from the audit log.
	 *
	 * `steps` groups attempts by step id (plan order); `timeline` walks
	 * the audit in execution order and shows each attempt as its own
	 * entry. For a review/fix loop `steps` has two entries (`review`,
	 * `fix`) while `timeline` has four (`review#1`, `fix#1`, `review#2`,
	 * `fix#2`). Text rendering uses the timeline so the model sees the
	 * loop the way it actually ran.
	 */
	readonly timeline: readonly AttemptTimelineEntry[];
	readonly artifacts: readonly ArtifactSummary[];
	readonly usage: ActorUsage;
	readonly totalActivations: number;
}

export const phaseToOutcome = (phase: RunPhase): RunOutcome => {
	switch (phase) {
		case "succeeded":
			return "success";
		case "failed":
			return "failure";
		case "aborted":
			return "aborted";
		case "incomplete":
		case "pending":
		case "running":
			return "incomplete";
	}
};

export const buildRunReport = (state: RelayRunState, audit: AuditLog): RunReport => {
	const { program } = state;
	const events = audit.entries();
	const timeline = buildAttemptTimeline(events);
	const attemptHistories = buildAttemptHistories(events);
	const steps = program.stepOrder.map((id) => buildStepSummary(id, state, attemptHistories.get(id) ?? []));
	const artifacts = buildArtifactSummaries(state);
	const outcome = phaseToOutcome(state.phase);
	const durationMs = state.startedAt && state.finishedAt ? state.finishedAt - state.startedAt : 0;
	const summary = buildSummary(state, outcome);
	const totalActivations = steps.reduce((acc, s) => acc + s.attemptCount, 0);
	return {
		planId: program.id,
		task: program.task,
		outcome,
		terminalOutcome: state.finalOutcome,
		summary,
		durationMs,
		steps,
		timeline,
		artifacts,
		usage: state.totalUsage,
		totalActivations,
	};
};

const buildStepSummary = (stepId: StepId, state: RelayRunState, attempts: readonly AttemptSummary[]): StepSummary => {
	const runtime = state.steps.get(stepId);
	const step = state.program.steps.get(stepId);
	if (!runtime || !step) {
		throw new Error(`invariant: step '${unwrap(stepId)}' missing from run state or program`);
	}
	return {
		stepId,
		kind: step.kind,
		status: runtime.status,
		attemptCount: runtime.attempts,
		attempts,
		startedAt: runtime.startedAt,
		finishedAt: runtime.finishedAt,
		durationMs:
			runtime.startedAt !== undefined && runtime.finishedAt !== undefined
				? runtime.finishedAt - runtime.startedAt
				: undefined,
		lastRoute: runtime.lastRoute,
		lastReason: runtime.lastReason,
		usage: runtime.usage,
	};
};

const buildArtifactSummaries = (state: RelayRunState): ArtifactSummary[] => {
	const summaries: ArtifactSummary[] = [];
	for (const artifactId of state.committedArtifacts) {
		const contract = state.program.artifacts.get(artifactId);
		const writer = state.program.writers.get(artifactId);
		if (!contract || !writer) continue;
		summaries.push({ artifactId, writerStep: writer, description: contract.description });
	}
	return summaries;
};

const buildSummary = (state: RelayRunState, outcome: RunOutcome): string => {
	if (state.finalSummary && state.finalSummary.length > 0) return state.finalSummary;
	const program = state.program;
	switch (outcome) {
		case "success":
			return `Plan '${program.task}' completed successfully.`;
		case "failure":
			return `Plan '${program.task}' failed.`;
		case "aborted":
			return `Plan '${program.task}' was aborted by the user.`;
		case "incomplete":
			return `Plan '${program.task}' finished without reaching a terminal step.`;
	}
};

// ============================================================================
// Audit log → per-attempt history
// ============================================================================

interface OpenAttempt {
	readonly attemptNumber: number;
	readonly startedAt: number;
	readonly transcript: TranscriptItem[];
	usage: ActorUsage;
}

/**
 * Walk the audit log in order and reconstruct per-step attempt histories.
 *
 * Bucket events by stepId. On `step_started`, open a new attempt record for
 * that step. On `action_progress`, append to the open attempt's transcript.
 * On a closing event (`action_completed`, `action_no_completion`,
 * `action_engine_error`, `check_passed`, `check_failed`, `terminal_reached`),
 * finalize the open attempt and push it into the step's history list. If the
 * run is aborted mid-step, leave the open attempt as `outcome: "open"` so
 * the renderer can show it.
 */
/**
 * One attempt in chronological execution order.
 *
 * The expanded TUI view walks the timeline and emits one block per entry,
 * so a review/fix loop renders as interleaved `review attempt 1`,
 * `fix attempt 1`, `review attempt 2` blocks in the order they actually
 * happened — which makes the loop legible instead of compressing back
 * into a single review block that overwrites its own history.
 */
export interface AttemptTimelineEntry {
	readonly stepId: StepId;
	readonly attempt: AttemptSummary;
}

/**
 * Walk the audit log once and produce the chronologically ordered list of
 * attempt entries. This is the primitive that `buildAttemptHistories`
 * groups by step for the per-step run-report view.
 */
export const buildAttemptTimeline = (events: readonly RelayEvent[]): AttemptTimelineEntry[] => {
	const timeline: AttemptTimelineEntry[] = [];
	const open = new Map<StepId, OpenAttempt>();

	const close = (stepId: StepId, attempt: AttemptSummary) => {
		timeline.push({ stepId, attempt });
	};

	for (const event of events) {
		switch (event.kind) {
			case "step_started":
				open.set(event.stepId, {
					attemptNumber: event.attempt,
					startedAt: event.at,
					transcript: [],
					usage: emptyUsage(),
				});
				break;

			case "action_progress": {
				const entry = open.get(event.stepId);
				if (!entry) break;
				entry.transcript.push(event.item);
				entry.usage = event.usage;
				break;
			}

			case "action_completed": {
				const entry = open.get(event.stepId);
				if (!entry) break;
				close(event.stepId, {
					attemptNumber: entry.attemptNumber,
					outcome: "completed",
					route: event.route,
					transcript: entry.transcript,
					usage: event.usage,
					startedAt: entry.startedAt,
					finishedAt: event.at,
				});
				open.delete(event.stepId);
				break;
			}

			case "action_no_completion":
			case "action_engine_error": {
				const entry = open.get(event.stepId);
				if (!entry) break;
				close(event.stepId, {
					attemptNumber: entry.attemptNumber,
					outcome: event.kind === "action_no_completion" ? "no_completion" : "engine_error",
					reason: event.reason,
					transcript: entry.transcript,
					usage: event.usage,
					startedAt: entry.startedAt,
					finishedAt: event.at,
				});
				open.delete(event.stepId);
				break;
			}

			case "check_passed": {
				const entry = open.get(event.stepId);
				if (!entry) break;
				close(event.stepId, {
					attemptNumber: entry.attemptNumber,
					outcome: "check_pass",
					transcript: [],
					usage: emptyUsage(),
					startedAt: entry.startedAt,
					finishedAt: event.at,
				});
				open.delete(event.stepId);
				break;
			}

			case "check_failed": {
				const entry = open.get(event.stepId);
				if (!entry) break;
				close(event.stepId, {
					attemptNumber: entry.attemptNumber,
					outcome: "check_fail",
					reason: event.reason,
					transcript: [],
					usage: emptyUsage(),
					startedAt: entry.startedAt,
					finishedAt: event.at,
				});
				open.delete(event.stepId);
				break;
			}

			case "terminal_reached": {
				const entry = open.get(event.stepId);
				if (!entry) {
					// Terminals don't emit step_started in the current scheduler,
					// so we synthesize an attempt entry on the fly. Keeps terminals
					// visible in the timeline even though they don't "run" in the
					// actor/check sense.
					close(event.stepId, {
						attemptNumber: 1,
						outcome: "terminal",
						transcript: [],
						usage: emptyUsage(),
						startedAt: event.at,
						finishedAt: event.at,
					});
					break;
				}
				close(event.stepId, {
					attemptNumber: entry.attemptNumber,
					outcome: "terminal",
					transcript: [],
					usage: emptyUsage(),
					startedAt: entry.startedAt,
					finishedAt: event.at,
				});
				open.delete(event.stepId);
				break;
			}

			default:
				break;
		}
	}

	// Any attempts still open at end-of-audit are aborted mid-flight. Record
	// them as `open` so they don't disappear from the timeline silently.
	for (const [stepId, entry] of open) {
		close(stepId, {
			attemptNumber: entry.attemptNumber,
			outcome: "open",
			transcript: entry.transcript,
			usage: entry.usage,
			startedAt: entry.startedAt,
		});
	}

	return timeline;
};

export const buildAttemptHistories = (events: readonly RelayEvent[]): Map<StepId, AttemptSummary[]> => {
	const timeline = buildAttemptTimeline(events);
	const map = new Map<StepId, AttemptSummary[]>();
	for (const { stepId, attempt } of timeline) {
		const list = map.get(stepId) ?? [];
		list.push(attempt);
		map.set(stepId, list);
	}
	return map;
};

// ============================================================================
// Text rendering for the tool result content
// ============================================================================

/**
 * Render the run report as plain text for the tool result's `content` field.
 *
 * The outer assistant reads this as the tool output — it IS the channel
 * through which the model learns what happened inside the relay run. It
 * must include every attempt with its route and a short narration so the
 * model can narrate back: "the first review pass rejected, then fix
 * updated the file, then the second pass accepted."
 *
 * Walks `report.timeline` (the chronological attempt sequence) not
 * `report.steps` (plan order), so a review/fix loop reads in execution
 * order:  create → review#1 → fix#1 → review#2 → done.  Matches what the
 * TUI expanded view shows.
 */
export const renderRunReportText = (report: RunReport): string => {
	const lines: string[] = [];
	lines.push(`Relay run: ${outcomeLabel(report.outcome)} — ${oneLine(report.task, 120)}`);
	if (report.summary && report.summary !== report.task) {
		lines.push(oneLine(report.summary, 200));
	}
	lines.push("");

	const executedCount = report.steps.filter((s) => s.status !== "skipped").length;
	const reentries = report.totalActivations - executedCount;
	const timelineHeader =
		reentries > 0
			? `Timeline (${report.totalActivations} activations across ${executedCount} executed steps, ${reentries} re-entries):`
			: `Timeline (${executedCount} executed):`;
	lines.push(timelineHeader);

	// Index step summaries so each timeline entry can look up its kind
	// (action/check/terminal) for the block header.
	const stepById = new Map<string, StepSummary>();
	for (const step of report.steps) stepById.set(unwrap(step.stepId), step);

	for (const entry of report.timeline) {
		const step = stepById.get(unwrap(entry.stepId));
		if (!step) continue;
		lines.push("");
		lines.push(formatTimelineEntry(step, entry.attempt));
	}

	const skippedSteps = report.steps.filter((s) => s.status === "skipped");
	if (skippedSteps.length > 0) {
		lines.push("");
		lines.push(
			`— ${skippedSteps.length} step${skippedSteps.length === 1 ? "" : "s"} skipped (not reached): ${skippedSteps.map((s) => unwrap(s.stepId)).join(", ")}`,
		);
	}

	if (report.artifacts.length > 0) {
		lines.push("");
		lines.push(`Artifacts committed: ${report.artifacts.map((a) => unwrap(a.artifactId)).join(", ")}`);
	}

	if (report.usage.turns > 0) {
		lines.push(
			`Usage: ${report.usage.turns} turns, ${report.usage.input} input / ${report.usage.output} output, $${report.usage.cost.toFixed(4)}`,
		);
	}

	return lines.join("\n");
};

const formatTimelineEntry = (step: StepSummary, attempt: AttemptSummary): string => {
	const icon = statusGlyphForAttempt(attempt, step);
	const stepId = unwrap(step.stepId);
	const kindLabel = describeStepKind(step);
	// Only action steps need the attempt suffix — and only when they ran
	// more than once. Single-attempt actions, checks, and terminals stay
	// uncluttered.
	const attemptSuffix =
		step.kind === "action" && attempt.attemptNumber > 1 ? ` · attempt ${attempt.attemptNumber}` : "";
	const header = `${icon} ${stepId} [${kindLabel}]${attemptSuffix}`;
	const inline = formatAttemptInline(attempt);
	return inline ? `${header}\n  ${inline}` : header;
};

const formatAttemptInline = (attempt: AttemptSummary): string => {
	const outcomeTag = formatAttemptOutcome(attempt);
	const toolCalls = attempt.transcript
		.filter((item): item is Extract<TranscriptItem, { kind: "tool_call" }> => item.kind === "tool_call")
		.map((item) => item.toolName);
	const toolSuffix = toolCalls.length > 0 ? ` · tools: ${truncateList(toolCalls, 6)}` : "";
	const finalText = extractAttemptFinalText(attempt);
	const quote = finalText ? `\n    "${oneLine(finalText, 180)}"` : "";
	return `${outcomeTag}${toolSuffix}${quote}`;
};

const statusGlyphForAttempt = (attempt: AttemptSummary, step: StepSummary): string => {
	switch (attempt.outcome) {
		case "completed":
		case "check_pass":
			return "✓";
		case "no_completion":
		case "engine_error":
		case "check_fail":
			return "✗";
		case "terminal":
			return step.status === "succeeded" ? "✓" : step.status === "failed" ? "✗" : "■";
		case "open":
			return "⏳";
	}
};

const formatAttemptOutcome = (attempt: AttemptSummary): string => {
	switch (attempt.outcome) {
		case "completed":
			return `route: ${attempt.route ? unwrap(attempt.route) : "?"}`;
		case "no_completion":
			return `no_completion: ${attempt.reason ? oneLine(attempt.reason, 160) : "no reason"}`;
		case "engine_error":
			return `engine_error: ${attempt.reason ? oneLine(attempt.reason, 160) : "no reason"}`;
		case "check_pass":
			return "check passed";
		case "check_fail":
			return `check failed: ${attempt.reason ? oneLine(attempt.reason, 160) : "no reason"}`;
		case "terminal":
			return "terminal reached";
		case "open":
			return "open (not completed)";
	}
};

const extractAttemptFinalText = (attempt: AttemptSummary): string => {
	const texts: string[] = [];
	for (const item of attempt.transcript) {
		if (item.kind === "text" && item.text.trim().length > 0) texts.push(item.text);
	}
	if (texts.length === 0) return "";
	return stripCompletionTag(texts.join("\n"));
};

const describeStepKind = (step: StepSummary): string => {
	switch (step.kind) {
		case "action":
			return "action";
		case "check":
			return "check";
		case "terminal":
			return "terminal";
	}
};

const outcomeLabel = (outcome: RunOutcome): string => {
	switch (outcome) {
		case "success":
			return "SUCCESS";
		case "failure":
			return "FAILURE";
		case "aborted":
			return "ABORTED";
		case "incomplete":
			return "INCOMPLETE";
	}
};

const oneLine = (text: string, limit: number): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= limit) return collapsed;
	return `${collapsed.slice(0, limit)}…`;
};

const truncateList = (items: readonly string[], limit: number): string => {
	if (items.length <= limit) return items.join(", ");
	return `${items.slice(0, limit).join(", ")}, +${items.length - limit} more`;
};

/**
 * Prefix used by the scheduler when a step's retry policy is exhausted.
 * Exported so the scheduler and tests agree.
 */
export const SYNTHETIC_FAILURE_REASON_PREFIX = "retries exhausted: ";
