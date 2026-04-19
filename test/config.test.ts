import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ActorConfig } from "../src/actors/types.js";
import {
  filterActors,
  filterPlans,
  loadRelayConfig,
  saveRelayConfig,
} from "../src/config.js";
import type { PlanTemplate } from "../src/templates/types.js";

const actor = (name: string): ActorConfig => ({
  name,
  description: `${name} actor`,
  systemPrompt: "",
  source: "bundled",
  filePath: `/tmp/${name}.md`,
});

const plan = (name: string): PlanTemplate => ({
  name,
  description: `${name} plan`,
  parameters: [],
  rawPlan: {},
  source: "bundled",
  filePath: `/tmp/${name}.md`,
});

describe("loadRelayConfig", () => {
  let tmp = "";
  let agentDir = "";

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "pi-relay-config-"));
    agentDir = path.join(tmp, "agent");
    await mkdir(path.join(agentDir, "pi-relay"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("returns empty sets when config file does not exist", () => {
    const config = loadRelayConfig(agentDir);
    expect(config.disabledActors.size).toBe(0);
    expect(config.disabledPlans.size).toBe(0);
  });

  it("loads disabled actors and plans from config file", async () => {
    await writeFile(
      path.join(agentDir, "pi-relay", "config.json"),
      JSON.stringify({
        disabledActors: ["critic", "judge"],
        disabledPlans: ["debate"],
      }),
    );
    const config = loadRelayConfig(agentDir);
    expect(config.disabledActors).toEqual(new Set(["critic", "judge"]));
    expect(config.disabledPlans).toEqual(new Set(["debate"]));
  });

  it("returns empty sets for malformed JSON", async () => {
    await writeFile(
      path.join(agentDir, "pi-relay", "config.json"),
      "not json{{{",
    );
    const config = loadRelayConfig(agentDir);
    expect(config.disabledActors.size).toBe(0);
    expect(config.disabledPlans.size).toBe(0);
  });

  it("returns empty sets when JSON is not an object", async () => {
    await writeFile(
      path.join(agentDir, "pi-relay", "config.json"),
      '"just a string"',
    );
    const config = loadRelayConfig(agentDir);
    expect(config.disabledActors.size).toBe(0);
    expect(config.disabledPlans.size).toBe(0);
  });

  it("handles missing disabledPlans key", async () => {
    await writeFile(
      path.join(agentDir, "pi-relay", "config.json"),
      JSON.stringify({ disabledActors: ["worker"] }),
    );
    const config = loadRelayConfig(agentDir);
    expect(config.disabledActors).toEqual(new Set(["worker"]));
    expect(config.disabledPlans.size).toBe(0);
  });

  it("handles missing disabledActors key", async () => {
    await writeFile(
      path.join(agentDir, "pi-relay", "config.json"),
      JSON.stringify({ disabledPlans: ["debate"] }),
    );
    const config = loadRelayConfig(agentDir);
    expect(config.disabledActors.size).toBe(0);
    expect(config.disabledPlans).toEqual(new Set(["debate"]));
  });

  it("ignores non-string entries in arrays", async () => {
    await writeFile(
      path.join(agentDir, "pi-relay", "config.json"),
      JSON.stringify({ disabledActors: ["worker", 42, null, true, "critic"] }),
    );
    const config = loadRelayConfig(agentDir);
    expect(config.disabledActors).toEqual(new Set(["worker", "critic"]));
  });
});

describe("saveRelayConfig", () => {
  let tmp = "";
  let agentDir = "";

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "pi-relay-config-"));
    agentDir = path.join(tmp, "agent");
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("creates the directory and writes the config file", () => {
    const config = {
      disabledActors: new Set(["judge", "critic"]),
      disabledPlans: new Set(["debate"]),
    };
    saveRelayConfig(config, agentDir);
    const raw = readFileSync(
      path.join(agentDir, "pi-relay", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.disabledActors).toEqual(["critic", "judge"]);
    expect(parsed.disabledPlans).toEqual(["debate"]);
  });

  it("round-trips through loadRelayConfig", () => {
    const config = {
      disabledActors: new Set(["advocate"]),
      disabledPlans: new Set(["multi-gate", "bug-fix"]),
    };
    saveRelayConfig(config, agentDir);
    const loaded = loadRelayConfig(agentDir);
    expect(loaded.disabledActors).toEqual(config.disabledActors);
    expect(loaded.disabledPlans).toEqual(config.disabledPlans);
  });

  it("writes sorted arrays for stable output", () => {
    const config = {
      disabledActors: new Set(["worker", "advocate", "critic"]),
      disabledPlans: new Set<string>(),
    };
    saveRelayConfig(config, agentDir);
    const raw = readFileSync(
      path.join(agentDir, "pi-relay", "config.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed.disabledActors).toEqual(["advocate", "critic", "worker"]);
  });
});

describe("filterActors", () => {
  it("returns all actors when nothing is disabled", () => {
    const actors = [actor("worker"), actor("reviewer")];
    const config = {
      disabledActors: new Set<string>(),
      disabledPlans: new Set<string>(),
    };
    expect(filterActors(actors, config)).toEqual(actors);
  });

  it("excludes disabled actors", () => {
    const actors = [actor("worker"), actor("critic"), actor("reviewer")];
    const config = {
      disabledActors: new Set(["critic"]),
      disabledPlans: new Set<string>(),
    };
    const result = filterActors(actors, config);
    expect(result.map((a) => a.name)).toEqual(["worker", "reviewer"]);
  });

  it("handles stale names in config gracefully", () => {
    const actors = [actor("worker")];
    const config = {
      disabledActors: new Set(["ghost"]),
      disabledPlans: new Set<string>(),
    };
    expect(filterActors(actors, config)).toEqual(actors);
  });
});

describe("filterPlans", () => {
  it("returns all plans when nothing is disabled", () => {
    const plans = [plan("verified-edit"), plan("bug-fix")];
    const config = {
      disabledActors: new Set<string>(),
      disabledPlans: new Set<string>(),
    };
    expect(filterPlans(plans, config)).toEqual(plans);
  });

  it("excludes disabled plans", () => {
    const plans = [plan("verified-edit"), plan("debate"), plan("bug-fix")];
    const config = {
      disabledActors: new Set<string>(),
      disabledPlans: new Set(["debate"]),
    };
    const result = filterPlans(plans, config);
    expect(result.map((t) => t.name)).toEqual(["verified-edit", "bug-fix"]);
  });
});
