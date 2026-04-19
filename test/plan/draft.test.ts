import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import { type PlanDraftDoc, PlanDraftSchema } from "../../src/plan/draft.js";

const validPlan: PlanDraftDoc = {
  task: "Add a feature flag to the user service and run the test suite before committing.",
  successCriteria:
    "Tests pass and the flag is wired to the canonical feature registry.",
  artifacts: [
    {
      id: "requirements",
      description: "Parsed requirements",
      shape: { kind: "untyped_json" },
    },
    {
      id: "implementation-notes",
      description: "Notes from the implementer",
      shape: { kind: "untyped_json" },
    },
  ],
  steps: [
    {
      kind: "action",
      id: "plan-changes",
      actor: "planner",
      instruction:
        "Identify the files that need to change and record them in requirements.",
      reads: [],
      writes: ["requirements"],
      routes: { success: "implement" },
    },
    {
      kind: "action",
      id: "implement",
      actor: "worker",
      instruction: "Apply the changes described in requirements.",
      reads: ["requirements"],
      writes: ["implementation-notes"],
      routes: { done: "run-tests" },
    },
    {
      kind: "verify_command",
      id: "run-tests",
      command: "npm test",
      timeoutMs: 120_000,
      onPass: "done",
      onFail: "failed",
    },
    {
      kind: "terminal",
      id: "done",
      outcome: "success",
      summary: "Feature flag shipped and tests are green.",
    },
    {
      kind: "terminal",
      id: "failed",
      outcome: "failure",
      summary: "Tests failed after implementation.",
    },
  ],
  entryStep: "plan-changes",
};

describe("PlanDraftSchema", () => {
  it("accepts a structurally valid plan", () => {
    expect(Value.Check(PlanDraftSchema, validPlan)).toBe(true);
  });

  it("rejects a plan missing the task field", () => {
    const bad = { ...validPlan, task: undefined };
    expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
  });

  it("rejects a plan with an empty steps array", () => {
    const bad = { ...validPlan, steps: [] };
    expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
  });

  it("rejects an action step without routes", () => {
    const bad: PlanDraftDoc = {
      ...validPlan,
      steps: [
        {
          kind: "action",
          id: "broken",
          actor: "worker",
          instruction: "Do the thing.",
          reads: [],
          writes: [],
          routes: {},
        },
        ...validPlan.steps.slice(1),
      ],
    };
    expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
  });

  it("rejects an unknown step kind", () => {
    const bad = {
      ...validPlan,
      steps: [
        {
          kind: "nonsense",
          id: "weird",
          actor: "worker",
          instruction: "hi",
          reads: [],
          writes: [],
          routes: {},
        },
        ...validPlan.steps.slice(1),
      ],
    };
    expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
  });

  it("rejects an unknown step kind in verify position", () => {
    const bad: unknown = {
      ...validPlan,
      steps: [
        validPlan.steps[0],
        validPlan.steps[1],
        {
          kind: "verify_nope",
          id: "run-tests",
          command: "npm test",
          onPass: "done",
          onFail: "failed",
        },
        ...validPlan.steps.slice(3),
      ],
    };
    expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
  });

  it("rejects an id that violates the pattern", () => {
    const bad = {
      ...validPlan,
      steps: [
        { ...validPlan.steps[0], id: "has space" },
        ...validPlan.steps.slice(1),
      ],
    };
    expect(Value.Check(PlanDraftSchema, bad)).toBe(false);
  });

  it("accepts the minimal shape: one action step plus a terminal", () => {
    const minimal: PlanDraftDoc = {
      task: "Say hello.",
      artifacts: [],
      steps: [
        {
          kind: "action",
          id: "greet",
          actor: "worker",
          instruction: "Produce a one-line greeting.",
          reads: [],
          writes: [],
          routes: { done: "end" },
        },
        {
          kind: "terminal",
          id: "end",
          outcome: "success",
          summary: "Greeted.",
        },
      ],
      entryStep: "greet",
    };
    expect(Value.Check(PlanDraftSchema, minimal)).toBe(true);
  });
});
