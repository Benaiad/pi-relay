import { describe, expect, it } from "vitest";
import { compile } from "../../src/plan/compile.js";
import type { PlanDraftDoc } from "../../src/plan/draft.js";
import { ActorId, ArtifactId, StepId, unwrap } from "../../src/plan/ids.js";
import { isErr, isOk } from "../../src/plan/result.js";
import {
  ArtifactStore,
  formatContractViolation,
} from "../../src/runtime/artifacts.js";

const actors = {
  has: (id: ReturnType<typeof ActorId>) => unwrap(id) === "worker",
  names: () => [ActorId("worker")],
};

const planWithTwoWriters: PlanDraftDoc = {
  task: "t",
  artifacts: [
    { id: "a", description: "a", shape: { kind: "untyped_json" } },
    { id: "b", description: "b", shape: { kind: "untyped_json" } },
  ],
  steps: [
    {
      kind: "action",
      id: "first",
      actor: "worker",
      instruction: "first",
      reads: [],
      writes: ["a"],
      routes: [{ route: "next", to: "second" }],
    },
    {
      kind: "action",
      id: "second",
      actor: "worker",
      instruction: "second",
      reads: ["a"],
      writes: ["b"],
      routes: [{ route: "done", to: "end" }],
    },
    { kind: "terminal", id: "end", outcome: "success", summary: "ok" },
  ],
  entryStep: "first",
};

const buildStore = () => {
  const result = compile(planWithTwoWriters, actors, {
    generateId: () => "plan-fixed",
  });
  if (!isOk(result)) throw new Error("compile should succeed");
  let tick = 0;
  const clock = () => {
    tick += 1;
    return tick;
  };
  return new ArtifactStore(result.value, clock);
};

describe("ArtifactStore", () => {
  it("commits a write and returns it as an accumulated entry", () => {
    const store = buildStore();
    const commit = store.commit(
      StepId("first"),
      new Map([[ArtifactId("a"), { value: 42 }]]),
    );
    expect(isOk(commit)).toBe(true);
    const snap = store.snapshot([ArtifactId("a")]);
    expect(snap.has(ArtifactId("a"))).toBe(true);
    const entries = snap.get(ArtifactId("a")) as Array<{
      index: number;
      value: unknown;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.index).toBe(0);
    expect(entries[0]!.value).toEqual({ value: 42 });
    expect(snap.ids().map(unwrap)).toEqual(["a"]);
  });

  it("omits artifacts not listed in the snapshot's reads", () => {
    const store = buildStore();
    store.commit(StepId("first"), new Map([[ArtifactId("a"), "hello"]]));
    const snap = store.snapshot([]);
    expect(snap.has(ArtifactId("a"))).toBe(false);
    expect(snap.ids()).toEqual([]);
  });

  it("omits artifacts that have not been committed yet", () => {
    const store = buildStore();
    const snap = store.snapshot([ArtifactId("a")]);
    expect(snap.has(ArtifactId("a"))).toBe(false);
    expect(snap.get(ArtifactId("a"))).toBeUndefined();
  });

  it("rejects writes from a step that is not the declared writer", () => {
    const store = buildStore();
    const result = store.commit(
      StepId("second"),
      new Map([[ArtifactId("a"), 1]]),
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.kind).toBe("wrong_writer");
    if (result.error.kind === "wrong_writer") {
      expect(unwrap(result.error.artifactId)).toBe("a");
      expect(unwrap(result.error.declaredWriter)).toBe("first");
      expect(unwrap(result.error.actualWriter)).toBe("second");
    }
  });

  it("rejects writes to unknown artifacts", () => {
    const store = buildStore();
    const result = store.commit(
      StepId("first"),
      new Map([[ArtifactId("nope"), 1]]),
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.kind).toBe("unknown_artifact");
  });

  it("commits a batch all-or-nothing: no partial writes on failure", () => {
    const store = buildStore();
    const result = store.commit(
      StepId("first"),
      new Map<ReturnType<typeof ArtifactId>, unknown>([
        [ArtifactId("a"), { ok: true }],
        [ArtifactId("b"), { never: "committed" }],
      ]),
    );
    expect(isErr(result)).toBe(true);
    // Prior good write `a` must not have landed because the batch failed on `b`.
    expect(store.has(ArtifactId("a"))).toBe(false);
  });

  it("rejects non-serializable values with a shape mismatch", () => {
    const store = buildStore();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = store.commit(
      StepId("first"),
      new Map([[ArtifactId("a"), cyclic]]),
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error.kind).toBe("shape_mismatch");
  });

  it("preserves committed artifacts across snapshots", () => {
    const store = buildStore();
    store.commit(
      StepId("first"),
      new Map([[ArtifactId("a"), { hello: "world" }]]),
    );
    store.commit(StepId("second"), new Map([[ArtifactId("b"), [1, 2, 3]]]));
    expect(store.has(ArtifactId("a"))).toBe(true);
    expect(store.has(ArtifactId("b"))).toBe(true);
    const snap = store.snapshot([ArtifactId("a"), ArtifactId("b")]);
    const aEntries = snap.get(ArtifactId("a")) as Array<{ value: unknown }>;
    const bEntries = snap.get(ArtifactId("b")) as Array<{ value: unknown }>;
    expect(aEntries[0]!.value).toEqual({ hello: "world" });
    expect(bEntries[0]!.value).toEqual([1, 2, 3]);
  });

  it("returns committed artifacts with writer bookkeeping via all()", () => {
    const store = buildStore();
    store.commit(StepId("first"), new Map([[ArtifactId("a"), 1]]));
    const entries = store.all();
    expect(entries.length).toBe(1);
    expect(unwrap(entries[0]!.id)).toBe("a");
    expect(unwrap(entries[0]!.writerStep)).toBe("first");
    expect(entries[0]!.committedAt).toBeGreaterThan(0);
  });

  it("accumulates values across multiple commits", () => {
    const plan: PlanDraftDoc = {
      task: "t",
      artifacts: [
        { id: "log", description: "log", shape: { kind: "untyped_json" } },
      ],
      steps: [
        {
          kind: "action",
          id: "step",
          actor: "worker",
          instruction: "do",
          reads: ["log"],
          writes: ["log"],
          routes: [{ route: "done", to: "end" }],
        },
        { kind: "terminal", id: "end", outcome: "success", summary: "ok" },
      ],
      entryStep: "step",
    };
    const result = compile(plan, actors, { generateId: () => "pid" });
    if (!isOk(result)) throw new Error("compile should succeed");
    let tick = 0;
    const store = new ArtifactStore(result.value, () => ++tick);

    store.commit(
      StepId("step"),
      new Map([[ArtifactId("log"), { tried: "sieve" }]]),
    );
    const snap1 = store
      .snapshot([ArtifactId("log")])
      .get(ArtifactId("log")) as Array<{
      index: number;
      stepId: unknown;
      value: unknown;
    }>;
    expect(snap1).toHaveLength(1);
    expect(snap1[0]!.index).toBe(0);
    expect(snap1[0]!.value).toEqual({ tried: "sieve" });
    expect(unwrap(snap1[0]!.stepId as ReturnType<typeof StepId>)).toBe("step");

    store.commit(
      StepId("step"),
      new Map([[ArtifactId("log"), { tried: "bitwise" }]]),
    );
    const snap2 = store
      .snapshot([ArtifactId("log")])
      .get(ArtifactId("log")) as Array<{
      index: number;
      value: unknown;
    }>;
    expect(snap2).toHaveLength(2);
    expect(snap2[0]!.value).toEqual({ tried: "sieve" });
    expect(snap2[1]!.value).toEqual({ tried: "bitwise" });
    expect(snap2[1]!.index).toBe(1);

    store.commit(
      StepId("step"),
      new Map([[ArtifactId("log"), { tried: "wheel" }]]),
    );
    const snap3 = store
      .snapshot([ArtifactId("log")])
      .get(ArtifactId("log")) as Array<{
      index: number;
      value: unknown;
    }>;
    expect(snap3).toHaveLength(3);
    expect(snap3.map((e) => e.value)).toEqual([
      { tried: "sieve" },
      { tried: "bitwise" },
      { tried: "wheel" },
    ]);
  });

  it("formatContractViolation produces a useful message for each variant", () => {
    const wrongWriter = formatContractViolation({
      kind: "wrong_writer",
      artifactId: ArtifactId("a"),
      declaredWriter: StepId("first"),
      actualWriter: StepId("second"),
    });
    expect(wrongWriter).toContain("'a'");
    expect(wrongWriter).toContain("'first'");
    expect(wrongWriter).toContain("'second'");

    const unknown = formatContractViolation({
      kind: "unknown_artifact",
      artifactId: ArtifactId("nope"),
      stepId: StepId("first"),
    });
    expect(unknown).toContain("'nope'");

    const mismatch = formatContractViolation({
      kind: "shape_mismatch",
      artifactId: ArtifactId("a"),
      reason: "not JSON",
    });
    expect(mismatch).toContain("'a'");
    expect(mismatch).toContain("not JSON");
  });
});
