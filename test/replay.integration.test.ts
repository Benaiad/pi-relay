/**
 * Integration test: full replay path from template file to run report.
 *
 * Exercises template discovery → instantiation → compile → scheduler
 * with a scripted actor engine, verifying the whole pipeline produces
 * correct results.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ActionOutcome,
  ActionRequest,
  ActorConfig,
  ActorEngine,
  ActorUsage,
} from "../src/actors/types.js";
import { emptyUsage } from "../src/actors/types.js";
import { type ActorRegistry, compile } from "../src/plan/compile.js";
import { ActorId, type ArtifactId, unwrap } from "../src/plan/ids.js";
import { ArtifactStore } from "../src/runtime/artifacts.js";
import { AuditLog } from "../src/runtime/audit.js";
import { Scheduler } from "../src/runtime/scheduler.js";
import { discoverPlanTemplates } from "../src/templates/discovery.js";
import { formatTemplateError } from "../src/templates/errors.js";
import { instantiateTemplate } from "../src/templates/substitute.js";

// ============================================================================
// Test helpers
// ============================================================================

const actorRegistry: ActorRegistry = {
  has: (id) => unwrap(id) === "worker",
  names: () => [ActorId("worker")],
};

const actorConfig: ActorConfig = {
  name: "worker",
  description: "Fake worker",
  systemPrompt: "",
  source: "user",
  filePath: "/tmp/worker.md",
};

const fakeUsage = (): ActorUsage => ({
  ...emptyUsage(),
  turns: 1,
  input: 100,
  output: 50,
  cost: 0.01,
});

class SimpleActorEngine implements ActorEngine {
  readonly calls: string[] = [];

  async runAction(request: ActionRequest): Promise<ActionOutcome> {
    this.calls.push(unwrap(request.step.id));
    const writes = new Map<ReturnType<typeof ArtifactId>, unknown>();
    for (const w of request.step.writes) {
      writes.set(w, { result: "done" });
    }
    const route = request.step.routes[0]?.route;
    if (!route) {
      return {
        kind: "no_completion",
        reason: "no routes",
        usage: fakeUsage(),
        transcript: [],
      };
    }
    return {
      kind: "completed",
      route,
      writes,
      usage: fakeUsage(),
      transcript: [],
    };
  }
}

const TEMPLATE_FILE = `---
name: refactor
description: Rename a symbol.
parameters:
  - name: module
    description: Path to the module.
    required: true
  - name: old_name
    description: Current name.
    required: true
  - name: new_name
    description: New name.
    required: true
---

task: "Rename {{old_name}} to {{new_name}} in {{module}}"
entryStep: rename
artifacts:
  - id: notes
    description: Rename notes.
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: rename
    actor: worker
    instruction: "Rename {{old_name}} to {{new_name}} in {{module}}"
    reads: []
    writes: [notes]
    routes: [{ route: done, to: verify }]
  - kind: verify_command
    id: verify
    command: echo ok
    onPass: success
    onFail: failed
  - kind: terminal
    id: success
    outcome: success
    summary: Rename verified.
  - kind: terminal
    id: failed
    outcome: failure
    summary: Tests failed.
`;

describe("replay integration", () => {
  let tmp = "";
  let plansDir = "";

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "pi-relay-replay-int-"));
    plansDir = path.join(tmp, "plans");
    await mkdir(plansDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("end-to-end: discover → instantiate → compile → schedule", async () => {
    await writeFile(path.join(plansDir, "refactor.md"), TEMPLATE_FILE);

    const discovery = discoverPlanTemplates("/nonexistent", "user", {
      userDir: plansDir,
    });
    expect(discovery.templates).toHaveLength(1);

    const template = discovery.templates[0]!;
    const instantiation = instantiateTemplate(template, {
      module: "src/foo.ts",
      old_name: "Foo",
      new_name: "Bar",
    });
    expect(instantiation.ok).toBe(true);
    if (!instantiation.ok) return;

    const plan = instantiation.value.plan;
    expect(plan.task).toBe("Rename Foo to Bar in src/foo.ts");

    const compileResult = compile(plan, actorRegistry);
    expect(compileResult.ok).toBe(true);
    if (!compileResult.ok) return;

    const program = compileResult.value;
    const engine = new SimpleActorEngine();
    const clock = {
      tick: 0,
      next() {
        this.tick++;
        return this.tick;
      },
    };
    const audit = new AuditLog();

    const scheduler = new Scheduler({
      program,
      actorEngine: engine,
      actorsByName: new Map([[ActorId("worker"), actorConfig]]),
      cwd: tmp,
      signal: undefined,
      clock: () => clock.next(),
      audit,
      artifactStore: new ArtifactStore(program, () => clock.next()),
    });

    const report = await scheduler.run();
    expect(report.outcome).toBe("success");
    expect(engine.calls).toEqual(["rename"]);
  });

  it("template not found produces a clear error", async () => {
    const discovery = discoverPlanTemplates("/nonexistent", "user", {
      userDir: plansDir,
    });
    const template = discovery.templates.find((t) => t.name === "nonexistent");
    expect(template).toBeUndefined();

    const error = formatTemplateError({
      kind: "missing_template",
      name: "nonexistent",
      available: discovery.templates.map((t) => t.name),
    });
    expect(error).toContain('Unknown template "nonexistent"');
  });

  it("missing required arg produces a clear error", async () => {
    await writeFile(path.join(plansDir, "refactor.md"), TEMPLATE_FILE);
    const discovery = discoverPlanTemplates("/nonexistent", "user", {
      userDir: plansDir,
    });
    const template = discovery.templates[0]!;

    const result = instantiateTemplate(template, { module: "src/foo.ts" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("missing_required_param");
    if (result.error.kind !== "missing_required_param") return;
    expect(result.error.missing).toContain("old_name");
    expect(result.error.missing).toContain("new_name");
  });

  it("template referencing unknown actor fails at compile time", async () => {
    const badTemplate = TEMPLATE_FILE.replace("actor: worker", "actor: ghost");
    await writeFile(path.join(plansDir, "bad.md"), badTemplate);

    const discovery = discoverPlanTemplates("/nonexistent", "user", {
      userDir: plansDir,
    });
    const template = discovery.templates.find((t) => t.name === "refactor")!;
    const instantiation = instantiateTemplate(template, {
      module: "x",
      old_name: "a",
      new_name: "b",
    });
    expect(instantiation.ok).toBe(true);
    if (!instantiation.ok) return;

    const emptyRegistry: ActorRegistry = { has: () => false, names: () => [] };
    const compileResult = compile(instantiation.value.plan, emptyRegistry);
    expect(compileResult.ok).toBe(false);
    if (compileResult.ok) return;
    expect(compileResult.error.kind).toBe("missing_actor");
  });

  it("unresolved placeholder produces a clear error", async () => {
    const typoTemplate = TEMPLATE_FILE.replace("{{old_name}}", "{{old_naem}}");
    await writeFile(path.join(plansDir, "typo.md"), typoTemplate);

    const discovery = discoverPlanTemplates("/nonexistent", "user", {
      userDir: plansDir,
    });
    const template = discovery.templates.find((t) => t.name === "refactor")!;
    const result = instantiateTemplate(template, {
      module: "x",
      old_name: "a",
      new_name: "b",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("unresolved_placeholder");
    if (result.error.kind !== "unresolved_placeholder") return;
    expect(result.error.placeholder).toBe("old_naem");
  });
});
