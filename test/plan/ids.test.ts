import { describe, expect, it } from "vitest";
import {
  ActorId,
  ArtifactId,
  edgeKey,
  PlanId,
  RouteId,
  RunId,
  StepId,
  unwrap,
} from "../../src/plan/ids.js";

describe("branded id constructors", () => {
  it("accept non-empty strings", () => {
    expect(unwrap(PlanId("plan-1"))).toBe("plan-1");
    expect(unwrap(RunId("run-1"))).toBe("run-1");
    expect(unwrap(StepId("scout"))).toBe("scout");
    expect(unwrap(ActorId("worker"))).toBe("worker");
    expect(unwrap(ArtifactId("spec"))).toBe("spec");
    expect(unwrap(RouteId("success"))).toBe("success");
  });

  it("reject empty strings", () => {
    expect(() => PlanId("")).toThrow(TypeError);
    expect(() => StepId("")).toThrow(TypeError);
    expect(() => ActorId("")).toThrow(TypeError);
    expect(() => ArtifactId("")).toThrow(TypeError);
    expect(() => RouteId("")).toThrow(TypeError);
  });

  it("reject non-string values", () => {
    expect(() => PlanId(123 as unknown as string)).toThrow(TypeError);
    expect(() => StepId(undefined as unknown as string)).toThrow(TypeError);
  });

  it("prevent structural cross-assignment at the type level", () => {
    const step: StepId = StepId("step-1");
    const actor: ActorId = ActorId("actor-1");
    // @ts-expect-error — StepId is not assignable to ActorId
    const _wrong: ActorId = step;
    // @ts-expect-error — ActorId is not assignable to StepId
    const _alsoWrong: StepId = actor;
    void _wrong;
    void _alsoWrong;
  });
});

describe("edgeKey", () => {
  it("constructs a deterministic compound key", () => {
    const key = edgeKey(StepId("scout"), RouteId("success"));
    expect(unwrap(key)).toBe("scout::success");
  });

  it("distinguishes different (step, route) pairs", () => {
    const a = edgeKey(StepId("scout"), RouteId("success"));
    const b = edgeKey(StepId("scout"), RouteId("failure"));
    const c = edgeKey(StepId("planner"), RouteId("success"));
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});
