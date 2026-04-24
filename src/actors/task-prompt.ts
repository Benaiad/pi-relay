/**
 * Task prompt builder for action steps.
 *
 * Builds the user message sent to the actor at the start of each invocation.
 * Includes the step instruction, input artifact values, prior attempt history
 * (for back-edge re-entries), and prior check results (for command/files_exist
 * steps that preceded this action).
 *
 * Shared between engine implementations — the prompt content is independent
 * of whether the actor runs in a subprocess or in-process.
 */

import type { ArtifactId, StepId } from "../plan/ids.js";
import { unwrap } from "../plan/ids.js";
import type { ArtifactContract, ArtifactShape } from "../plan/types.js";
import { isAccumulatedEntryArray } from "../runtime/accumulated-entry.js";
import { renderValue } from "./render-value.js";
import type { ActionRequest, PriorAttempt, PriorCheckResult } from "./types.js";

export const buildTaskPrompt = (
	instruction: string,
	reads: readonly ArtifactId[],
	artifacts: ActionRequest["artifacts"],
	contracts: ReadonlyMap<ArtifactId, ArtifactContract>,
	priorAttempts: readonly PriorAttempt[],
	actorName: string,
	stepId: StepId,
	stepActorResolver?: (stepId: StepId) => string | undefined,
	priorCheckResult?: PriorCheckResult,
): string => {
	const lines: string[] = [`You are: ${actorName} (step: ${unwrap(stepId)})`];

	if (priorCheckResult) {
		lines.push(
			"",
			"## Prior check result",
			"",
			`step: ${unwrap(priorCheckResult.stepId)} ${priorCheckResult.outcome}`,
			`  ${priorCheckResult.description}`,
		);
	}

	lines.push("", `Task: ${instruction}`);

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
		const missing: string[] = [];
		for (const id of reads) {
			if (!artifacts.has(id)) {
				missing.push(unwrap(id));
				continue;
			}
			const contract = contracts.get(id);
			const value = artifacts.get(id);
			inputs.push(renderArtifact(unwrap(id), contract, value, stepActorResolver));
		}
		if (inputs.length > 0) {
			lines.push("## Input artifacts", "", inputs.join("\n\n"));
		}
		if (missing.length > 0) {
			lines.push(
				"## Missing artifacts",
				"",
				`The following artifacts were expected but not produced by any prior step: ${missing.join(", ")}.`,
				"This may mean a prior step chose a route that skipped writing them.",
			);
		}
	}

	return lines.join("\n\n");
};

export const formatShapeHint = (shape: ArtifactShape): string => {
	switch (shape.type) {
		case "text":
			return "    Value: plain text";
		case "record":
			return `    Fields: ${shape.fields.join(", ")}`;
		case "record_list":
			return `    Fields (list): ${shape.fields.join(", ")}\n    Produce one entry per item found.`;
	}
};

const renderArtifact = (
	id: string,
	contract: ArtifactContract | undefined,
	value: unknown,
	stepActorResolver?: (stepId: StepId) => string | undefined,
): string => {
	const description = contract?.description ?? "";
	const descSuffix = description ? ` (${description})` : "";
	const shapeHint = contract ? formatShapeHint(contract.shape) : "";

	if (isAccumulatedEntryArray(value)) {
		const header = `### ${id}${descSuffix} — ${value.length} ${value.length === 1 ? "entry" : "entries"}`;
		const headerWithShape = shapeHint ? `${header}\n${shapeHint}` : header;
		const entries = value.map((entry) => {
			const actor = stepActorResolver?.(entry.stepId) ?? unwrap(entry.stepId);
			const attemptSuffix = entry.attempt > 1 ? `, attempt ${entry.attempt}` : "";
			const attribution = `[${entry.index + 1}] by ${actor} (step: ${unwrap(entry.stepId)}${attemptSuffix}):`;
			return `${attribution}\n${renderValue(entry.value, 1)}`;
		});
		return `${headerWithShape}\n\n${entries.join("\n\n")}`;
	}

	const header = `### ${id}${descSuffix}`;
	const headerWithShape = shapeHint ? `${header}\n${shapeHint}` : header;
	return `${headerWithShape}\n\n${renderValue(value, 0)}`;
};

export const truncate = (text: string, limit: number): string =>
	text.length <= limit ? text : `${text.slice(0, limit)}…`;
