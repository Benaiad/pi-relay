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
	const attemptHistories = buildAttemptHistories(audit.entries());
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
const buildAttemptHistories = (events: readonly RelayEvent[]): Map<StepId, AttemptSummary[]> => {
	const histories = new Map<StepId, AttemptSummary[]>();
	const open = new Map<StepId, OpenAttempt>();

	const append = (stepId: StepId, attempt: AttemptSummary) => {
		const list = histories.get(stepId) ?? [];
		list.push(attempt);
		histories.set(stepId, list);
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
				append(event.stepId, {
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
				append(event.stepId, {
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
				append(event.stepId, {
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
				append(event.stepId, {
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
				if (!entry) break;
				append(event.stepId, {
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

	// Any still-open attempts (aborted mid-flight) get recorded as "open" so
	// the render can surface them rather than dropping them silently.
	for (const [stepId, entry] of open) {
		append(stepId, {
			attemptNumber: entry.attemptNumber,
			outcome: "open",
			transcript: entry.transcript,
			usage: entry.usage,
			startedAt: entry.startedAt,
		});
	}

	return histories;
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
 * The TUI renders its own richer expansion from `details.state` — this
 * text is primarily for the model.
 */
export const renderRunReportText = (report: RunReport): string => {
	const lines: string[] = [];
	lines.push(`Relay run: ${outcomeLabel(report.outcome)} — ${oneLine(report.task, 120)}`);
	if (report.summary && report.summary !== report.task) {
		lines.push(oneLine(report.summary, 200));
	}
	lines.push("");

	const reentries = report.totalActivations - report.steps.filter((s) => s.status !== "skipped").length;
	const executedCount = report.steps.filter((s) => s.status !== "skipped").length;
	const stepHeader =
		reentries > 0
			? `Steps (${report.totalActivations} activations across ${executedCount} executed steps, ${reentries} re-entries):`
			: `Steps (${executedCount} executed):`;
	lines.push(stepHeader);

	for (const step of report.steps) {
		lines.push("");
		lines.push(formatStepBlock(step));
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

const formatStepBlock = (step: StepSummary): string => {
	const icon = statusGlyph(step.status);
	const stepId = unwrap(step.stepId);
	const header = `${icon} ${stepId} [${describeStepKind(step)}]${formatAttemptsSuffix(step)}`;

	if (step.attempts.length === 0) {
		// Skipped or never ran; show only the header.
		return header;
	}

	if (step.attempts.length === 1) {
		const attempt = step.attempts[0]!;
		const inline = formatAttemptInline(attempt);
		return inline ? `${header}\n  ${inline}` : header;
	}

	// Multiple attempts — render each on its own indented block so the
	// model can clearly see the loop history.
	const lines = [header];
	for (const attempt of step.attempts) {
		lines.push(`  attempt ${attempt.attemptNumber} · ${formatAttemptInline(attempt)}`);
	}
	return lines.join("\n");
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

const formatAttemptsSuffix = (step: StepSummary): string => {
	if (step.attemptCount <= 1) return "";
	return ` · ${step.attemptCount} attempts`;
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

const statusGlyph = (status: StepStatus): string => {
	switch (status) {
		case "succeeded":
			return "✓";
		case "failed":
			return "✗";
		case "skipped":
			return "—";
		case "running":
			return "⏳";
		case "retrying":
			return "↻";
		case "ready":
		case "pending":
			return "·";
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
