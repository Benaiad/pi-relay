import { describe, expect, it } from "vitest";
import {
  buildCompletionInstruction,
  parseCompletion,
  stripCompletionTag,
} from "../../src/actors/complete-step.js";
import { ArtifactId, RouteId } from "../../src/plan/ids.js";
import { isErr, isOk } from "../../src/plan/result.js";
import type { ArtifactContract } from "../../src/plan/types.js";

const contracts = new Map<ReturnType<typeof ArtifactId>, ArtifactContract>([
  [
    ArtifactId("spec"),
    {
      id: ArtifactId("spec"),
      description: "Parsed requirements",
      shape: { kind: "text" },
    },
  ],
  [
    ArtifactId("notes"),
    {
      id: ArtifactId("notes"),
      description: "Implementer notes",
      shape: { kind: "text" },
    },
  ],
]);

describe("buildCompletionInstruction", () => {
  it("lists every allowed route and writable artifact with description", () => {
    const text = buildCompletionInstruction({
      routes: [RouteId("success"), RouteId("failure")],
      writableArtifactIds: [ArtifactId("spec"), ArtifactId("notes")],
      artifactContracts: contracts,
    });
    expect(text).toContain("<relay-complete>");
    expect(text).toContain("</relay-complete>");
    expect(text).toContain("<route>");
    expect(text).toContain("<artifact");
    expect(text).toContain("- success");
    expect(text).toContain("- failure");
    expect(text).toContain("- spec: Parsed requirements");
    expect(text).toContain("- notes: Implementer notes");
  });

  it("renders a placeholder for the empty writable-artifacts case", () => {
    const text = buildCompletionInstruction({
      routes: [RouteId("done")],
      writableArtifactIds: [],
      artifactContracts: new Map(),
    });
    expect(text).toContain("(none");
    expect(text).not.toContain('<artifact id="');
  });

  it("includes an example artifact tag when artifacts are present", () => {
    const text = buildCompletionInstruction({
      routes: [RouteId("done")],
      writableArtifactIds: [ArtifactId("spec")],
      artifactContracts: contracts,
    });
    expect(text).toContain('<artifact id="spec">');
  });

  it("includes shape hints for record artifacts", () => {
    const recordContracts = new Map<
      ReturnType<typeof ArtifactId>,
      ArtifactContract
    >([
      [
        ArtifactId("diag"),
        {
          id: ArtifactId("diag"),
          description: "Diagnosis",
          shape: { kind: "record", fields: ["root_cause", "file"] },
        },
      ],
    ]);
    const text = buildCompletionInstruction({
      routes: [RouteId("done")],
      writableArtifactIds: [ArtifactId("diag")],
      artifactContracts: recordContracts,
    });
    expect(text).toContain("Fields: root_cause, file");
  });

  it("includes list hint for record_list artifacts", () => {
    const listContracts = new Map<
      ReturnType<typeof ArtifactId>,
      ArtifactContract
    >([
      [
        ArtifactId("items"),
        {
          id: ArtifactId("items"),
          description: "Items",
          shape: { kind: "record_list", fields: ["name"] },
        },
      ],
    ]);
    const text = buildCompletionInstruction({
      routes: [RouteId("done")],
      writableArtifactIds: [ArtifactId("items")],
      artifactContracts: listContracts,
    });
    expect(text).toContain("Fields (list): name");
    expect(text).toContain("<item>");
  });
});

describe("parseCompletion", () => {
  it("parses a well-formed XML completion block", () => {
    const text = `Some preamble...
<relay-complete>
<route>success</route>
<artifact id="spec">parsed requirements here</artifact>
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("success");
    expect(result.value.writes).toEqual({
      spec: "parsed requirements here",
    });
  });

  it("parses a block with no artifacts", () => {
    const text = `<relay-complete><route>done</route></relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("done");
    expect(result.value.writes).toEqual({});
  });

  it("parses multiple artifacts", () => {
    const text = `<relay-complete>
<route>done</route>
<artifact id="spec">spec value</artifact>
<artifact id="notes">notes value</artifact>
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes).toEqual({
      spec: "spec value",
      notes: "notes value",
    });
  });

  it("trims whitespace from artifact values", () => {
    const text = `<relay-complete>
<route>done</route>
<artifact id="notes">
  some text with leading/trailing whitespace
</artifact>
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes.notes).toBe(
      "some text with leading/trailing whitespace",
    );
  });

  it("trims whitespace from the route", () => {
    const text = `<relay-complete><route>  done  </route></relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("done");
  });

  it("unescapes XML entities in artifact values", () => {
    const text = `<relay-complete>
<route>done</route>
<artifact id="notes">x &lt; y &amp; a &gt; b</artifact>
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes.notes).toBe("x < y & a > b");
  });

  it("preserves newlines inside artifact values", () => {
    const text = `<relay-complete>
<route>done</route>
<artifact id="notes">line one
line two
line three</artifact>
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes.notes).toBe("line one\nline two\nline three");
  });

  it("fails when the completion block is missing", () => {
    const result = parseCompletion("I finished but forgot the tag.");
    expect(isErr(result)).toBe(true);
  });

  it("fails when the route tag is missing", () => {
    const result = parseCompletion(
      `<relay-complete><artifact id="x">y</artifact></relay-complete>`,
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toContain("<route>");
  });

  it("fails when the route is empty", () => {
    const result = parseCompletion(
      `<relay-complete><route></route></relay-complete>`,
    );
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) return;
    expect(result.error).toContain("empty");
  });

  it("fails when the route is whitespace-only", () => {
    const result = parseCompletion(
      `<relay-complete><route>   </route></relay-complete>`,
    );
    expect(isErr(result)).toBe(true);
  });

  it("takes the first completion block if multiple are present", () => {
    const text = `<relay-complete><route>first</route></relay-complete> junk <relay-complete><route>second</route></relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("first");
  });

  it("parses field tags inside an artifact as a record", () => {
    const text = `<relay-complete>
<route>done</route>
<artifact id="diag">
<root_cause>null check missing</root_cause>
<file>src/auth.ts</file>
</artifact>
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes.diag).toEqual({
      root_cause: "null check missing",
      file: "src/auth.ts",
    });
  });

  it("parses item tags inside an artifact as a record_list", () => {
    const text = `<relay-complete>
<route>done</route>
<artifact id="issues">
<item>
<file>a.ts</file>
<fix>add guard</fix>
</item>
<item>
<file>b.ts</file>
<fix>remove dead code</fix>
</item>
</artifact>
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes.issues).toEqual([
      { file: "a.ts", fix: "add guard" },
      { file: "b.ts", fix: "remove dead code" },
    ]);
  });

  it("returns plain text for artifacts without tags", () => {
    const text = `<relay-complete>
<route>done</route>
<artifact id="notes">just a plain summary</artifact>
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes.notes).toBe("just a plain summary");
  });

  it("handles a large artifact value", () => {
    const longValue = "x".repeat(5000);
    const text = `<relay-complete><route>done</route><artifact id="log">${longValue}</artifact></relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes.log).toBe(longValue);
  });

  it("handles inline completion block with no whitespace", () => {
    const text = `<relay-complete><route>done</route><artifact id="a">v</artifact></relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("done");
    expect(result.value.writes.a).toBe("v");
  });
});

describe("stripCompletionTag", () => {
  it("removes a completion tag from the middle of text", () => {
    const text = `Here is my plan:

<relay-complete>
<route>done</route>
</relay-complete>

Done.`;
    expect(stripCompletionTag(text)).toBe("Here is my plan:\n\nDone.");
  });

  it("removes a tag at the end of text", () => {
    const text = `Prose before the tag.
<relay-complete><route>done</route></relay-complete>`;
    expect(stripCompletionTag(text)).toBe("Prose before the tag.");
  });

  it("removes a multi-line payload inside the tag", () => {
    const text = `Summary:

<relay-complete>
<route>success</route>
<artifact id="spec">some value</artifact>
</relay-complete>
`;
    expect(stripCompletionTag(text)).toBe("Summary:");
  });

  it("leaves text without a completion tag unchanged (modulo whitespace trim)", () => {
    expect(stripCompletionTag("Just prose.")).toBe("Just prose.");
    expect(stripCompletionTag("  padded  ")).toBe("padded");
  });

  it("returns an empty string when the text is only a completion tag", () => {
    expect(
      stripCompletionTag(
        "<relay-complete><route>x</route></relay-complete>",
      ),
    ).toBe("");
  });

  it("collapses multiple blank lines that would remain after removal", () => {
    const text =
      "para one\n\n\n<relay-complete><route>x</route></relay-complete>\n\n\npara two";
    expect(stripCompletionTag(text)).toBe("para one\n\npara two");
  });

  it("strips EVERY completion tag, not just the first (re-entered step case)", () => {
    const text = [
      "attempt 1 narration — rejecting.",
      "<relay-complete><route>changes_requested</route></relay-complete>",
      "attempt 2 narration — accepting.",
      "<relay-complete><route>accepted</route></relay-complete>",
    ].join("\n");
    expect(stripCompletionTag(text)).toBe(
      "attempt 1 narration — rejecting.\n\nattempt 2 narration — accepting.",
    );
  });
});
