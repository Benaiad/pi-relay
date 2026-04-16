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
 *                            timeout; stdout/stderr are captured for the
 *                            failure reason so the model can see why
 *
 * Checks never call an LLM, never read or write artifacts, and always
 * terminate within their declared timeout. If a check's timeout fires, the
 * process is killed (SIGTERM then SIGKILL after 1 second) and the check
 * fails with a timeout reason.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import * as path from "node:path";
import type { CheckSpec } from "../plan/types.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_OUTPUT_REASON_LIMIT = 800;

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

const runCommandExitsZero = (
	spec: Extract<CheckSpec, { kind: "command_exits_zero" }>,
	ctx: CheckContext,
): Promise<CheckOutcome> => {
	const timeoutMs = spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const cwd = spec.cwd ? (path.isAbsolute(spec.cwd) ? spec.cwd : path.resolve(ctx.cwd, spec.cwd)) : ctx.cwd;

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (outcome: CheckOutcome) => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};

		const proc = spawn(spec.command, [], {
			cwd,
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const softTimer = setTimeout(() => {
			proc.kill("SIGTERM");
			const hardTimer = setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 1000);
			hardTimer.unref?.();
			settle({
				kind: "fail",
				reason: `command timed out after ${timeoutMs}ms: ${spec.command}`,
			});
		}, timeoutMs);
		softTimer.unref?.();

		const onAbort = () => {
			proc.kill("SIGTERM");
			settle({ kind: "fail", reason: "check aborted" });
		};
		if (ctx.signal) {
			if (ctx.signal.aborted) {
				onAbort();
				return;
			}
			ctx.signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.on("error", (error) => {
			clearTimeout(softTimer);
			ctx.signal?.removeEventListener("abort", onAbort);
			settle({
				kind: "fail",
				reason: `failed to spawn ${spec.command}: ${error instanceof Error ? error.message : String(error)}`,
			});
		});

		proc.on("close", (code, signal) => {
			clearTimeout(softTimer);
			ctx.signal?.removeEventListener("abort", onAbort);
			if (code === 0) {
				settle({ kind: "pass" });
				return;
			}
			settle({
				kind: "fail",
				reason: formatCommandFailure(spec.command, code, signal, stdout, stderr),
			});
		});
	});
};

const formatCommandFailure = (
	command: string,
	code: number | null,
	signal: NodeJS.Signals | null,
	stdout: string,
	stderr: string,
): string => {
	const status = signal ? `killed by signal ${signal}` : `exited with code ${code ?? "unknown"}`;
	const prefix = `${command} ${status}`;
	const combined = [
		stderr.length > 0 ? `stderr: ${truncateOutput(stderr)}` : null,
		stdout.length > 0 ? `stdout: ${truncateOutput(stdout)}` : null,
	]
		.filter((x): x is string => x !== null)
		.join(" | ");
	return combined.length > 0 ? `${prefix}; ${combined}` : prefix;
};

const truncateOutput = (text: string): string => {
	const trimmed = text.trim();
	if (trimmed.length <= COMMAND_OUTPUT_REASON_LIMIT) return trimmed;
	return `${trimmed.slice(0, COMMAND_OUTPUT_REASON_LIMIT)}… (truncated)`;
};
