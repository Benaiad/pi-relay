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
      shape: { kind: "untyped_json" },
    },
  ],
  [
    ArtifactId("notes"),
    {
      id: ArtifactId("notes"),
      description: "Implementer notes",
      shape: { kind: "untyped_json" },
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
    expect(text).toContain("(none — emit an empty object");
  });
});

describe("parseCompletion", () => {
  it("parses a well-formed completion block", () => {
    const text = `Some preamble...
<relay-complete>{"route":"success","writes":{"spec":{"ok":true}}}</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("success");
    expect(result.value.writes).toEqual({ spec: { ok: true } });
  });

  it("parses a block with empty writes", () => {
    const text = `<relay-complete>{"route":"done","writes":{}}</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes).toEqual({});
  });

  it("parses a block with a null writes field", () => {
    const text = `<relay-complete>{"route":"done","writes":null}</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.writes).toEqual({});
  });

  it("fails when the completion block is missing", () => {
    const result = parseCompletion("I finished but forgot the tag.");
    expect(isErr(result)).toBe(true);
  });

  it("fails when the JSON is invalid", () => {
    const result = parseCompletion(`<relay-complete>not json</relay-complete>`);
    expect(isErr(result)).toBe(true);
  });

  it("fails when the payload is an array", () => {
    const result = parseCompletion(`<relay-complete>[1,2,3]</relay-complete>`);
    expect(isErr(result)).toBe(true);
  });

  it("fails when the route field is missing or empty", () => {
    const r1 = parseCompletion(
      `<relay-complete>{"writes":{}}</relay-complete>`,
    );
    const r2 = parseCompletion(
      `<relay-complete>{"route":"","writes":{}}</relay-complete>`,
    );
    expect(isErr(r1)).toBe(true);
    expect(isErr(r2)).toBe(true);
  });

  it("fails when writes is not an object", () => {
    const result = parseCompletion(
      `<relay-complete>{"route":"done","writes":[]}</relay-complete>`,
    );
    expect(isErr(result)).toBe(true);
  });

  it("takes the first completion block if multiple are present", () => {
    const text = `<relay-complete>{"route":"first","writes":{}}</relay-complete> junk <relay-complete>{"route":"second","writes":{}}</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("first");
  });

  it("recovers when trailing text follows valid JSON inside the tag", () => {
    const text = `<relay-complete>{"route":"done","writes":{"notes":{"ok":true}}} and then the model kept writing</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("done");
    expect(result.value.writes).toEqual({ notes: { ok: true } });
  });

  it("recovers when JSON string values contain unescaped newlines", () => {
    const text = `<relay-complete>{"route":"done","writes":{"notes":{"text":"line one\nline two"}}}</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("done");
  });

  it("recovers from a large JSON payload with trailing content", () => {
    const longValue = "x".repeat(5000);
    const text = `<relay-complete>{"route":"done","writes":{"log":{"data":"${longValue}"}}} extra junk here</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("done");
  });

  it("tolerates a json code fence inside the completion tag", () => {
    const text = `<relay-complete>
\`\`\`json
{"route":"success","writes":{"spec":{"ok":true}}}
\`\`\`
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("success");
    expect(result.value.writes).toEqual({ spec: { ok: true } });
  });

  it("tolerates a plain code fence inside the completion tag", () => {
    const text = `<relay-complete>
\`\`\`
{"route":"done","writes":{}}
\`\`\`
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
    if (!isOk(result)) return;
    expect(result.value.route).toBe("done");
  });

  it("tolerates leading and trailing whitespace inside the tag", () => {
    const text = `<relay-complete>
   {"route":"done","writes":{}}
</relay-complete>`;
    const result = parseCompletion(text);
    expect(isOk(result)).toBe(true);
  });
});

describe("stripCompletionTag", () => {
  it("removes a completion tag from the middle of text", () => {
    const text = `Here is my plan:

<relay-complete>{"route":"done","writes":{}}</relay-complete>

Done.`;
    expect(stripCompletionTag(text)).toBe("Here is my plan:\n\nDone.");
  });

  it("removes a tag at the end of text", () => {
    const text = `Prose before the tag.
<relay-complete>{"route":"done","writes":{}}</relay-complete>`;
    expect(stripCompletionTag(text)).toBe("Prose before the tag.");
  });

  it("removes a multi-line JSON payload inside the tag", () => {
    const text = `Summary:

<relay-complete>
{
  "route": "success",
  "writes": { "spec": { "ok": true } }
}
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
        '<relay-complete>{"route":"x","writes":{}}</relay-complete>',
      ),
    ).toBe("");
  });

  it("collapses multiple blank lines that would remain after removal", () => {
    const text =
      'para one\n\n\n<relay-complete>{"route":"x","writes":{}}</relay-complete>\n\n\npara two';
    expect(stripCompletionTag(text)).toBe("para one\n\npara two");
  });

  it("strips EVERY completion tag, not just the first (re-entered step case)", () => {
    const text = [
      "attempt 1 narration — rejecting.",
      '<relay-complete>{"route":"changes_requested","writes":{}}</relay-complete>',
      "attempt 2 narration — accepting.",
      '<relay-complete>{"route":"accepted","writes":{}}</relay-complete>',
    ].join("\n");
    // Both tags removed; the blank line between narrations is preserved
    // because the tags were on their own lines.
    expect(stripCompletionTag(text)).toBe(
      "attempt 1 narration — rejecting.\n\nattempt 2 narration — accepting.",
    );
  });
});
