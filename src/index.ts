/**
 * pi-relay extension entry.
 *
 * Registers two tools:
 *   - `relay`  — the model builds an ad-hoc PlanDraftDoc from scratch
 *   - `replay` — the model invokes a saved plan template by name with args
 *
 * Both tools share the compile → review → schedule pipeline in `execute.ts`.
 * This file stays thin: it discovers actors and templates at extension load,
 * builds tool descriptions, and wires the pi extension API to the modules.
 *
 * Tool descriptions are built once at extension load and list the current
 * actors and templates. Adding, removing, or renaming actors/templates
 * requires `/reload` to update what the model sees. Edits to system
 * prompts, plan bodies, and tool lists are picked up on the next
 * execution without reloading.
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DynamicBorder,
  type ExtensionAPI,
  getSettingsListTheme,
  type Theme,
  type ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
} from "@mariozechner/pi-tui";
import { discoverActors } from "./actors/discovery.js";
import type { ActorConfig } from "./actors/types.js";
import {
  filterActors,
  filterPlans,
  loadRelayConfig,
  type RelayConfig,
  saveRelayConfig,
} from "./config.js";
import { executePlan } from "./execute.js";
import { PlanDraftSchema } from "./plan/draft.js";
import type { StepId } from "./plan/ids.js";
import { renderPlanPreview } from "./render/plan-preview.js";
import {
  renderCancelled,
  renderCompileFailure,
  renderRefined,
  renderRunResult,
} from "./render/run-result.js";
import { registerReplayTool } from "./replay.js";
import type { RelayRunState } from "./runtime/events.js";
import type { AttemptTimelineEntry } from "./runtime/run-report.js";
import { discoverPlanTemplates } from "./templates/discovery.js";
import type { PlanTemplate } from "./templates/types.js";

/**
 * The `details` payload carried by `onUpdate` and the final tool result.
 *
 * Four shapes because compile failures, user cancels, user refinement
 * requests, and runtime states are very different things to render.
 */
export type RelayDetails =
  | { readonly kind: "compile_failed"; readonly message: string }
  | { readonly kind: "cancelled"; readonly reason: string }
  | { readonly kind: "refined"; readonly feedback: string }
  | {
      readonly kind: "state";
      readonly state: RelayRunState;
      readonly attemptTimeline: readonly AttemptTimelineEntry[];
      readonly checkOutput?: ReadonlyMap<StepId, string>;
    };

export type RelayRenderState = {
  interval: NodeJS.Timeout | undefined;
};

export default function (pi: ExtensionAPI): void {
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const bundledActorsDir = packageRoot
    ? join(packageRoot, "actors")
    : undefined;
  const bundledPlansDir = packageRoot ? join(packageRoot, "plans") : undefined;

  const loadConfig = loadRelayConfig();
  const loadDiscovery = discoverActors(process.cwd(), "user", {
    bundledDir: bundledActorsDir,
  });
  const enabledActors = filterActors(loadDiscovery.actors, loadConfig);
  const actorNames = new Set(loadDiscovery.actors.map((a) => a.name));

  const templateDiscovery = discoverPlanTemplates(process.cwd(), "user", {
    actorNames,
    bundledDir: bundledPlansDir,
  });
  const enabledTemplates = filterPlans(templateDiscovery.templates, loadConfig);
  for (const warning of templateDiscovery.warnings) {
    console.error(
      `[relay] Template "${warning.templateName}": ${warning.message} (${warning.filePath})`,
    );
  }

  const relayDescription = buildToolDescription(enabledActors);

  pi.registerTool<typeof PlanDraftSchema, RelayDetails, RelayRenderState>({
    name: "relay",
    label: "Relay",
    description: relayDescription,
    parameters: PlanDraftSchema,

    async execute(_toolCallId, plan, signal, onUpdate, ctx) {
      const config = loadRelayConfig();
      const fullDiscovery = discoverActors(ctx.cwd, "user", {
        bundledDir: bundledActorsDir,
      });
      const discovery = {
        ...fullDiscovery,
        actors: filterActors(fullDiscovery.actors, config),
      };
      return executePlan({
        plan,
        discovery,
        signal,
        onUpdate,
        ctx,
        toolName: "Relay",
      });
    },

    renderCall(plan, theme, context) {
      return renderPlanPreview(
        plan,
        theme,
        context.expanded,
        context.lastComponent,
      );
    },

    renderResult(result, options, theme, context) {
      manageElapsedTimer(options, context.state, context.invalidate);
      return renderRelayResult(result, options, theme, context);
    },
  });

  registerReplayTool(pi, enabledTemplates, {
    actorsDir: bundledActorsDir,
    plansDir: bundledPlansDir,
  });

  pi.registerCommand("relay", {
    description: "Manage relay actors and plan templates",
    async handler(_args, ctx) {
      if (!ctx.hasUI) return;

      const config = loadRelayConfig();
      const discovery = discoverActors(ctx.cwd, "user", {
        bundledDir: bundledActorsDir,
      });
      const actorNameSet = new Set(discovery.actors.map((a) => a.name));
      const templates = discoverPlanTemplates(ctx.cwd, "user", {
        actorNames: actorNameSet,
        bundledDir: bundledPlansDir,
      });

      await ctx.ui.custom((_tui, theme, _kb, done) => {
        const items = buildSettingsItems(
          discovery.actors,
          templates.templates,
          config,
          theme,
        );
        const container = new Container();
        const border = new DynamicBorder((s: string) => theme.fg("accent", s));
        container.addChild(border);
        container.addChild(
          new Text(theme.fg("accent", theme.bold("Relay")), 1, 0),
        );

        let currentConfig = config;
        const settingsList = new SettingsList(
          items,
          14,
          getSettingsListTheme(),
          (id, newValue) => {
            currentConfig = applyToggle(
              currentConfig,
              id,
              newValue === "enabled",
            );

            // Cascade: disabling an actor also disables plans that use it.
            if (newValue === "disabled" && id.startsWith("actor:")) {
              const actorName = id.slice("actor:".length);
              for (const planName of plansUsingActor(
                templates.templates,
                actorName,
              )) {
                if (!currentConfig.disabledPlans.has(planName)) {
                  currentConfig = applyToggle(
                    currentConfig,
                    `plan:${planName}`,
                    false,
                  );
                  settingsList.updateValue(`plan:${planName}`, "disabled");
                }
              }
            }

            saveRelayConfig(currentConfig);
          },
          () => done(undefined),
        );
        container.addChild(settingsList);
        container.addChild(border);

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => settingsList.handleInput(data),
        };
      });
    },
  });
}

// ============================================================================
// Shared result renderer (used by both relay and replay)
// ============================================================================

export const manageElapsedTimer = (
  options: ToolRenderResultOptions,
  state: RelayRenderState,
  invalidate: () => void,
): void => {
  if (options.isPartial && !state.interval) {
    state.interval = setInterval(() => invalidate(), 1000);
  }
  if (!options.isPartial) {
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }
};

export const renderRelayResult = (
  result: {
    details?: RelayDetails;
    content: Array<{ type: string; text?: string }>;
  },
  options: { expanded: boolean },
  theme: Parameters<typeof renderRunResult>[2],
  context: {
    lastComponent?: Parameters<typeof renderRunResult>[4];
    args?: any;
  },
): ReturnType<typeof renderRunResult> => {
  const details = result.details;
  if (details?.kind === "state") {
    return renderRunResult(
      details.state,
      details.attemptTimeline,
      theme,
      options.expanded,
      context.lastComponent,
      details.checkOutput,
    );
  }
  if (details?.kind === "compile_failed") {
    return renderCompileFailure(details.message, theme, context.lastComponent);
  }
  if (details?.kind === "cancelled") {
    return renderCancelled(details.reason, theme, context.lastComponent);
  }
  if (details?.kind === "refined") {
    return renderRefined(details.feedback, theme, context.lastComponent);
  }
  return renderPlanPreview(
    context.args,
    theme,
    options.expanded,
    context.lastComponent,
  );
};

// ============================================================================
// Package root resolution
// ============================================================================

const findPackageRoot = (startDir: string): string | null => {
  let dir: string;
  try {
    dir = realpathSync(startDir);
  } catch {
    return null;
  }
  for (;;) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (pkg.pi?.extensions) return dir;
      } catch {
        // Not our package.json, keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

// ============================================================================
// /relay command helpers
// ============================================================================

const buildSettingsItems = (
  actors: readonly ActorConfig[],
  templates: readonly PlanTemplate[],
  config: RelayConfig,
  theme: Theme,
): SettingItem[] => {
  const items: SettingItem[] = [];

  items.push({
    id: "_actors",
    label: theme.bold(theme.fg("accent", "Actors")),
    currentValue: "",
  });

  for (const a of actors) {
    const tools = a.tools ? a.tools.join(", ") : "default tool set";
    items.push({
      id: `actor:${a.name}`,
      label: a.name,
      description: `${a.description} — tools: ${tools}`,
      currentValue: config.disabledActors.has(a.name) ? "disabled" : "enabled",
      values: ["enabled", "disabled"],
    });
  }

  items.push({
    id: "_plans",
    label: theme.bold(theme.fg("accent", "Plans")),
    currentValue: "",
  });

  for (const t of templates) {
    const sig =
      t.parameters.length > 0
        ? t.parameters
            .map((p) => (p.required ? p.name : `${p.name}?`))
            .join(", ")
        : "";
    items.push({
      id: `plan:${t.name}`,
      label: t.name,
      description: `${t.description}${sig ? ` — params: ${sig}` : ""}`,
      currentValue: config.disabledPlans.has(t.name) ? "disabled" : "enabled",
      values: ["enabled", "disabled"],
    });
  }

  return items;
};

/** Return the names of plan templates whose steps reference a given actor. */
const plansUsingActor = (
  templates: readonly PlanTemplate[],
  actorName: string,
): string[] => {
  const result: string[] = [];
  for (const t of templates) {
    const steps = t.rawPlan.steps;
    if (!Array.isArray(steps)) continue;
    for (const step of steps) {
      if (
        typeof step === "object" &&
        step !== null &&
        (step as Record<string, unknown>).actor === actorName
      ) {
        result.push(t.name);
        break;
      }
    }
  }
  return result;
};

const applyToggle = (
  config: RelayConfig,
  id: string,
  enabled: boolean,
): RelayConfig => {
  const [kind, name] = id.split(":", 2);
  if (!kind || !name) return config;

  if (kind === "actor") {
    const next = new Set(config.disabledActors);
    if (enabled) next.delete(name);
    else next.add(name);
    return { ...config, disabledActors: next };
  }

  if (kind === "plan") {
    const next = new Set(config.disabledPlans);
    if (enabled) next.delete(name);
    else next.add(name);
    return { ...config, disabledPlans: next };
  }

  return config;
};

// ============================================================================
// Tool description builder
// ============================================================================

export const buildToolDescription = (
  actors: readonly ActorConfig[],
): string => {
  const staticPart = [
    "Execute a structured multi-step workflow with typed artifacts and deterministic verification gates.",
    "Use this for tasks that require multiple specialized actors, verification gates (tests/checks),",
    "or workflows where partial success is unacceptable.",
    "Do NOT use this for single-tool edits, Q&A, explanations, or simple bug fixes — call the",
    "underlying tools directly instead.",
    "YOU are the planner: when you submit a plan, the step instructions must already contain concrete",
    "file paths, commands, and decisions you have reasoned through. Do NOT add a 'planner' actor to",
    "the plan expecting a second round of planning to happen at runtime — actors execute, they do not",
    "plan. If you need to scout the codebase, use your own read/grep/find tools before calling relay,",
    "then bake the findings into the plan's instructions.",
  ].join(" ");

  if (actors.length === 0) {
    return [
      staticPart,
      "",
      "NO ACTORS ARE CURRENTLY INSTALLED. Drop actor markdown files into",
      "~/.pi/agent/pi-relay/actors/ and run /reload to enable this tool.",
    ].join("\n");
  }

  const actorLines = actors.map((actor) => {
    const toolsSuffix =
      actor.tools && actor.tools.length > 0
        ? ` [allowed tools: ${actor.tools.join(", ")}]`
        : " [default tool set]";
    const modelSuffix = actor.model ? ` [model: ${actor.model}]` : "";
    const thinkingSuffix = actor.thinking
      ? ` [thinking: ${actor.thinking}]`
      : "";
    return `  - ${actor.name}: ${actor.description}${toolsSuffix}${modelSuffix}${thinkingSuffix}`;
  });

  return [
    staticPart,
    "",
    "Available actors for the 'actor' field of each action step. Use these names EXACTLY:",
    ...actorLines,
    "",
    "Each action step carries an 'instruction' field that is the task-specific prompt for that step.",
    "The actor's persona (tool list, coding standards, output style) stays the same across steps;",
    "the 'instruction' is how you tell the SAME actor to do DIFFERENT work at different points in the plan.",
    "",
    "Artifacts accumulate: every commit appends an entry with attribution (step, attempt). Readers see",
    "the full history. A review loop looks like: create writes notes → review reads notes writes verdict",
    "→ fix reads verdict writes notes → (back-edge) review → accepted terminates.",
  ].join("\n");
};
