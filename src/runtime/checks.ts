/**
 * Deterministic verification engine.
 *
 * Command and files_exist steps are evaluated by the runtime itself, outside of any LLM.
 * Each function takes its step type and a small context (working directory,
 * abort signal) and returns `pass` or `fail`. The scheduler routes the step
 * based on the outcome.
 *
 *   - `runCommand`          — pass iff the command runs and exits 0 within
 *                             the timeout; output is captured for the failure
 *                             reason so the model can see why
 *   - `runFilesExist`       — pass iff every listed path exists on the
 *                             filesystem
 *
 * These steps never call an LLM and always terminate within their declared
 * timeout. Command steps may read artifacts (from $RELAY_INPUT) and write
 * artifacts (to $RELAY_OUTPUT). Command execution uses a `BashOperations`
 * instance (provided via `CheckContext`) for process tree cleanup,
 * cross-platform shell resolution, and abort handling.
 */

import { access, constants } from "node:fs/promises";
import * as path from "node:path";
import type { BashOperations } from "@mariozechner/pi-coding-agent";
import type { CommandStep, FilesExistStep } from "../plan/types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const COMMAND_OUTPUT_REASON_LIMIT = 800;
const MAX_OUTPUT_BUFFER = COMMAND_OUTPUT_REASON_LIMIT * 4;

export interface CheckContext {
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/** When present, a complete process environment (process.env + Pi bin dir + extra vars). */
	readonly env?: NodeJS.ProcessEnv;
	readonly ops: BashOperations;
}

export type CheckOutcome = { readonly kind: "pass" } | { readonly kind: "fail"; readonly reason: string };

export type CheckOutputCallback = (text: string) => void;

export const runFilesExist = async (step: FilesExistStep, ctx: CheckContext): Promise<CheckOutcome> => {
	const missing: string[] = [];
	for (const p of step.paths) {
		const resolved = path.isAbsolute(p) ? p : path.resolve(ctx.cwd, p);
		try {
			await access(resolved, constants.F_OK);
		} catch {
			missing.push(p);
		}
	}
	if (missing.length === 0) return { kind: "pass" };
	const label = missing.length === 1 ? "file does not exist" : "files do not exist";
	return { kind: "fail", reason: `${label}: ${missing.join(", ")}` };
};

export const runCommand = async (
	step: CommandStep,
	ctx: CheckContext,
	onOutput?: CheckOutputCallback,
): Promise<CheckOutcome> => {
	const timeoutMs = step.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

	const chunks: string[] = [];
	let chunksLen = 0;

	const onData = (data: Buffer) => {
		const text = data.toString();
		chunks.push(text);
		chunksLen += text.length;
		while (chunksLen > MAX_OUTPUT_BUFFER && chunks.length > 1) {
			chunksLen -= chunks.shift()!.length;
		}
		onOutput?.(text);
	};

	const drainOutput = (): string => chunks.join("");

	try {
		const { exitCode } = await ctx.ops.exec(step.command, ctx.cwd, {
			onData,
			signal: ctx.signal,
			timeout: timeoutMs / 1000,
			env: ctx.env,
		});

		if (exitCode === 0) return { kind: "pass" };
		return {
			kind: "fail",
			reason: formatCommandFailure(step.command, exitCode, drainOutput()),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const captured = truncateOutput(drainOutput());
		const outputSuffix = captured.length > 0 ? `; output: ${captured}` : "";
		if (message === "aborted") {
			return { kind: "fail", reason: `check aborted${outputSuffix}` };
		}
		if (message.startsWith("timeout:")) {
			return {
				kind: "fail",
				reason: `command timed out after ${timeoutMs}ms: ${step.command}${outputSuffix}`,
			};
		}
		return {
			kind: "fail",
			reason: `failed to spawn ${step.command}: ${message}`,
		};
	}
};

const formatCommandFailure = (command: string, code: number | null, output: string): string => {
	const prefix = `${command} exited with code ${code ?? "unknown"}`;
	const trimmed = truncateOutput(output);
	return trimmed.length > 0 ? `${prefix}; output: ${trimmed}` : prefix;
};

const truncateOutput = (text: string): string => {
	const trimmed = text.trim();
	if (trimmed.length <= COMMAND_OUTPUT_REASON_LIMIT) return trimmed;
	return `${trimmed.slice(0, COMMAND_OUTPUT_REASON_LIMIT)}… (truncated)`;
};
