/**
 * Deterministic verification engine.
 *
 * Command and files_exist steps are evaluated by the runtime itself, outside of any LLM.
 * Each function takes its step type and a small context (working directory,
 * abort signal) and returns a structured outcome with exit code and output.
 *
 *   - `runCommand`          — pass iff the command runs and exits 0 within
 *                             the timeout; output is always captured (last
 *                             N lines) so both success and failure are visible
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
const TAIL_LINE_COUNT = 20;
const MAX_LINE_LENGTH = 256;
const MAX_OUTPUT_BUFFER = 32_000;

export interface CheckContext {
	readonly cwd: string;
	readonly signal?: AbortSignal;
	/** When present, a complete process environment (process.env + Pi bin dir + extra vars). */
	readonly env?: NodeJS.ProcessEnv;
	readonly ops: BashOperations;
}

export interface CheckOutcome {
	readonly type: "pass" | "fail";
	readonly exitCode: number | null;
	readonly output: string;
	readonly reason?: string;
}

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
	if (missing.length === 0) return { type: "pass", exitCode: null, output: "" };
	const label = missing.length === 1 ? "file does not exist" : "files do not exist";
	return { type: "fail", exitCode: null, output: "", reason: `${label}: ${missing.join(", ")}` };
};

export const runCommand = async (
	step: CommandStep,
	ctx: CheckContext,
	onOutput?: CheckOutputCallback,
): Promise<CheckOutcome> => {
	const timeoutMs = step.timeout ? step.timeout * 1000 : DEFAULT_COMMAND_TIMEOUT_MS;

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

	const drainOutput = (): string => tailLines(chunks.join(""));

	try {
		const { exitCode } = await ctx.ops.exec(step.command, ctx.cwd, {
			onData,
			signal: ctx.signal,
			timeout: timeoutMs / 1000,
			env: ctx.env,
		});

		if (exitCode === 0) return { type: "pass", exitCode: 0, output: drainOutput() };
		return {
			type: "fail",
			exitCode: exitCode ?? null,
			output: drainOutput(),
			reason: `exited with code ${exitCode ?? "unknown"}`,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const output = drainOutput();
		if (message === "aborted") {
			return { type: "fail", exitCode: null, output, reason: "check aborted" };
		}
		if (message.startsWith("timeout:")) {
			return { type: "fail", exitCode: null, output, reason: `timed out after ${timeoutMs}ms` };
		}
		return { type: "fail", exitCode: null, output, reason: `failed to spawn: ${message}` };
	}
};

/**
 * Keep the last `TAIL_LINE_COUNT` lines, each truncated to `MAX_LINE_LENGTH` chars.
 *
 * Errors cluster at the end of output (compiler errors after passing tests,
 * assertion failures after setup logs). Taking the tail captures the signal;
 * per-line truncation prevents a single minified blob from blowing up the report.
 */
export const tailLines = (text: string): string => {
	const trimmed = text.trim();
	if (trimmed.length === 0) return "";
	const lines = trimmed.split("\n");
	const start = Math.max(0, lines.length - TAIL_LINE_COUNT);
	const selected = lines.slice(start);
	const truncated = selected.map((line) =>
		line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line,
	);
	const prefix = start > 0 ? `… (${start} lines omitted)\n` : "";
	return `${prefix}${truncated.join("\n")}`;
};
