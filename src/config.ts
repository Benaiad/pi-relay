/**
 * Relay configuration — persisted enable/disable state for actors and plans.
 *
 * Stored at `~/.pi/agent/pi-relay/config.json` as a deny-list:
 * everything is enabled by default, and only explicitly disabled
 * names are listed. New bundled actors and plans added in future
 * releases are automatically available.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ActorConfig } from "./actors/types.js";
import type { PlanTemplate } from "./templates/types.js";

const CONFIG_PATH = "pi-relay/config.json";

export interface RelayConfig {
  readonly disabledActors: ReadonlySet<string>;
  readonly disabledPlans: ReadonlySet<string>;
}

const EMPTY_CONFIG: RelayConfig = {
  disabledActors: new Set(),
  disabledPlans: new Set(),
};

export const loadRelayConfig = (agentDir?: string): RelayConfig => {
  const configPath = join(agentDir ?? getAgentDir(), CONFIG_PATH);
  if (!existsSync(configPath)) return EMPTY_CONFIG;

  let raw: string;
  try {
    raw = readFileSync(configPath, "utf-8");
  } catch {
    return EMPTY_CONFIG;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error(
      `[relay] Malformed config at ${configPath}, treating as empty`,
    );
    return EMPTY_CONFIG;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return EMPTY_CONFIG;
  }

  const obj = parsed as Record<string, unknown>;
  return {
    disabledActors: toStringSet(obj.disabledActors),
    disabledPlans: toStringSet(obj.disabledPlans),
  };
};

export const saveRelayConfig = (
  config: RelayConfig,
  agentDir?: string,
): void => {
  const configPath = join(agentDir ?? getAgentDir(), CONFIG_PATH);
  const dir = dirname(configPath);

  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    console.error(`[relay] Failed to create config directory ${dir}`);
    return;
  }

  const payload = {
    disabledActors: Array.from(config.disabledActors).sort(),
    disabledPlans: Array.from(config.disabledPlans).sort(),
  };

  try {
    writeFileSync(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch {
    console.error(`[relay] Failed to write config to ${configPath}`);
  }
};

export const filterActors = (
  actors: readonly ActorConfig[],
  config: RelayConfig,
): readonly ActorConfig[] =>
  actors.filter((a) => !config.disabledActors.has(a.name));

export const filterPlans = (
  templates: readonly PlanTemplate[],
  config: RelayConfig,
): readonly PlanTemplate[] =>
  templates.filter((t) => !config.disabledPlans.has(t.name));

// ============================================================================
// Internal helpers
// ============================================================================

const toStringSet = (value: unknown): ReadonlySet<string> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((v): v is string => typeof v === "string"));
};
