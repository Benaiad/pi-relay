/**
 * Extracted plan execution engine.
 *
 * `runPlan` owns the scheduler lifecycle: construct, subscribe, run, collect
 * results. It takes a pre-compiled `Program` and validated actors — the
 * caller handles compilation, actor validation, and any UI (review dialog,
 * TUI updates).
 *
 * Both the pi extension (`executePlan`) and the standalone CLI call this
 * function. The extension adds the interactive review dialog and formats the
 * result as an `AgentToolResult`. The CLI formats it as text or JSON to
 * stdout. Neither concern leaks into this module.
 */

import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { createSdkActorEngine } from "../actors/sdk-engine.js";
import type { ActorEngine, ValidatedActor } from "../actors/types.js";
import type { ActorId, StepId } from "../plan/ids.js";
import type { Program } from "../plan/program.js";
import { ArtifactStore } from "../runtime/artifacts.js";
import { AuditLog } from "../runtime/audit.js";
import type { RelayEvent, RelayRunState } from "../runtime/events.js";
import { buildRunReport, type RunReport } from "../runtime/run-report.js";
import { Scheduler } from "../runtime/scheduler.js";

export interface RunPlanProgress {
	readonly event: RelayEvent;
	readonly state: RelayRunState;
	readonly report: RunReport;
	readonly checkOutput?: ReadonlyMap<StepId, string>;
}

export interface RunPlanConfig {
	readonly program: Program;
	readonly actorsByName: ReadonlyMap<ActorId, ValidatedActor>;
	readonly modelRegistry: ModelRegistry;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly onProgress?: (progress: RunPlanProgress) => void;
	readonly actorEngine?: ActorEngine;
	readonly shellPath?: string;
	readonly shellCommandPrefix?: string;
}

export interface RunPlanResult {
	readonly report: RunReport;
	readonly state: RelayRunState;
	readonly artifactStore: ArtifactStore;
	readonly audit: AuditLog;
}

export const runPlan = async (config: RunPlanConfig): Promise<RunPlanResult> => {
	const clock = () => Date.now();
	const audit = new AuditLog();
	const artifactStore = new ArtifactStore(config.program, clock);

	const scheduler = new Scheduler({
		program: config.program,
		actorEngine: config.actorEngine ?? createSdkActorEngine({ modelRegistry: config.modelRegistry }),
		actorsByName: config.actorsByName,
		cwd: config.cwd,
		signal: config.signal,
		clock,
		audit,
		artifactStore,
		shellPath: config.shellPath,
		shellCommandPrefix: config.shellCommandPrefix,
	});

	let lastEvent: RelayEvent | undefined;

	const emitProgress = (): void => {
		if (!config.onProgress || !lastEvent) return;
		const state = scheduler.getState();
		const report = buildRunReport(state, audit);
		const checkOutput = buildCheckOutputSnapshot(scheduler, state);
		config.onProgress({ event: lastEvent, state, report, checkOutput });
	};

	const eventSub = scheduler.subscribe((event) => {
		lastEvent = event;
		emitProgress();
	});
	const outputSub = scheduler.subscribeOutput(() => emitProgress());

	try {
		const report = await scheduler.run();
		const finalState = scheduler.getState();
		return { report, state: finalState, artifactStore, audit };
	} finally {
		eventSub.unsubscribe();
		outputSub.unsubscribe();
	}
};

const buildCheckOutputSnapshot = (
	scheduler: Scheduler,
	state: RelayRunState,
): ReadonlyMap<StepId, string> | undefined => {
	let result: Map<StepId, string> | undefined;
	for (const stepId of state.currentlyRunning) {
		const output = scheduler.getCheckOutput(stepId);
		if (output === undefined) continue;
		result ??= new Map();
		result.set(stepId, output);
	}
	return result;
};
