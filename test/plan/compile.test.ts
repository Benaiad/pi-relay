import { describe, expect, it } from "vitest";
import { type ActorRegistry, compile } from "../../src/plan/compile.js";
import { formatCompileError } from "../../src/plan/compile-error-format.js";
import type { PlanDraftDoc } from "../../src/plan/draft.js";
import {
  ActorId,
  ArtifactId,
  edgeKey,
  RouteId,
  StepId,
  unwrap,
} from "../../src/plan/ids.js";
import { isErr, isOk } from "../../src/plan/result.js";

const fixedIdOptions = { generateId: () => "fixed-plan-id" };

const defaultActors: ActorRegistry = {
  has: (id) => ["worker", "planner", "scout"].includes(unwrap(id)),
  names: () => [ActorId("worker"), ActorId("planner"), ActorId("scout")],
};

const emptyActors: ActorRegistry = {
  has: () => false,
  names: () => [],
};

const basicPlan: PlanDraftDoc = {
  task: "Plan, implement, and verify.",
  artifacts: [
    {
      id: "requirements",
      description: "Parsed requirements",
      shape: { kind: "untyped_json" },
    },
    {
      id: "notes",
      description: "Implementer notes",
      shape: { kind: "untyped_json" },
    },
  ],
  steps: [
    {
      kind: "action",
      id: "plan",
      actor: "planner",
      instruction: "Write requirements.",
      reads: [],
      writes: ["requirements"],
      routes: [{ route: "next", to: "implement" }],
    },
    {
      kind: "action",
      id: "implement",
      actor: "worker",
      instruction: "Apply the requirements.",
      reads: ["requirements"],
      writes: ["notes"],
      routes: [{ route: "done", to: "done" }],
      retry: { maxAttempts: 2 },
    },
    {
      kind: "terminal",
      id: "done",
      outcome: "success",
      summary: "Implementation complete.",
    },
  ],
  entryStep: "plan",
};

describe("compile", () => {
  it("accepts a happy-path linear plan and builds every index", () => {
    const result = compile(basicPlan, defaultActors, fixedIdOptions);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    const program = result.value;
    expect(unwrap(program.id)).toBe("fixed-plan-id");
    expect(program.task).toBe(basicPlan.task);
    expect(program.stepOrder.map(unwrap)).toEqual([
      "plan",
      "implement",
      "done",
    ]);
    expect(program.steps.size).toBe(3);
    expect(program.artifacts.size).toBe(2);
    expect(program.edges.size).toBe(2);
    expect(program.edges.get(edgeKey(StepId("plan"), RouteId("next")))).toEqual(
      StepId("implement"),
    );
    expect(
      program.edges.get(edgeKey(StepId("implement"), RouteId("done"))),
    ).toEqual(StepId("done"));
    expect(program.writers.get(ArtifactId("requirements"))).toEqual(
      StepId("plan"),
    );
    expect(program.writers.get(ArtifactId("notes"))).toEqual(
      StepId("implement"),
    );
    expect(program.readers.get(ArtifactId("requirements"))).toEqual(
      new Set([StepId("implement")]),
    );
    expect(program.actorsReferenced).toEqual(
      new Set([ActorId("planner"), ActorId("worker")]),
    );
  });

  it("rejects an empty steps array", () => {
    const bad: PlanDraftDoc = { ...basicPlan, steps: [] };
    const result = compile(bad, defaultActors, fixedIdOptions);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.kind).toBe("empty_plan");
  });

  it("rejects duplicate step ids", () => {
    const firstStep = basicPlan.steps[0]!;
    const bad: PlanDraftDoc = {
      ...basicPlan,
      steps: [...basicPlan.steps, { ...firstStep }],
    };
    const result = compile(bad, defaultActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("duplicate_step");
  });

  it("rejects a missing entry step", () => {
    const bad: PlanDraftDoc = { ...basicPlan, entryStep: "does-not-exist" };
    const result = compile(bad, defaultActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("missing_entry");
    if (result.error.kind === "missing_entry") {
      expect(unwrap(result.error.entryStep)).toBe("does-not-exist");
      expect(result.error.availableSteps.map(unwrap)).toEqual([
        "plan",
        "implement",
        "done",
      ]);
    }
  });

  it("rejects a step referencing an unknown actor", () => {
    const result = compile(basicPlan, emptyActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("missing_actor");
    if (result.error.kind === "missing_actor") {
      expect(unwrap(result.error.actor)).toBe("planner");
      expect(result.error.availableActors).toEqual([]);
    }
  });

  it("rejects a route targeting a non-existent step", () => {
    const planStep = basicPlan.steps[0]!;
    if (planStep.kind !== "action") throw new Error("expected action");
    const bad: PlanDraftDoc = {
      ...basicPlan,
      steps: [
        { ...planStep, routes: [{ route: "next", to: "nowhere" }] },
        ...basicPlan.steps.slice(1),
      ],
    };
    const result = compile(bad, defaultActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("missing_route_target");
    if (result.error.kind === "missing_route_target") {
      expect(unwrap(result.error.from)).toBe("plan");
      expect(unwrap(result.error.target)).toBe("nowhere");
    }
  });

  it("allows multiple steps to write the same artifact", () => {
    const implementStep = basicPlan.steps[1]!;
    if (implementStep.kind !== "action") throw new Error("expected action");
    const plan: PlanDraftDoc = {
      ...basicPlan,
      steps: [
        basicPlan.steps[0]!,
        { ...implementStep, writes: ["requirements", "notes"] },
        basicPlan.steps[2]!,
      ],
    };
    const result = compile(plan, defaultActors, fixedIdOptions);
    expect(isOk(result)).toBe(true);
  });

  it("rejects a step reading an undeclared artifact", () => {
    const implementStep = basicPlan.steps[1]!;
    if (implementStep.kind !== "action") throw new Error("expected action");
    const bad: PlanDraftDoc = {
      ...basicPlan,
      steps: [
        basicPlan.steps[0]!,
        { ...implementStep, reads: ["ghost"] },
        basicPlan.steps[2]!,
      ],
    };
    const result = compile(bad, defaultActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("missing_artifact_contract");
  });

  it("rejects an artifact with no writer", () => {
    const bad: PlanDraftDoc = {
      ...basicPlan,
      artifacts: [
        ...basicPlan.artifacts,
        {
          id: "unused",
          description: "never produced",
          shape: { kind: "untyped_json" },
        },
      ],
    };
    const result = compile(bad, defaultActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("missing_artifact_producer");
    if (result.error.kind === "missing_artifact_producer") {
      expect(unwrap(result.error.artifactId)).toBe("unused");
    }
  });

  it("rejects duplicate artifact declarations", () => {
    const bad: PlanDraftDoc = {
      ...basicPlan,
      artifacts: [
        ...basicPlan.artifacts,
        {
          id: "requirements",
          description: "dup",
          shape: { kind: "untyped_json" },
        },
      ],
    };
    const result = compile(bad, defaultActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("duplicate_artifact");
  });

  it("rejects context policy other than fresh_per_run", () => {
    const planStep = basicPlan.steps[0]!;
    if (planStep.kind !== "action") throw new Error("expected action");
    const bad: PlanDraftDoc = {
      ...basicPlan,
      steps: [
        { ...planStep, contextPolicy: "persist_per_actor" as const },
        ...basicPlan.steps.slice(1),
      ],
    };
    const result = compile(bad, defaultActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("unsupported_context_policy");
  });

  it("compiles a verify_files_exist step with pass and fail routes", () => {
    const plan: PlanDraftDoc = {
      task: "Run tests and branch on outcome.",
      artifacts: [
        { id: "spec", description: "spec", shape: { kind: "untyped_json" } },
      ],
      steps: [
        {
          kind: "action",
          id: "write",
          actor: "worker",
          instruction: "Write a spec.",
          reads: [],
          writes: ["spec"],
          routes: [{ route: "ready", to: "verify" }],
        },
        {
          kind: "verify_files_exist",
          id: "verify",
          paths: ["/tmp/does-not-matter"],
          onPass: "ok",
          onFail: "broken",
        },
        { kind: "terminal", id: "ok", outcome: "success", summary: "passed" },
        {
          kind: "terminal",
          id: "broken",
          outcome: "failure",
          summary: "failed",
        },
      ],
      entryStep: "write",
    };
    const result = compile(plan, defaultActors, fixedIdOptions);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(
      result.value.edges.get(edgeKey(StepId("verify"), RouteId("pass"))),
    ).toEqual(StepId("ok"));
    expect(
      result.value.edges.get(edgeKey(StepId("verify"), RouteId("fail"))),
    ).toEqual(StepId("broken"));
  });

  it("rejects a verify step with an unknown onFail target", () => {
    const plan: PlanDraftDoc = {
      task: "bad verify",
      artifacts: [],
      steps: [
        {
          kind: "verify_files_exist",
          id: "verify",
          paths: ["/tmp/x"],
          onPass: "done",
          onFail: "ghost",
        },
        { kind: "terminal", id: "done", outcome: "success", summary: "ok" },
      ],
      entryStep: "verify",
    };
    const result = compile(plan, defaultActors, fixedIdOptions);
    if (!isErr(result)) throw new Error("expected error");
    expect(result.error.kind).toBe("missing_route_target");
  });

  it("formats compile errors into readable messages", () => {
    const result = compile(
      { ...basicPlan, entryStep: "nonexistent" },
      defaultActors,
      fixedIdOptions,
    );
    if (!isErr(result)) throw new Error("expected error");
    const msg = formatCompileError(result.error);
    expect(msg).toContain("'nonexistent'");
    expect(msg).toContain("'plan'");
    expect(msg).toContain("'implement'");
    expect(msg).toContain("'done'");
  });
});
