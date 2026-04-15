/**
 * Render the PlanDraft for the `renderCall` hook.
 *
 * The plan preview fires BEFORE execution starts — pi calls `renderCall` with
 * the model's tool arguments, which for `relay` is a `PlanDraftDoc`. The user
 * sees this as an inline tool call in the chat and can abort if the plan
 * looks wrong.
 *
 * Collapsed view (default): one-line task + metadata + step-kind strip.
 * Expanded view (Ctrl+O): per-step lines showing actor/check spec, routes,
 * and artifact reads/writes.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { type Component, Container, Spacer, Text } from "@mariozechner/pi-tui";
import type { PlanDraftDoc } from "../plan/draft.js";
import { truncate } from "./format.js";

export const renderPlanPreview = (plan: PlanDraftDoc, theme: Theme, expanded: boolean): Component => {
	if (!expanded) return renderCollapsed(plan, theme);
	return renderExpanded(plan, theme);
};

const renderCollapsed = (plan: PlanDraftDoc, theme: Theme): Component => {
	const task = truncate(plan.task.trim().replace(/\s+/g, " "), 70);
	const actorCount = countUniqueActors(plan);
	const stepCount = plan.steps.length;
	const artifactCount = plan.artifacts.length;
	const stepStrip = plan.steps.map((s) => glyphForKind(s.kind, theme)).join("");

	const header = `${theme.fg("toolTitle", theme.bold("relay "))}${theme.fg("accent", task)}`;
	const meta = theme.fg("muted", `${stepCount} steps · ${actorCount} actors · ${artifactCount} artifacts`);
	return new Text(`${header}\n  ${meta}\n  ${stepStrip}`, 0, 0);
};

const renderExpanded = (plan: PlanDraftDoc, theme: Theme): Component => {
	const container = new Container();
	const task = plan.task.trim();
	container.addChild(new Text(`${theme.fg("toolTitle", theme.bold("relay "))}${theme.fg("accent", task)}`, 0, 0));
	if (plan.successCriteria) {
		container.addChild(new Text(theme.fg("muted", `success: ${plan.successCriteria}`), 0, 0));
	}
	const actorCount = countUniqueActors(plan);
	container.addChild(
		new Text(
			theme.fg(
				"muted",
				`${plan.steps.length} steps · ${actorCount} actors · ${plan.artifacts.length} artifacts · entry: ${plan.entryStep}`,
			),
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));

	for (const step of plan.steps) {
		container.addChild(new Text(renderStepLine(step, theme), 0, 0));
	}
	return container;
};

const glyphForKind = (kind: PlanDraftDoc["steps"][number]["kind"], theme: Theme): string => {
	switch (kind) {
		case "action":
			return theme.fg("accent", "◆");
		case "check":
			return theme.fg("warning", "?");
		case "terminal":
			return theme.fg("success", "■");
	}
};

const renderStepLine = (step: PlanDraftDoc["steps"][number], theme: Theme): string => {
	switch (step.kind) {
		case "action": {
			const header =
				`${theme.fg("accent", "◆")} ${theme.fg("toolTitle", step.id)} ` + `${theme.fg("muted", `[${step.actor}]`)}`;
			const rw = formatReadsWrites(step, theme);
			const routes = theme.fg("dim", `→ ${step.routes.map((r) => `${r.route}:${r.to}`).join(", ")}`);
			const retry = step.retry ? theme.fg("dim", ` (retry ${step.retry.maxAttempts}x)`) : "";
			return `  ${header}  ${rw}  ${routes}${retry}`;
		}
		case "check": {
			const header = `${theme.fg("warning", "?")} ${theme.fg("toolTitle", step.id)} ${theme.fg("muted", `[${step.check.kind}]`)}`;
			const routes = theme.fg("dim", `→ pass:${step.onPass}  fail:${step.onFail}`);
			return `  ${header}  ${routes}`;
		}
		case "terminal": {
			const glyph = step.outcome === "success" ? theme.fg("success", "■") : theme.fg("error", "■");
			const body = theme.fg("muted", `[${step.outcome}] ${truncate(step.summary, 60)}`);
			return `  ${glyph} ${theme.fg("toolTitle", step.id)} ${body}`;
		}
	}
};

const formatReadsWrites = (step: Extract<PlanDraftDoc["steps"][number], { kind: "action" }>, theme: Theme): string => {
	const parts: string[] = [];
	if (step.reads.length > 0) parts.push(theme.fg("dim", `reads ${step.reads.join(",")}`));
	if (step.writes.length > 0) parts.push(theme.fg("dim", `writes ${step.writes.join(",")}`));
	return parts.join("  ");
};

const countUniqueActors = (plan: PlanDraftDoc): number => {
	const set = new Set<string>();
	for (const step of plan.steps) {
		if (step.kind === "action") set.add(step.actor);
	}
	return set.size;
};
