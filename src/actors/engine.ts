/**
 * Subprocess-backed actor execution engine.
 *
 * The engine runs each action step as a separate `pi` subprocess with a
 * custom system prompt (actor preamble + completion protocol instructions)
 * and the actor's restricted tool list. Progress events stream live via
 * stdin line-delimited JSON events from pi's `--mode json` output.
 *
 * Design choice: pi's extension API does not expose a way to invoke
 * registered tools from inside another tool. To let actors call bash/read/
 * edit/etc., we spawn pi recursively — the same mechanism subagent uses.
 * Each spawn gets context isolation as a side benefit (v0.1 only supports
 * `fresh_per_run`, which this model implements trivially).
 *
 * Invariants the engine enforces on the actor's behalf:
 *
 *   1. The actor's picked route must be one the step declared. Unknown
 *      routes collapse the outcome to `no_completion`.
 *   2. Only artifacts listed in the step's `writes` are accepted. Extra
 *      ids in the completion JSON are silently dropped.
 *   3. Abort propagates from the user's signal to the subprocess via
 *      SIGTERM, escalating to SIGKILL after 5 seconds.
 *
 * The engine does NOT enforce artifact shape — that is the
 * `ArtifactStore.commit` call's job at the scheduler layer.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { ArtifactId as ArtifactIdType } from "../plan/ids.js";
import { ArtifactId, RouteId, unwrap } from "../plan/ids.js";
import { buildCompletionInstruction, parseCompletion } from "./complete-step.js";
import {
	type ActionOutcome,
	type ActionRequest,
	type ActorEngine,
	type ActorUsage,
	emptyUsage,
	type TranscriptItem,
} from "./types.js";

const SIGKILL_GRACE_MS = 5000;

/**
 * Production actor engine that spawns pi subprocesses.
 *
 * Implemented as a factory returning an `ActorEngine` so tests can substitute
 * a fake engine directly (see phase 5 scheduler tests).
 */
export const createSubprocessActorEngine = (): ActorEngine => ({
	runAction,
});

const runAction = async (request: ActionRequest): Promise<ActionOutcome> => {
	const { actor, step, artifacts, artifactContracts, cwd, signal, onProgress } = request;

	const systemPromptText = buildSystemPrompt(actor.systemPrompt, {
		routes: step.routes.map((r) => r.route),
		writableArtifactIds: step.writes,
		artifactContracts,
	});

	const taskPrompt = buildTaskPrompt(
		step.instruction,
		step.reads,
		artifacts,
		artifactContracts,
		request.priorAttempts,
	);

	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;

	try {
		const written = await writePromptToTempFile(actor.name, systemPromptText);
		tmpDir = written.dir;
		tmpPromptPath = written.filePath;

		const args: string[] = ["--mode", "json", "-p", "--no-session"];
		if (actor.model) args.push("--model", actor.model);
		if (actor.thinking) args.push("--thinking", actor.thinking);
		if (actor.tools && actor.tools.length > 0) args.push("--tools", actor.tools.join(","));
		args.push("--append-system-prompt", tmpPromptPath);
		args.push(taskPrompt);

		const invocation = getPiInvocation(args);
		const result = await spawnAndStream(invocation, cwd, signal, {
			onProgress,
			stepId: step.id,
			actorId: step.actor,
		});

		if (result.aborted) {
			return { kind: "aborted", usage: result.usage, transcript: result.transcript };
		}
		if (result.spawnError) {
			return {
				kind: "engine_error",
				reason: result.spawnError,
				usage: result.usage,
				transcript: result.transcript,
			};
		}
		if (result.exitCode !== 0) {
			return {
				kind: "engine_error",
				reason: `pi subprocess exited with code ${result.exitCode}${
					result.stderr ? `: ${truncate(result.stderr, 500)}` : ""
				}`,
				usage: result.usage,
				transcript: result.transcript,
			};
		}

		const finalText = extractFinalAssistantText(result.messages);
		const parsed = parseCompletion(finalText);
		if (!parsed.ok) {
			const tail = truncate(finalText.trim(), 600) || "(actor produced no text output)";
			return {
				kind: "no_completion",
				reason: `${parsed.error}. Actor's final reply ended with: "${tail}"`,
				usage: result.usage,
				transcript: result.transcript,
			};
		}

		const routeId = RouteId(parsed.value.route);
		const routeAllowed = step.routes.some((r) => r.route === routeId);
		if (!routeAllowed) {
			return {
				kind: "no_completion",
				reason: `route '${parsed.value.route}' is not one of the allowed routes: ${step.routes
					.map((r) => unwrap(r.route))
					.join(", ")}`,
				usage: result.usage,
				transcript: result.transcript,
			};
		}

		const allowedWrites = new Set<ArtifactIdType>(step.writes);
		const writes = new Map<ArtifactIdType, unknown>();
		for (const [idStr, value] of Object.entries(parsed.value.writes)) {
			const id = ArtifactId(idStr);
			if (!allowedWrites.has(id)) continue;
			writes.set(id, value);
		}

		return { kind: "completed", route: routeId, writes, usage: result.usage, transcript: result.transcript };
	} finally {
		if (tmpPromptPath) {
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				// ignore
			}
		}
		if (tmpDir) {
			try {
				fs.rmdirSync(tmpDir);
			} catch {
				// ignore
			}
		}
	}
};

// ============================================================================
// Prompt building
// ============================================================================

const buildSystemPrompt = (
	actorPreamble: string,
	completion: Parameters<typeof buildCompletionInstruction>[0],
): string => {
	const sections: string[] = [];
	const preamble = actorPreamble.trim();
	if (preamble.length > 0) sections.push(preamble);
	sections.push(buildCompletionInstruction(completion));
	return sections.join("\n\n");
};

const buildTaskPrompt = (
	instruction: string,
	reads: readonly ArtifactIdType[],
	artifacts: ActionRequest["artifacts"],
	contracts: ReadonlyMap<ArtifactIdType, { description: string }>,
	priorAttempts: ActionRequest["priorAttempts"],
): string => {
	const lines: string[] = [`Task: ${instruction}`];

	// When this is a re-entry of a back-edge, tell the actor what it did
	// before. Without this, every attempt looks to the actor like its first
	// and a review/fix loop can spin producing the same output forever.
	if (priorAttempts.length > 0) {
		const history: string[] = [];
		const capped = priorAttempts.slice(-3);
		const skipped = priorAttempts.length - capped.length;
		if (skipped > 0) {
			history.push(`_(${skipped} earlier attempt${skipped === 1 ? "" : "s"} omitted)_`);
		}
		for (const attempt of capped) {
			const tools =
				attempt.toolsCalled.length > 0 ? `tools used: ${attempt.toolsCalled.join(", ")}` : "no tools used";
			const narrationLine = attempt.narration.length > 0 ? `  "${attempt.narration}"` : "  (no narration)";
			history.push(`### Attempt ${attempt.attemptNumber} → ${attempt.outcomeLabel}`, `  ${tools}`, narrationLine);
		}
		lines.push(
			"## Previous attempts at this step",
			"",
			"You have already run this step. Relay routed control back here through a",
			"back-edge in the plan. Previous attempts:",
			"",
			history.join("\n\n"),
			"",
			"The input artifacts and the filesystem may have been updated since those",
			"attempts — re-read anything you need to verify. Do not repeat the same",
			"work blindly. If a prior attempt failed, understand why before retrying.",
		);
	}

	if (reads.length > 0) {
		const inputs: string[] = [];
		for (const id of reads) {
			if (!artifacts.has(id)) continue;
			const contract = contracts.get(id);
			const descSuffix = contract?.description ? ` (${contract.description})` : "";
			const value = artifacts.get(id);
			inputs.push(`- ${unwrap(id)}${descSuffix}:\n${fenceJson(value)}`);
		}
		if (inputs.length > 0) {
			lines.push("## Input artifacts (current values)", "", inputs.join("\n\n"));
		}
	}

	// Visible recency reminder. The completion protocol is in the system prompt
	// but models often forget it when they get absorbed in the task. Restating
	// the requirement in the user message makes it hard to miss.
	lines.push(
		"## Completion reminder",
		"",
		'When you are done, your reply MUST end with a single line of the form `<relay-complete>{"route":"<ROUTE>","writes":{...}}</relay-complete>`, using one of the allowed routes from the Relay completion protocol section of your system prompt. Everything before that line is freeform narration; the tag itself is the only thing Relay reads.',
	);
	return lines.join("\n\n");
};

const fenceJson = (value: unknown): string => {
	try {
		return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
	} catch {
		return "```\n<unserializable>\n```";
	}
};

// ============================================================================
// Subprocess spawn + streaming
// ============================================================================

interface SubprocessResult {
	readonly aborted: boolean;
	readonly spawnError: string | null;
	readonly exitCode: number;
	readonly stderr: string;
	readonly messages: readonly Message[];
	readonly usage: ActorUsage;
	readonly transcript: readonly TranscriptItem[];
}

interface SpawnOptions {
	readonly onProgress: ActionRequest["onProgress"];
	readonly stepId: ActionRequest["step"]["id"];
	readonly actorId: ActionRequest["step"]["actor"];
}

const spawnAndStream = (
	invocation: { command: string; args: readonly string[] },
	cwd: string,
	signal: AbortSignal | undefined,
	opts: SpawnOptions,
): Promise<SubprocessResult> =>
	new Promise((resolve) => {
		const messages: Message[] = [];
		const transcript: TranscriptItem[] = [];
		const usage = mutableUsage();
		let stderr = "";
		let aborted = false;
		let spawnError: string | null = null;

		const proc = spawn(invocation.command, [...invocation.args], {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buffer = "";
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (typeof event !== "object" || event === null) return;
			const envelope = event as { type?: string; message?: Message };

			if (envelope.type === "message_end" && envelope.message) {
				const msg = envelope.message;
				messages.push(msg);
				if (msg.role === "assistant") {
					usage.turns += 1;
					if (msg.usage) {
						usage.input += msg.usage.input ?? 0;
						usage.output += msg.usage.output ?? 0;
						usage.cacheRead += msg.usage.cacheRead ?? 0;
						usage.cacheWrite += msg.usage.cacheWrite ?? 0;
						usage.cost += msg.usage.cost?.total ?? 0;
						usage.contextTokens = msg.usage.totalTokens ?? usage.contextTokens;
					}
					for (const part of msg.content) {
						if (part.type === "text" && part.text.length > 0) {
							const item: TranscriptItem = { kind: "text", text: part.text };
							transcript.push(item);
							opts.onProgress?.({ stepId: opts.stepId, actor: opts.actorId, item, usage: snapshotUsage(usage) });
						} else if (part.type === "toolCall") {
							const item: TranscriptItem = {
								kind: "tool_call",
								toolName: part.name,
								args: part.arguments,
							};
							transcript.push(item);
							opts.onProgress?.({ stepId: opts.stepId, actor: opts.actorId, item, usage: snapshotUsage(usage) });
						}
					}
				}
			} else if (envelope.type === "tool_result_end" && envelope.message) {
				messages.push(envelope.message);
			}
		};

		proc.stdout.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});

		proc.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.on("error", (error) => {
			spawnError = error instanceof Error ? error.message : String(error);
			resolve({
				aborted,
				spawnError,
				exitCode: 1,
				stderr,
				messages,
				usage: snapshotUsage(usage),
				transcript,
			});
		});

		proc.on("close", (code) => {
			if (buffer.trim().length > 0) handleLine(buffer);
			resolve({
				aborted,
				spawnError,
				exitCode: code ?? 0,
				stderr,
				messages,
				usage: snapshotUsage(usage),
				transcript,
			});
		});

		if (signal) {
			const onAbort = () => {
				aborted = true;
				proc.kill("SIGTERM");
				const hard = setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, SIGKILL_GRACE_MS);
				hard.unref?.();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});

// ============================================================================
// Pi invocation helpers (mirroring subagent/index.ts)
// ============================================================================

const getPiInvocation = (args: readonly string[]): { command: string; args: string[] } => {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: [...args] };
	}
	return { command: "pi", args: [...args] };
};

const writePromptToTempFile = async (actorName: string, prompt: string): Promise<{ dir: string; filePath: string }> => {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-relay-actor-"));
	const safeName = actorName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(dir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir, filePath };
};

// ============================================================================
// Misc helpers
// ============================================================================

type MutableUsage = { -readonly [K in keyof ActorUsage]: ActorUsage[K] };

const mutableUsage = (): MutableUsage => ({ ...emptyUsage() });

const snapshotUsage = (u: MutableUsage): ActorUsage => ({ ...u });

/**
 * Extract the concatenated text of the LAST assistant message.
 *
 * Walks backward through the transcript to find the most recent assistant
 * message, then joins every `text` part in that message in order. We must
 * concatenate (not take the first part) because the completion protocol
 * asks for the tag as the FINAL thing in the reply, and an assistant
 * message may carry narration + tag across multiple text parts interleaved
 * with thinking blocks.
 */
const extractFinalAssistantText = (messages: readonly Message[]): string => {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!msg || msg.role !== "assistant") continue;
		const parts: string[] = [];
		for (const part of msg.content) {
			if (part.type === "text" && part.text.length > 0) parts.push(part.text);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return "";
};

const truncate = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);
