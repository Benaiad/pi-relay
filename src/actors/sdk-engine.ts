/**
 * In-process actor execution engine.
 *
 * Runs each action step as an in-process `AgentSession` via pi's SDK instead
 * of spawning a subprocess. The completion protocol is a terminating tool call
 * (`relay_complete`) whose schema is dynamically constructed per step from
 * the step's declared routes and writable artifacts.
 *
 * Benefits over the subprocess engine:
 *   - Schema enforcement at the API level — no XML parsing.
 *   - Less prompt overhead — the model calls a tool instead of emitting XML.
 *   - No temp file management, no process spawning, no JSON line parsing.
 *
 * Each `runAction` call creates a fresh session, sends one prompt, reads the
 * structured result from the completion tool's details, disposes the session,
 * and returns an `ActionOutcome`. Same isolation semantics as the subprocess
 * engine — no session reuse across steps.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ArtifactId as ArtifactIdType } from "../plan/ids.js";
import { ArtifactId, RouteId, unwrap } from "../plan/ids.js";
import { buildCompletionTool, type CompletionDetails } from "./completion-tool.js";
import { buildTaskPrompt } from "./task-prompt.js";
import {
	type ActionOutcome,
	type ActionRequest,
	type ActorEngine,
	type ActorUsage,
	emptyUsage,
	type TranscriptItem,
} from "./types.js";

const RELAY_COMPLETE_TOOL = "relay_complete";

export interface SdkEngineConfig {
	readonly modelRegistry: ModelRegistry;
	readonly defaultModel: Model<Api> | undefined;
}

export const createSdkActorEngine = (config: SdkEngineConfig): ActorEngine => ({
	runAction: (request) => runAction(config, request),
});

// ============================================================================
// Core execution
// ============================================================================

const runAction = async (config: SdkEngineConfig, request: ActionRequest): Promise<ActionOutcome> => {
	const { actor, step, artifacts, artifactContracts, cwd, signal, onProgress } = request;

	const resolvedModel = resolveModel(actor.model, config);
	if (!resolvedModel) {
		return {
			kind: "engine_error",
			reason: actor.model
				? `model "${actor.model}" not found or not authenticated in the model registry`
				: "no model configured for actor and no default model available",
			usage: emptyUsage(),
			transcript: [],
		};
	}

	const completionTool = buildCompletionTool([...step.routes.keys()], step.writes, artifactContracts);

	const taskPrompt = buildTaskPrompt(
		step.instruction,
		step.reads,
		artifacts,
		artifactContracts,
		request.priorAttempts,
		actor.name,
		step.id,
		request.stepActorResolver,
		request.priorCheckResult,
	);

	const actorTools = actor.tools ? [...actor.tools, RELAY_COMPLETE_TOOL] : [RELAY_COMPLETE_TOOL];

	const agentDir = getAgentDir();
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		appendSystemPrompt: actor.systemPrompt.trim().length > 0 ? [actor.systemPrompt] : undefined,
	});
	await resourceLoader.reload();

	const { session } = await createAgentSession({
		cwd,
		model: resolvedModel,
		thinkingLevel: actor.thinking ?? "medium",
		tools: actorTools,
		customTools: [completionTool],
		sessionManager: SessionManager.inMemory(cwd),
		modelRegistry: config.modelRegistry,
		settingsManager,
		resourceLoader,
	});

	const transcript: TranscriptItem[] = [];
	const usage = mutableUsage();

	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
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
					onProgress?.({
						stepId: step.id,
						actor: step.actor,
						item,
						usage: snapshotUsage(usage),
					});
				}
			}
		}

		if (event.type === "tool_execution_start" && event.toolName !== RELAY_COMPLETE_TOOL) {
			const item: TranscriptItem = {
				kind: "tool_call",
				toolName: event.toolName,
				args: event.args as Record<string, unknown>,
			};
			transcript.push(item);
			onProgress?.({
				stepId: step.id,
				actor: step.actor,
				item,
				usage: snapshotUsage(usage),
			});
		}
	});

	try {
		await session.prompt(taskPrompt);
	} catch (error: unknown) {
		if (signal?.aborted) {
			return { kind: "aborted", usage: snapshotUsage(usage), transcript };
		}
		const reason = error instanceof Error ? error.message : String(error);
		return {
			kind: "engine_error",
			reason: `agent session failed: ${reason}`,
			usage: snapshotUsage(usage),
			transcript,
		};
	} finally {
		unsubscribe();
		session.dispose();
	}

	if (signal?.aborted) {
		return { kind: "aborted", usage: snapshotUsage(usage), transcript };
	}

	const completion = extractCompletion(session.messages);
	if (!completion) {
		const lastText = extractLastAssistantText(session.messages);
		const tail = truncate(lastText.trim(), 600) || "(actor produced no text output)";
		return {
			kind: "no_completion",
			reason: `actor did not call relay_complete. Final reply ended with: "${tail}"`,
			usage: snapshotUsage(usage),
			transcript,
		};
	}

	const routeId = RouteId(completion.route);
	if (!step.routes.has(routeId)) {
		return {
			kind: "no_completion",
			reason: `route '${completion.route}' is not one of the allowed routes: ${[...step.routes.keys()]
				.map(unwrap)
				.join(", ")}`,
			usage: snapshotUsage(usage),
			transcript,
		};
	}

	const allowedWrites = new Set<ArtifactIdType>(step.writes);
	const writes = new Map<ArtifactIdType, unknown>();
	for (const [idStr, value] of Object.entries(completion.artifacts)) {
		const id = ArtifactId(idStr);
		if (!allowedWrites.has(id)) continue;
		writes.set(id, value);
	}

	return {
		kind: "completed",
		route: routeId,
		writes,
		usage: snapshotUsage(usage),
		transcript,
	};
};

// ============================================================================
// Model resolution
// ============================================================================

/**
 * Resolve an actor's model string to a `Model` object.
 *
 * Supports bare model ids (`"claude-sonnet-4-5"`) and `provider/modelId`
 * format (`"anthropic/claude-sonnet-4-5"`). Falls back to the engine's
 * default model when the actor config doesn't specify one.
 */
const resolveModel = (modelString: string | undefined, config: SdkEngineConfig): Model<Api> | undefined => {
	if (!modelString) return config.defaultModel;

	const available = config.modelRegistry.getAvailable();

	const slashIndex = modelString.indexOf("/");
	if (slashIndex !== -1) {
		const provider = modelString.substring(0, slashIndex);
		const modelId = modelString.substring(slashIndex + 1);
		const match = config.modelRegistry.find(provider, modelId);
		if (match) return match;
	}

	const lower = modelString.toLowerCase();
	const byId = available.find((m) => m.id.toLowerCase() === lower);
	if (byId) return byId;

	const byPartial = available.find(
		(m) => m.id.toLowerCase().includes(lower) || (m.name?.toLowerCase().includes(lower) ?? false),
	);
	return byPartial ?? config.defaultModel;
};

// ============================================================================
// Completion extraction
// ============================================================================

/**
 * Find the `relay_complete` tool result in the session messages and extract
 * the structured completion details.
 *
 * Walks backward to find the most recent tool result for `relay_complete`.
 * The `details` field carries the route and artifact values set by the tool's
 * execute function — no parsing needed.
 */
const extractCompletion = (messages: readonly AgentMessage[]): CompletionDetails | undefined => {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!msg || !isToolResultMessage(msg)) continue;
		if (msg.toolName !== RELAY_COMPLETE_TOOL) continue;
		const details = msg.details as CompletionDetails | undefined;
		if (details?.route) return details;
	}
	return undefined;
};

const isToolResultMessage = (msg: AgentMessage): msg is ToolResultMessage =>
	"role" in msg && (msg as { role: string }).role === "toolResult";

const isAssistantMessage = (msg: AgentMessage): msg is AssistantMessage =>
	"role" in msg && (msg as { role: string }).role === "assistant";

/**
 * Extract the concatenated text of the last assistant message.
 * Used for diagnostic output when the actor fails to call `relay_complete`.
 */
const extractLastAssistantText = (messages: readonly AgentMessage[]): string => {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (!msg || !isAssistantMessage(msg)) continue;
		const parts: string[] = [];
		for (const part of msg.content) {
			if (part.type === "text" && part.text.length > 0) parts.push(part.text);
		}
		if (parts.length > 0) return parts.join("\n");
	}
	return "";
};

// ============================================================================
// Usage tracking
// ============================================================================

type MutableUsage = { -readonly [K in keyof ActorUsage]: ActorUsage[K] };

const mutableUsage = (): MutableUsage => ({ ...emptyUsage() });

const snapshotUsage = (u: MutableUsage): ActorUsage => ({ ...u });

const truncate = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);
