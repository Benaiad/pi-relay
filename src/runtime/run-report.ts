/**
 * Final run report.
 *
 * The report is what `relay` returns to pi as the tool result. It is built
 * from two sources: the final `RelayRunState` snapshot (for per-step status,
 * counts, and aggregate usage), and the `AuditLog` (for per-attempt history,
 * which the run state no longer retains — see `events.ts` for why re-entered
 * steps reset their transcript).
 *
 * The content text the model reads is produced by `renderRunReportText` —
 * a markdown document structured for both LLM comprehension and human
 * readability in a TUI. It groups attempts by step (not flat timeline),
 * compresses loops to one-liner summaries for prior runs, and shows full
 * detail only for the latest activation of each step.
 */

import { renderValue } from "../actors/render-value.js";
import type { ActorUsage, TranscriptItem } from "../actors/types.js";
import { emptyUsage } from "../actors/types.js";
import type { ArtifactId, PlanId, StepId } from "../plan/ids.js";
import { edgeKey, RouteId, unwrap } from "../plan/ids.js";
import type { Program } from "../plan/program.js";
import type { Step, TerminalOutcome } from "../plan/types.js";
import { formatToolCall, plainTheme } from "../render/format.js";
import { isAccumulatedEntryArray } from "./accumulated-entry.js";
import type { ArtifactStore } from "./artifacts.js";
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
	readonly routedTo?: StepId;
	readonly reason?: string;
	readonly assistant_summary?: string;
	readonly exitCode?: number | null;
	readonly output?: string;
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
	readonly actorName?: string;
	readonly commandDescription?: string;
	readonly terminalOutcome?: TerminalOutcome;
	readonly terminalSummary?: string;
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
	const timeline = buildAttemptTimeline(events, program);
	const attemptHistories = buildAttemptHistories(events, program);
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
		actorName: step.kind === "action" ? unwrap(step.actor) : undefined,
		commandDescription: describeCheckStep(step),
		terminalOutcome: step.kind === "terminal" ? step.outcome : undefined,
		terminalSummary: step.kind === "terminal" ? step.summary : undefined,
	};
};

const buildArtifactSummaries = (state: RelayRunState): ArtifactSummary[] => {
	const summaries: ArtifactSummary[] = [];
	for (const artifactId of state.committedArtifacts) {
		const contract = state.program.artifacts.get(artifactId);
		const writer = state.program.writers.get(artifactId);
		if (!contract || !writer) continue;
		summaries.push({
			artifactId,
			writerStep: writer,
			description: contract.description,
		});
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
 * attempt entries. Route resolution uses the program's edge map to resolve
 * each route to its target step ID.
 */
export const buildAttemptTimeline = (events: readonly RelayEvent[], program: Program): AttemptTimelineEntry[] => {
	const timeline: AttemptTimelineEntry[] = [];
	const open = new Map<StepId, OpenAttempt>();

	const resolveRoute = (stepId: StepId, route: RouteId): StepId | undefined =>
		program.edges.get(edgeKey(stepId, route));

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
					routedTo: resolveRoute(event.stepId, event.route),
					assistant_summary: event.assistant_summary,
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
					routedTo: resolveRoute(event.stepId, RouteId("success")),
					exitCode: event.exitCode,
					output: event.output,
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
					routedTo: resolveRoute(event.stepId, RouteId("failure")),
					reason: event.reason,
					exitCode: event.exitCode,
					output: event.output,
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

export const buildAttemptHistories = (
	events: readonly RelayEvent[],
	program: Program,
): Map<StepId, AttemptSummary[]> => {
	const timeline = buildAttemptTimeline(events, program);
	const map = new Map<StepId, AttemptSummary[]>();
	for (const { stepId, attempt } of timeline) {
		const list = map.get(stepId) ?? [];
		list.push(attempt);
		map.set(stepId, list);
	}
	return map;
};

// ============================================================================
// Markdown report rendering
// ============================================================================

const MAX_PRIOR_RUNS = 5;

/**
 * Render the run report as markdown for the tool result's `content` field.
 *
 * The outer assistant reads this to understand what happened inside the
 * relay run. The format is markdown — readable by both models and humans
 * in a TUI.
 *
 * Steps are grouped by step ID (order of first activation). A step that ran
 * multiple times shows prior attempts as one-liners (last 5) and full detail
 * only for the latest activation. Artifacts are in a dedicated section at the
 * end.
 */
export const renderRunReportText = (report: RunReport, artifactStore?: ArtifactStore): string => {
	const lines: string[] = [];
	lines.push(`# Relay: ${outcomeLabel(report.outcome)}`);
	lines.push("");
	lines.push(`**Task:** ${report.task}`);
	lines.push("");

	const grouped = groupByStep(report.timeline);

	for (const [stepId, attempts] of grouped) {
		const step = report.steps.find((s) => unwrap(s.stepId) === unwrap(stepId));
		if (!step) continue;
		if (step.status === "skipped") continue;

		lines.push("---");
		lines.push("");
		renderStepSection(lines, step, attempts);
		lines.push("");
	}

	if (artifactStore) {
		const allArtifacts = [...artifactStore.all()];
		if (allArtifacts.length > 0) {
			lines.push("---");
			lines.push("");
			lines.push("## Artifacts");
			lines.push("");
			for (const stored of allArtifacts) {
				lines.push(`### ${unwrap(stored.id)}`);
				lines.push("");
				if (isAccumulatedEntryArray(stored.value)) {
					for (const entry of stored.value) {
						const rendered = renderValue(entry.value, 0);
						lines.push(rendered);
						lines.push("");
					}
				} else {
					const rendered = renderValue(stored.value, 0);
					lines.push(rendered);
					lines.push("");
				}
			}
		}
	}

	return lines.join("\n");
};

const groupByStep = (timeline: readonly AttemptTimelineEntry[]): Map<StepId, AttemptSummary[]> => {
	const map = new Map<StepId, AttemptSummary[]>();
	for (const { stepId, attempt } of timeline) {
		const list = map.get(stepId) ?? [];
		list.push(attempt);
		map.set(stepId, list);
	}
	return map;
};

const renderStepSection = (lines: string[], step: StepSummary, attempts: readonly AttemptSummary[]): void => {
	const stepId = unwrap(step.stepId);
	const runCount = attempts.length;
	const runSuffix = runCount > 1 ? ` (${runCount} runs)` : "";

	switch (step.kind) {
		case "action":
			lines.push(`## ${stepId} -- actor: ${step.actorName ?? "unknown"}${runSuffix}`);
			break;
		case "command":
			lines.push(`## ${stepId} -- command${runSuffix}`);
			break;
		case "files_exist":
			lines.push(`## ${stepId} -- files_exist${runSuffix}`);
			break;
		case "terminal":
			lines.push(`## ${stepId} -- terminal: ${step.terminalOutcome ?? "unknown"}`);
			break;
	}
	lines.push("");

	if (runCount === 1) {
		renderAttemptDetail(lines, step, attempts[0]!);
		return;
	}

	const priorAttempts = attempts.slice(0, -1);
	const latestAttempt = attempts[attempts.length - 1]!;

	const visiblePrior = priorAttempts.length > MAX_PRIOR_RUNS ? priorAttempts.slice(-MAX_PRIOR_RUNS) : priorAttempts;
	const omitted = priorAttempts.length - visiblePrior.length;

	if (omitted > 0) {
		lines.push(`... ${omitted} earlier runs omitted`);
		lines.push("");
	}

	for (const attempt of visiblePrior) {
		lines.push(`- run ${attempt.attemptNumber}: ${formatPriorAttemptOneLiner(step, attempt)}`);
	}
	lines.push("");

	lines.push(`### Latest (run ${latestAttempt.attemptNumber})`);
	lines.push("");
	renderAttemptDetail(lines, step, latestAttempt);
};

const formatPriorAttemptOneLiner = (step: StepSummary, attempt: AttemptSummary): string => {
	const target = attempt.routedTo ? ` -> ${unwrap(attempt.routedTo)}` : "";

	switch (attempt.outcome) {
		case "completed": {
			const summary = attempt.assistant_summary ? truncateLine(attempt.assistant_summary, 80) : "completed";
			return `${summary}, routed to${target}`;
		}
		case "check_pass":
			return `exit ${attempt.exitCode ?? "?"}, routed to${target}`;
		case "check_fail":
			return `exit ${attempt.exitCode ?? "?"}, routed to${target}`;
		case "no_completion":
		case "engine_error":
			return `failed: ${truncateLine(attempt.reason ?? "unknown", 80)}`;
		case "terminal":
			return `terminal: ${step.terminalOutcome ?? "unknown"}`;
		case "open":
			return "in progress (aborted)";
	}
};

const renderAttemptDetail = (lines: string[], step: StepSummary, attempt: AttemptSummary): void => {
	switch (step.kind) {
		case "action":
			renderActionDetail(lines, attempt);
			break;
		case "command":
			renderCommandDetail(lines, step, attempt);
			break;
		case "files_exist":
			renderFilesExistDetail(lines, step, attempt);
			break;
		case "terminal":
			if (step.terminalSummary) lines.push(step.terminalSummary);
			break;
	}
};

const renderActionDetail = (lines: string[], attempt: AttemptSummary): void => {
	const toolCalls = attempt.transcript.filter(
		(item): item is Extract<TranscriptItem, { kind: "tool_call" }> => item.kind === "tool_call",
	);
	if (toolCalls.length > 0) {
		for (const tc of toolCalls) {
			lines.push(`> ${formatToolCall(tc.toolName, tc.args, plainTheme, 0)}`);
		}
		lines.push("");
	}

	if (attempt.assistant_summary) {
		lines.push(attempt.assistant_summary);
		lines.push("");
	}

	renderOutcomeAndRoute(lines, attempt);
};

const renderCommandDetail = (lines: string[], step: StepSummary, attempt: AttemptSummary): void => {
	if (step.commandDescription) {
		lines.push(step.commandDescription);
		lines.push("");
	}

	if (attempt.exitCode !== undefined) {
		lines.push(`Exit code: ${attempt.exitCode ?? "N/A"}`);
		lines.push("");
	}

	if (attempt.output && attempt.output.length > 0) {
		lines.push("```");
		lines.push(attempt.output);
		lines.push("```");
		lines.push("");
	}

	renderOutcomeAndRoute(lines, attempt);
};

const renderFilesExistDetail = (lines: string[], step: StepSummary, attempt: AttemptSummary): void => {
	if (step.commandDescription) {
		lines.push(step.commandDescription);
	}

	if (attempt.outcome === "check_pass") {
		lines.push("Result: pass");
	} else if (attempt.outcome === "check_fail") {
		lines.push(`Result: fail (${attempt.reason ?? "unknown"})`);
	}
	lines.push("");

	renderOutcomeAndRoute(lines, attempt);
};

const renderOutcomeAndRoute = (lines: string[], attempt: AttemptSummary): void => {
	if (attempt.outcome === "no_completion" || attempt.outcome === "engine_error") {
		lines.push(`**Failed:** ${attempt.reason ?? "no reason"}`);
		lines.push("");
		return;
	}

	if (attempt.routedTo) {
		lines.push(`Routed to -> ${unwrap(attempt.routedTo)}`);
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

const describeCheckStep = (step: Step): string | undefined => {
	switch (step.kind) {
		case "command":
			return `$ ${step.command}`;
		case "files_exist":
			return step.paths.length === 1 ? `Paths: ${step.paths[0]}` : `Paths: ${step.paths.join(", ")}`;
		default:
			return undefined;
	}
};

const truncateLine = (text: string, limit: number): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= limit) return collapsed;
	return `${collapsed.slice(0, limit)}…`;
};

/**
 * Prefix used by the scheduler when implicit retries are exhausted.
 * Exported so the scheduler and tests agree.
 */
export const SYNTHETIC_FAILURE_REASON_PREFIX = "retries exhausted: ";
