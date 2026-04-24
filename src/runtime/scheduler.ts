/**
 * Sequential ready-queue scheduler.
 *
 * The scheduler executes a compiled `Program` as a DAG of `Action`,
 * `Command`, `FilesExist`, and `Terminal` steps. The MVP
 * implementation is strictly sequential: one step runs at a time. Parallel
 * execution and `Join` steps land in v0.2 and will slot in without changing
 * the event protocol or the reducer.
 *
 * Loop:
 *
 *   1. Seed the ready queue with the program's entry step.
 *   2. While the queue is non-empty and not aborted:
 *      a. Pop the next step.
 *      b. Dispatch by kind. Action → actor engine. Command → check engine.
 *         Terminal → emit `terminal_reached` and stop.
 *      c. On action failure (`no_completion` or `engine_error`), retry
 *         implicitly up to 3 times before following the failure route.
 *      d. On successful completion, commit writes via the artifact store
 *         and follow the emitted route to the next step.
 *   3. On abort, drain in-flight work (there is only ever one in sequential
 *      mode, but the signal is forwarded to its AbortController so the
 *      subprocess sees it).
 *
 * Implicit retry: action steps that return `no_completion` or `engine_error`
 * are re-queued up to `IMPLICIT_RETRY_ATTEMPTS` (3) times. This is not
 * configurable per step — it is invisible infrastructure. After exhausting
 * retries, the scheduler looks for a route named `failure` or `error` on
 * the step and follows it; if neither exists, it fails the plan.
 *
 * Time is injected via `clock` so tests can pin timestamps. The scheduler
 * never calls `Date.now` directly.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type BashOperations, createLocalBashOperations, getAgentDir } from "@mariozechner/pi-coding-agent";
import type {
	ActionOutcome,
	ActionRequest,
	ActorConfig,
	ActorEngine,
	ActorUsage,
	PriorAttempt,
	PriorCheckResult,
} from "../actors/types.js";
import { emptyUsage } from "../actors/types.js";
import type { ActorId, ArtifactId, RouteId, StepId } from "../plan/ids.js";
import { edgeKey, ArtifactId as makeArtifactId, RouteId as makeRouteId, unwrap } from "../plan/ids.js";
import type { Program } from "../plan/program.js";
import type { ActionStep, ArtifactShape, CommandStep, FilesExistStep, Step, TerminalStep } from "../plan/types.js";
import { isAccumulatedEntryArray } from "./accumulated-entry.js";
import { ArtifactStore } from "./artifacts.js";
import { AuditLog } from "./audit.js";
import { runCommand, runFilesExist } from "./checks.js";
import { applyEvent, initRunState, type RelayEvent, type RelayRunState, type RunPhase } from "./events.js";
import {
	type AttemptSummary,
	buildAttemptHistories,
	buildRunReport,
	type RunReport,
	SYNTHETIC_FAILURE_REASON_PREFIX,
} from "./run-report.js";

const DEFAULT_CLOCK = () => Date.now();
const IMPLICIT_RETRY_ATTEMPTS = 3;
const MAX_CHECK_DISPLAY_BUFFER = 32 * 1024;

const describeCommandStep = (step: CommandStep | FilesExistStep): string => {
	switch (step.kind) {
		case "command":
			return `command: ${step.command}`;
		case "files_exist":
			return step.paths.length === 1 ? `file: ${step.paths[0]}` : `files: ${step.paths.join(", ")}`;
	}
};
const DEFAULT_MAX_RUNS = 10;
const PRIOR_ATTEMPT_NARRATION_LIMIT = 240;
const FAILURE_ROUTE_CANDIDATES = ["failure", "error"] as const;

/** Reduce a full AttemptSummary to the compact shape the engine injects into the actor prompt. */
const summarizePriorAttempt = (attempt: AttemptSummary): PriorAttempt => {
	const toolsCalled: string[] = [];
	const narrationParts: string[] = [];
	for (const item of attempt.transcript) {
		if (item.kind === "tool_call") toolsCalled.push(item.toolName);
		else if (item.kind === "text" && item.text.trim().length > 0) narrationParts.push(item.text);
	}
	const rawNarration = narrationParts.join("\n").trim();
	const narration = oneLineLimit(rawNarration, PRIOR_ATTEMPT_NARRATION_LIMIT);

	let outcomeLabel: string;
	switch (attempt.outcome) {
		case "completed":
			outcomeLabel = `route: ${attempt.route ? unwrap(attempt.route) : "?"}`;
			break;
		case "no_completion":
			outcomeLabel = `no_completion: ${attempt.reason ?? "no reason"}`;
			break;
		case "engine_error":
			outcomeLabel = `engine_error: ${attempt.reason ?? "no reason"}`;
			break;
		case "check_pass":
			outcomeLabel = "check passed";
			break;
		case "check_fail":
			outcomeLabel = `check failed: ${attempt.reason ?? "no reason"}`;
			break;
		case "terminal":
			outcomeLabel = "terminal reached";
			break;
		case "open":
			outcomeLabel = "open (did not complete)";
			break;
	}

	return {
		attemptNumber: attempt.attemptNumber,
		outcomeLabel,
		narration,
		toolsCalled,
	};
};

const oneLineLimit = (text: string, limit: number): string => {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length <= limit) return collapsed;
	return `${collapsed.slice(0, limit)}…`;
};

export interface SchedulerConfig {
	readonly program: Program;
	readonly actorEngine: ActorEngine;
	readonly actorsByName: ReadonlyMap<ActorId, ActorConfig>;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly clock?: () => number;
	readonly artifactStore?: ArtifactStore;
	readonly audit?: AuditLog;
	readonly maxConcurrency?: number;
	readonly shellPath?: string;
	readonly shellCommandPrefix?: string;
}

export interface SchedulerSubscription {
	unsubscribe(): void;
}

export type SchedulerEventHandler = (event: RelayEvent) => void;

export class Scheduler {
	private readonly program: Program;
	private readonly actorEngine: ActorEngine;
	private readonly actorsByName: ReadonlyMap<ActorId, ActorConfig>;
	private readonly cwd: string;
	private readonly signal?: AbortSignal;
	private readonly clock: () => number;
	private readonly audit: AuditLog;
	private readonly artifactStore: ArtifactStore;
	private readonly ops: BashOperations;
	private readonly shellCommandPrefix: string | undefined;

	private state: RelayRunState;
	private readyQueue: StepId[] = [];
	private handlers: SchedulerEventHandler[] = [];
	private outputHandlers: Array<() => void> = [];
	private checkOutputChunks = new Map<StepId, string[]>();
	private checkOutputLens = new Map<StepId, number>();
	private hasRun = false;
	private lastCheckResult: PriorCheckResult | undefined;

	constructor(config: SchedulerConfig) {
		this.program = config.program;
		this.actorEngine = config.actorEngine;
		this.actorsByName = config.actorsByName;
		this.cwd = config.cwd;
		this.signal = config.signal;
		this.clock = config.clock ?? DEFAULT_CLOCK;
		this.audit = config.audit ?? new AuditLog();
		this.artifactStore = config.artifactStore ?? new ArtifactStore(this.program, this.clock);
		this.ops = createLocalBashOperations({ shellPath: config.shellPath });
		this.shellCommandPrefix = config.shellCommandPrefix;
		this.state = initRunState(this.program);
	}

	subscribe(handler: SchedulerEventHandler): SchedulerSubscription {
		this.handlers.push(handler);
		return {
			unsubscribe: () => {
				this.handlers = this.handlers.filter((h) => h !== handler);
			},
		};
	}

	subscribeOutput(handler: () => void): SchedulerSubscription {
		this.outputHandlers.push(handler);
		return {
			unsubscribe: () => {
				this.outputHandlers = this.outputHandlers.filter((h) => h !== handler);
			},
		};
	}

	getCheckOutput(stepId: StepId): string | undefined {
		const chunks = this.checkOutputChunks.get(stepId);
		if (!chunks || chunks.length === 0) return undefined;
		return chunks.join("");
	}

	getAudit(): AuditLog {
		return this.audit;
	}

	getState(): RelayRunState {
		return this.state;
	}

	async run(): Promise<RunReport> {
		if (this.hasRun) {
			throw new Error("Scheduler.run() may only be called once per instance");
		}
		this.hasRun = true;

		this.emit({
			kind: "run_started",
			at: this.clock(),
			planId: this.program.id,
		});
		this.enqueueReady(this.program.entryStep);

		while (this.readyQueue.length > 0) {
			if (this.signal?.aborted) {
				this.emit({ kind: "run_aborted", at: this.clock() });
				break;
			}

			const nextId = this.readyQueue.shift();
			if (nextId === undefined) break;
			const step = this.program.steps.get(nextId);
			if (!step) {
				this.finishWith("failed", `scheduler picked unknown step '${unwrap(nextId)}'`);
				return buildRunReport(this.state, this.audit);
			}

			const maxRuns = (step.kind === "action" ? step.maxRuns : undefined) ?? DEFAULT_MAX_RUNS;
			const priorAttempts = this.state.steps.get(nextId)?.attempts ?? 0;
			if (priorAttempts >= maxRuns) {
				this.finishWith(
					"incomplete",
					`step '${unwrap(nextId)}' exceeded its maxRuns cap (${maxRuns}) — the loop through this step is not converging`,
				);
				break;
			}

			await this.executeStep(step);

			if (this.state.phase === "succeeded" || this.state.phase === "failed" || this.state.phase === "aborted") {
				break;
			}
		}

		if (this.state.phase === "running" || this.state.phase === "pending") {
			this.finishWith("incomplete", `ready queue drained without reaching a terminal step`);
		}

		return buildRunReport(this.state, this.audit);
	}

	// ==========================================================================
	// Internal: event emission
	// ==========================================================================

	private emit(event: RelayEvent): void {
		this.audit.append(event);
		this.state = applyEvent(this.state, event);
		for (const handler of this.handlers) {
			try {
				handler(event);
			} catch {
				// Subscribers are best-effort; a throwing renderer must not kill the scheduler.
			}
		}
	}

	private notifyOutputHandlers(): void {
		for (const handler of this.outputHandlers) {
			try {
				handler();
			} catch {
				// Best-effort, same as event handlers.
			}
		}
	}

	private enqueueReady(stepId: StepId): void {
		this.emit({ kind: "step_ready", at: this.clock(), stepId });
		this.readyQueue.push(stepId);
	}

	private finishWith(phase: RunPhase, summary: string): void {
		this.emit({ kind: "run_finished", at: this.clock(), phase, summary });
	}

	// ==========================================================================
	// Internal: step dispatch
	// ==========================================================================

	private async executeStep(step: Step): Promise<void> {
		switch (step.kind) {
			case "action":
				await this.executeAction(step);
				return;
			case "command":
				await this.executeCommand(step);
				return;
			case "files_exist":
				await this.executeFilesExist(step);
				return;
			case "terminal":
				this.executeTerminal(step);
				return;
		}
	}

	private async executeAction(step: ActionStep): Promise<void> {
		const actor = this.actorsByName.get(step.actor);
		if (!actor) {
			this.emit({
				kind: "step_failed",
				at: this.clock(),
				stepId: step.id,
				reason: `actor '${unwrap(step.actor)}' not found at runtime`,
			});
			this.followFailureOrTerminal(step, `actor '${unwrap(step.actor)}' not found`);
			return;
		}

		// Build priorAttempts BEFORE emitting step_started, so the history we
		// pass to the actor contains only completed prior attempts — not the
		// one we're about to start. The audit log is the source of truth here
		// because the run state resets transcripts on re-entry.
		const priorAttemptHistory = buildAttemptHistories(this.audit.entries()).get(step.id) ?? [];
		const priorAttempts = priorAttemptHistory.map((entry): PriorAttempt => summarizePriorAttempt(entry));

		const attempt = (this.state.steps.get(step.id)?.attempts ?? 0) + 1;
		this.emit({
			kind: "step_started",
			at: this.clock(),
			stepId: step.id,
			attempt,
		});

		const snapshot = this.artifactStore.snapshot(step.reads);
		const priorCheckResult = this.lastCheckResult;
		this.lastCheckResult = undefined;

		const request: ActionRequest = {
			step,
			actor,
			artifacts: snapshot,
			artifactContracts: this.program.artifacts,
			cwd: this.cwd,
			signal: this.signal,
			priorAttempts,
			priorCheckResult,
			stepActorResolver: (sid) => {
				const s = this.program.steps.get(sid);
				return s?.kind === "action" ? unwrap(s.actor) : undefined;
			},
			onProgress: (progress) => {
				this.emit({
					kind: "action_progress",
					at: this.clock(),
					stepId: step.id,
					item: progress.item,
					usage: progress.usage,
				});
			},
		};

		let outcome: ActionOutcome;
		try {
			outcome = await this.actorEngine.runAction(request);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			outcome = {
				kind: "engine_error",
				reason,
				usage: emptyUsage(),
				transcript: [],
			};
		}

		switch (outcome.kind) {
			case "completed":
				this.handleActionCompleted(step, outcome.route, outcome.assistant_summary, outcome.writes, outcome.usage);
				return;
			case "no_completion":
				this.emit({
					kind: "action_no_completion",
					at: this.clock(),
					stepId: step.id,
					reason: outcome.reason,
					usage: outcome.usage,
				});
				this.applyRetryOrFail(step, outcome.reason);
				return;
			case "engine_error":
				this.emit({
					kind: "action_engine_error",
					at: this.clock(),
					stepId: step.id,
					reason: outcome.reason,
					usage: outcome.usage,
				});
				this.applyRetryOrFail(step, outcome.reason);
				return;
			case "aborted":
				this.emit({ kind: "run_aborted", at: this.clock() });
				return;
		}
	}

	private handleActionCompleted(
		step: ActionStep,
		route: RouteId,
		assistant_summary: string,
		writes: ReadonlyMap<ArtifactId, unknown>,
		usage: ActorUsage,
	): void {
		const currentAttempt = this.state.steps.get(step.id)?.attempts ?? 1;
		const commitResult = this.artifactStore.commit(step.id, writes, currentAttempt);
		if (!commitResult.ok) {
			this.emit({
				kind: "artifact_rejected",
				at: this.clock(),
				stepId: step.id,
				violation: commitResult.error,
			});
			this.applyRetryOrFail(step, `artifact commit rejected: ${commitResult.error.kind}`);
			return;
		}
		for (const artifactId of writes.keys()) {
			this.emit({
				kind: "artifact_committed",
				at: this.clock(),
				artifactId,
				writerStep: step.id,
			});
		}
		const targetId = this.program.edges.get(edgeKey(step.id, route));
		if (targetId) {
			const targetStep = this.program.steps.get(targetId);
			const targetReads =
				targetStep?.kind === "action" || targetStep?.kind === "command" ? targetStep.reads : undefined;
			if (targetReads && targetReads.length > 0) {
				const missingForTarget = targetReads.filter(
					(readId) => step.writes.includes(readId) && !writes.has(readId),
				);
				if (missingForTarget.length > 0) {
					const names = missingForTarget.map(unwrap).join(", ");
					this.applyRetryOrFail(
						step,
						`route '${unwrap(route)}' leads to step '${unwrap(targetId)}' which reads [${names}], but this step did not write them`,
					);
					return;
				}
			}
		}

		this.emit({
			kind: "action_completed",
			at: this.clock(),
			stepId: step.id,
			route,
			assistant_summary,
			usage,
		});
		this.followRoute(step.id, route);
	}

	private async executeCommand(step: CommandStep): Promise<void> {
		const attempt = (this.state.steps.get(step.id)?.attempts ?? 0) + 1;
		this.emit({
			kind: "step_started",
			at: this.clock(),
			stepId: step.id,
			attempt,
		});

		this.checkOutputChunks.set(step.id, []);
		this.checkOutputLens.set(step.id, 0);

		const onOutput = (text: string) => {
			const chunks = this.checkOutputChunks.get(step.id);
			if (!chunks) return;
			chunks.push(text);
			let len = (this.checkOutputLens.get(step.id) ?? 0) + text.length;
			while (len > MAX_CHECK_DISPLAY_BUFFER && chunks.length > 1) {
				len -= chunks.shift()!.length;
			}
			this.checkOutputLens.set(step.id, len);
			this.notifyOutputHandlers();
		};

		const inputDir = await this.writeArtifactInputDir(step.reads);
		const outputDir = step.writes.length > 0 ? await mkdtemp(join(tmpdir(), "pi-relay-output-")) : undefined;
		try {
			const extra: Record<string, string> = {};
			if (inputDir) extra.RELAY_INPUT = inputDir;
			if (outputDir) extra.RELAY_OUTPUT = outputDir;
			const env = buildShellEnv(extra);

			const resolvedCommand = this.shellCommandPrefix ? `${this.shellCommandPrefix}\n${step.command}` : step.command;

			const outcome = await runCommand(
				{ ...step, command: resolvedCommand },
				{ cwd: this.cwd, signal: this.signal, env, ops: this.ops },
				onOutput,
			);
			this.checkOutputChunks.delete(step.id);
			this.checkOutputLens.delete(step.id);

			if (outputDir) {
				await this.commitCommandWrites(step, outputDir, attempt);
			}

			const description = describeCommandStep(step);

			if (outcome.kind === "pass") {
				this.lastCheckResult = {
					stepId: step.id,
					outcome: "passed",
					description,
				};
				this.emit({
					kind: "check_passed",
					at: this.clock(),
					stepId: step.id,
					exitCode: outcome.exitCode,
					output: outcome.output,
				});
				this.followRoute(step.id, makeRouteId("success"));
			} else {
				const reason = outcome.reason ?? `exited with code ${outcome.exitCode ?? "unknown"}`;
				this.lastCheckResult = {
					stepId: step.id,
					outcome: "failed",
					description,
				};
				this.emit({
					kind: "check_failed",
					at: this.clock(),
					stepId: step.id,
					exitCode: outcome.exitCode,
					output: outcome.output,
					reason,
				});
				this.followRoute(step.id, makeRouteId("failure"));
			}
		} finally {
			if (inputDir) await rm(inputDir, { recursive: true, force: true }).catch(() => {});
			if (outputDir) await rm(outputDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	private async commitCommandWrites(step: CommandStep, outDir: string, attempt: number): Promise<void> {
		const declaredWrites = new Set(step.writes.map(unwrap));
		let entries: string[];
		try {
			entries = await readdir(outDir);
		} catch {
			return;
		}

		const writes = new Map<ArtifactId, unknown>();
		for (const fileName of entries) {
			if (!declaredWrites.has(fileName)) continue;
			const artifactId = makeArtifactId(fileName);
			const contract = this.program.artifacts.get(artifactId);
			if (!contract) continue;

			let raw: string;
			try {
				raw = await readFile(join(outDir, fileName), "utf-8");
			} catch {
				continue;
			}

			const value = parseCommandOutput(raw, contract.shape.kind);
			if (value === undefined) continue;
			writes.set(artifactId, value);
		}

		if (writes.size === 0) return;

		const commitResult = this.artifactStore.commit(step.id, writes, attempt);
		if (!commitResult.ok) {
			this.emit({
				kind: "artifact_rejected",
				at: this.clock(),
				stepId: step.id,
				violation: commitResult.error,
			});
			return;
		}
		for (const artifactId of writes.keys()) {
			this.emit({
				kind: "artifact_committed",
				at: this.clock(),
				artifactId,
				writerStep: step.id,
			});
		}
	}

	private async executeFilesExist(step: FilesExistStep): Promise<void> {
		const attempt = (this.state.steps.get(step.id)?.attempts ?? 0) + 1;
		this.emit({
			kind: "step_started",
			at: this.clock(),
			stepId: step.id,
			attempt,
		});

		const outcome = await runFilesExist(step, {
			cwd: this.cwd,
			signal: this.signal,
			ops: this.ops,
		});
		const description = describeCommandStep(step);

		if (outcome.kind === "pass") {
			this.lastCheckResult = {
				stepId: step.id,
				outcome: "passed",
				description,
			};
			this.emit({
				kind: "check_passed",
				at: this.clock(),
				stepId: step.id,
				exitCode: null,
				output: "",
			});
			this.followRoute(step.id, makeRouteId("success"));
		} else {
			this.lastCheckResult = {
				stepId: step.id,
				outcome: "failed",
				description,
			};
			this.emit({
				kind: "check_failed",
				at: this.clock(),
				stepId: step.id,
				exitCode: null,
				output: "",
				reason: outcome.reason ?? "check failed",
			});
			this.followRoute(step.id, makeRouteId("failure"));
		}
	}

	private executeTerminal(step: TerminalStep): void {
		this.emit({
			kind: "terminal_reached",
			at: this.clock(),
			stepId: step.id,
			outcome: step.outcome,
			summary: step.summary,
		});
		this.finishWith(step.outcome === "success" ? "succeeded" : "failed", step.summary);
	}

	// ==========================================================================
	// Internal: retry, routing, terminal
	// ==========================================================================

	private applyRetryOrFail(step: ActionStep, reason: string): void {
		const runtime = this.state.steps.get(step.id);
		const attempts = runtime?.attempts ?? 1;
		const maxAttempts = IMPLICIT_RETRY_ATTEMPTS;
		if (attempts < maxAttempts) {
			this.emit({
				kind: "step_retry_scheduled",
				at: this.clock(),
				stepId: step.id,
				nextAttempt: attempts + 1,
				reason,
			});
			this.readyQueue.unshift(step.id);
			return;
		}
		this.emit({
			kind: "step_failed",
			at: this.clock(),
			stepId: step.id,
			reason,
		});
		this.followFailureOrTerminal(step, `${SYNTHETIC_FAILURE_REASON_PREFIX}${reason}`);
	}

	private followFailureOrTerminal(step: ActionStep, reason: string): void {
		for (const candidate of FAILURE_ROUTE_CANDIDATES) {
			const routeId = makeRouteId(candidate);
			const target = this.program.edges.get(edgeKey(step.id, routeId));
			if (target !== undefined) {
				this.followRoute(step.id, routeId);
				return;
			}
		}
		this.finishWith("failed", reason);
	}

	private followRoute(fromStep: StepId, route: RouteId): void {
		const target = this.program.edges.get(edgeKey(fromStep, route));
		if (target === undefined) {
			this.finishWith(
				"incomplete",
				`no edge from '${unwrap(fromStep)}' on route '${unwrap(route)}'; plan is missing a handler for that outcome`,
			);
			return;
		}
		this.enqueueReady(target);
	}

	private async writeArtifactInputDir(reads: readonly ArtifactId[]): Promise<string | undefined> {
		if (reads.length === 0) return undefined;
		const snapshot = this.artifactStore.snapshot(reads);
		if (snapshot.ids().length === 0) return undefined;
		const dir = await mkdtemp(join(tmpdir(), "pi-relay-input-"));
		for (const id of reads) {
			if (!snapshot.has(id)) continue;
			const content = serializeForFile(snapshot.get(id));
			await writeFile(join(dir, unwrap(id)), content, "utf-8");
		}
		return dir;
	}
}

/**
 * Build a process environment that preserves Pi's managed bin directory on PATH.
 *
 * Mirrors the behavior of Pi's internal `getShellEnv()` (which is not exported):
 * ensures `{agentDir}/bin` is on PATH so commands have access to Pi-managed
 * binaries. Extra variables (e.g. RELAY_INPUT, RELAY_OUTPUT) are merged on top.
 *
 * Always called for command steps (even without extra vars) so the env
 * construction path is consistent, matching Pi's bash tool which always
 * passes env explicitly via `resolveSpawnContext`.
 */
const buildShellEnv = (extraEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv => {
	const binDir = join(getAgentDir(), "bin");
	const pathKey = Object.keys(process.env).find((k) => k.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);
	return {
		...process.env,
		[pathKey]: updatedPath,
		...extraEnv,
	};
};

const serializeForFile = (value: unknown): string => {
	if (isAccumulatedEntryArray(value)) {
		const latest = value[value.length - 1]!.value;
		return typeof latest === "string" ? latest : JSON.stringify(latest);
	}
	if (typeof value === "string") return value;
	return JSON.stringify(value);
};

const parseCommandOutput = (raw: string, shapeKind: ArtifactShape["kind"]): unknown | undefined => {
	if (shapeKind === "text") return raw;
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
};
