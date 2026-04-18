/**
 * Deterministic check engine.
 *
 * Checks are verification steps the runtime evaluates itself, outside of any
 * LLM. They take a `CheckSpec` and a small context (working directory, abort
 * signal) and return `pass` or `fail`. The scheduler routes the step based
 * on the outcome.
 *
 * v0.1 supports two kinds:
 *
 *   - `file_exists`        — pass iff the path exists on the filesystem
 *   - `command_exits_zero` — pass iff the command runs and exits 0 within the
 *                            timeout; output is captured for the failure
 *                            reason so the model can see why
 *
 * Checks never call an LLM, never read or write artifacts, and always
 * terminate within their declared timeout. Command execution delegates to
 * Pi's `createLocalBashOperations()` for process tree cleanup, cross-platform
 * shell resolution, and abort handling.
 */

import { access, constants } from "node:fs/promises";
import * as path from "node:path";
import { createLocalBashOperations } from "@mariozechner/pi-coding-agent";
import type { CheckSpec } from "../plan/types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_OUTPUT_REASON_LIMIT = 800;

const ops = createLocalBashOperations();

export interface CheckContext {
	readonly cwd: string;
	readonly signal?: AbortSignal;
}

export type CheckOutcome = { readonly kind: "pass" } | { readonly kind: "fail"; readonly reason: string };

export const runCheck = async (spec: CheckSpec, ctx: CheckContext): Promise<CheckOutcome> => {
	switch (spec.kind) {
		case "file_exists":
			return runFileExists(spec, ctx);
		case "command_exits_zero":
			return runCommandExitsZero(spec, ctx);
	}
};

const runFileExists = async (
	spec: Extract<CheckSpec, { kind: "file_exists" }>,
	ctx: CheckContext,
): Promise<CheckOutcome> => {
	const resolved = path.isAbsolute(spec.path) ? spec.path : path.resolve(ctx.cwd, spec.path);
	try {
		await access(resolved, constants.F_OK);
		return { kind: "pass" };
	} catch {
		return { kind: "fail", reason: `file does not exist: ${spec.path}` };
	}
};

const runCommandExitsZero = async (
	spec: Extract<CheckSpec, { kind: "command_exits_zero" }>,
	ctx: CheckContext,
): Promise<CheckOutcome> => {
	const timeoutMs = spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const cwd = spec.cwd ? (path.isAbsolute(spec.cwd) ? spec.cwd : path.resolve(ctx.cwd, spec.cwd)) : ctx.cwd;

	let output = "";
	const onData = (data: Buffer) => {
		output += data.toString();
	};

	try {
		const { exitCode } = await ops.exec(spec.command, cwd, {
			onData,
			signal: ctx.signal,
			timeout: timeoutMs / 1000,
		});

		if (exitCode === 0) return { kind: "pass" };
		return { kind: "fail", reason: formatCommandFailure(spec.command, exitCode, output) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message === "aborted") {
			return { kind: "fail", reason: "check aborted" };
		}
		if (message.startsWith("timeout:")) {
			return { kind: "fail", reason: `command timed out after ${timeoutMs}ms: ${spec.command}` };
		}
		return { kind: "fail", reason: `failed to spawn ${spec.command}: ${message}` };
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
