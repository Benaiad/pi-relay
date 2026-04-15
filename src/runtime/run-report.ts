/**
 * Final run report.
 *
 * The report is what `relay` returns to pi as the tool result. It is built
 * from the final run state (derived from the audit log) and includes enough
 * information for the model to reason about what happened: the task, the
 * outcome, a one-line summary, per-step status, committed artifacts, and
 * aggregated usage.
 *
 * The report is also what the renderer's expanded view consumes for
 * post-run display. It is derived purely from `RelayRunState` — no hidden
 * state.
 */

import type { ActorUsage, TranscriptItem } from "../actors/types.js";
import type { ArtifactId, PlanId, RouteId, StepId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import type { Step, TerminalOutcome } from "../plan/types.js";
import type { RelayRunState, RunPhase, StepStatus } from "./events.js";

export type RunOutcome = "success" | "failure" | "aborted" | "incomplete";

export interface StepSummary {
	readonly stepId: StepId;
	readonly kind: Step["kind"];
	readonly status: StepStatus;
	readonly attempts: number;
	readonly startedAt?: number;
	readonly finishedAt?: number;
	readonly durationMs?: number;
	readonly lastRoute?: RouteId;
	readonly lastReason?: string;
	readonly usage: ActorUsage;
	readonly transcript: readonly TranscriptItem[];
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

export const buildRunReport = (state: RelayRunState): RunReport => {
	const { program } = state;
	const steps = program.stepOrder.map((id) => buildStepSummary(id, state));
	const artifacts = buildArtifactSummaries(state);
	const outcome = phaseToOutcome(state.phase);
	const durationMs = state.startedAt && state.finishedAt ? state.finishedAt - state.startedAt : 0;
	const summary = buildSummary(state, outcome);
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
	};
};

const buildStepSummary = (stepId: StepId, state: RelayRunState): StepSummary => {
	const runtime = state.steps.get(stepId);
	const step = state.program.steps.get(stepId);
	if (!runtime || !step) {
		throw new Error(`invariant: step '${unwrap(stepId)}' missing from run state or program`);
	}
	return {
		stepId,
		kind: step.kind,
		status: runtime.status,
		attempts: runtime.attempts,
		startedAt: runtime.startedAt,
		finishedAt: runtime.finishedAt,
		durationMs:
			runtime.startedAt !== undefined && runtime.finishedAt !== undefined
				? runtime.finishedAt - runtime.startedAt
				: undefined,
		lastRoute: runtime.lastRoute,
		lastReason: runtime.lastReason,
		usage: runtime.usage,
		transcript: runtime.transcript,
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

/**
 * Render the run report as plain text for the tool result's `content` field.
 *
 * The model reads this — keep it concise, structured, and informative. The
 * renderer displays much more detail via the TUI expanded view.
 */
export const renderRunReportText = (report: RunReport): string => {
	const lines: string[] = [];
	lines.push(`Relay run: ${outcomeLabel(report.outcome)} — ${report.task}`);
	if (report.summary && report.summary !== report.task) lines.push(report.summary);
	lines.push("");
	lines.push(`Steps: ${report.steps.length} (${summarizeStepStatuses(report.steps)})`);
	if (report.artifacts.length > 0) {
		lines.push(`Artifacts committed: ${report.artifacts.map((a) => unwrap(a.artifactId)).join(", ")}`);
	}
	if (report.usage.turns > 0) {
		lines.push(
			`Usage: ${report.usage.turns} turns, ${report.usage.input} in / ${report.usage.output} out, $${report.usage.cost.toFixed(4)}`,
		);
	}
	return lines.join("\n");
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

const summarizeStepStatuses = (steps: readonly StepSummary[]): string => {
	const counts = new Map<StepStatus, number>();
	for (const s of steps) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
	return Array.from(counts.entries())
		.map(([status, count]) => `${count} ${status}`)
		.join(", ");
};

/**
 * Program-only helper: the name of the synthetic terminal failure route.
 * Exported so the scheduler and tests agree.
 */
export const SYNTHETIC_FAILURE_REASON_PREFIX = "retries exhausted: ";
