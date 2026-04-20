# Remove `shape` from Schema — Implementation Plan

Three phases. Each phase produces a compiling, test-passing increment. Verify
after each step with `npx tsc --noEmit && npx vitest run`.

## Phase 1: Remove `shape` from model-facing schema

All changes are atomic — `shape` disappears from the schema and every consumer
in one commit.

### `draft.ts`

Delete `ArtifactShapeSchema` (lines 174-182).

Remove `shape` from `ArtifactContractSchema` (line 189). The schema becomes:

```typescript
const ArtifactContractSchema = Type.Object(
  {
    id: IdField("Unique artifact identifier within this plan."),
    description: Type.String({
      minLength: 1,
      maxLength: 1000,
      description:
        "What this artifact represents, e.g. 'parsed requirements' or 'test output JSON'.",
    }),
  },
  {
    description:
      "Compile-time declaration of an artifact's identity and description.",
  },
);
```

### `compile.ts`

In `buildArtifacts()`, line 300: replace `shape: c.shape` with the hardcoded
default:

```typescript
artifacts.set(id, {
  id,
  description: c.description,
  shape: { kind: "untyped_json" },
});
```

### Templates (7 shape lines to remove)

| File | Lines to remove |
|---|---|
| `plans/bug-fix.md` | lines 18, 21 (`shape: { kind: untyped_json }`) |
| `plans/verified-edit.md` | line 17 |
| `plans/reviewed-edit.md` | lines 21, 24, 27 |
| `plans/debate.md` | line 21 |
| `plans/multi-gate.md` | line 33 |

### Examples (2 occurrences)

| File | Change |
|---|---|
| `examples/sample-plan.json:8` | remove `"shape"` field from artifact object |
| `examples/autoresearch/autoresearch.md:31` | remove `shape:` line |

### Test fixtures (26 occurrences across 8 files)

Remove `, shape: { kind: "untyped_json" }` from every artifact declaration in
`PlanDraftDoc` objects. Delegate to a subagent — mechanical removal.

| File | Occurrences |
|---|---|
| `test/plan/draft.test.ts` | 2 (lines 13, 18) |
| `test/plan/compile.test.ts` | 5 (lines 33, 38, 245, 265, 278) |
| `test/runtime/artifacts.test.ts` | 3 (lines 19, 20, 178) |
| `test/runtime/scheduler.test.ts` | 12 (lines 133, 376, 377, 457, 458, 542, 543, 621, 622, 692, 696, 766) |
| `test/actors/complete-step.test.ts` | 2 (lines 17, 25) |
| `test/templates/substitute.test.ts` | 1 (line 286) |
| `test/replay.integration.test.ts` | 1 (line 103) |
| `test/index.confirmation.test.ts` | 2 (lines 28, 49) |

### Docs

Regenerate `architecture/RELAY_TOOL_SCHEMA.md`.

### Verify

`npx tsc --noEmit && npx vitest run`

**Commit:** `feat: remove shape from model-facing artifact schema`

---

## Phase 2: XML completion protocol

Replace the JSON-in-XML completion protocol with pure XML. This is the
prerequisite for `fields`/`list` — the transport must reliably carry structured
artifact values before field validation can work.

### Step 2a: Replace `parseCompletion` with XML tag extraction

**`complete-step.ts`** — this is the core change.

Replace `ParsedCompletion`:

```typescript
export interface ParsedCompletion {
  readonly route: string;
  readonly writes: ReadonlyMap<string, ParsedArtifactValue>;
}

export type ParsedArtifactValue =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "record"; readonly fields: Record<string, string> }
  | { readonly kind: "record_list"; readonly items: Record<string, string>[] };
```

Replace `parseCompletion`. The new parser:

1. Extracts everything between `<relay-complete>` and `</relay-complete>`.
2. Extracts `<route>...</route>` — the route string.
3. For each `<artifact id="...">...</artifact>`:
   - If it contains `<item>` children → `record_list`. Extract field tags
     from each `<item>`.
   - If it contains any child tags (not `<item>`) → `record`. Extract each
     tag as a field name/value pair.
   - If it contains only text → `text`.

The parser is schema-independent — it infers structure from what the actor
produced. Validation against declared `fields` happens downstream in
`validateShape`.

Delete `tryExtractJson` and `stripCodeFence` — no longer needed. JSON recovery
logic is replaced by straightforward tag extraction.

Update `COMPLETE_RE` to match the new block format. The tag names stay the
same (`relay-complete`), so `stripCompletionTag` works unchanged.

**Tag extraction approach:** use regex, not a full XML parser. The structure
is fixed and shallow — no arbitrary nesting, no namespaces, no CDATA. A set of
focused regexes is simpler and has no dependencies:

```typescript
const ROUTE_RE = /<route>([\s\S]*?)<\/route>/;
const ARTIFACT_RE = /<artifact\s+id="([^"]+)">([\s\S]*?)<\/artifact>/g;
const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;
const FIELD_RE = /<([a-zA-Z0-9_.:-]+)>([\s\S]*?)<\/\1>/g;
```

Unescape `&lt;`, `&gt;`, `&amp;` in extracted text values.

### Step 2b: Update `buildCompletionInstruction`

Replace the JSON format example with the XML format. The instruction becomes:

```
<relay-complete>
<route>ROUTE_NAME</route>
<artifact id="ARTIFACT_ID">value or field tags</artifact>
</relay-complete>
```

Update the requirements section:
- Remove JSON-specific rules (double-quoting, escaping newlines).
- Add XML rules: one `<route>` tag, one `<artifact>` tag per writable
  artifact, field values as plain text between tags.
- For artifacts with declared `fields` (Phase 3), show field tags. For now,
  all artifacts are text — value goes directly inside the `<artifact>` tag.

### Step 2c: Update `engine.ts`

In `runAction`, the code that processes `parseCompletion` output (lines
153-173) needs to adapt to the new `ParsedCompletion` type:

- Route validation stays the same — it's still a string compared against
  `step.routes`.
- Artifact write extraction changes. Currently it iterates
  `Object.entries(parsed.value.writes)`. With the new type, it iterates
  `parsed.value.writes` (a `ReadonlyMap`). For each artifact, convert the
  `ParsedArtifactValue` to the `unknown` value that `ArtifactStore.commit`
  expects:
  - `text` → the string value
  - `record` → the fields object
  - `record_list` → the items array

### Step 2d: Update `buildTaskPrompt` completion reminder

In `engine.ts`, line 301 — the "Completion reminder" section at the end of
the task prompt. Update the format example from JSON to XML.

### Step 2e: Update tests

**`test/actors/complete-step.test.ts`** — every test uses the JSON format.
All parsing tests must change to XML format. ~20 test cases.

Key test cases to preserve (in XML form):
- Happy path: route + artifact with text value
- Route + artifact with field tags (record)
- Route + artifact with item/field tags (record_list)
- Missing completion block → error
- Malformed XML (unclosed tags) → error
- Missing route → error
- Multiple completion blocks → first wins
- `stripCompletionTag` removes the block from display text

New test cases:
- Record artifact with extra fields → parsed (not rejected)
- Text artifact with XML special chars (`<`, `>`, `&`) → unescaped correctly
- Empty artifact value → text with empty string
- Whitespace in artifact content → preserved

**`test/runtime/scheduler.test.ts`** — uses a fake `ActorEngine`, not raw
completion text. The `ActionOutcome` type hasn't changed. These tests are
unaffected.

### Verify

`npx tsc --noEmit && npx vitest run`

**Commit:** `feat: replace JSON completion protocol with XML encoding`

---

## Phase 3: Add `fields` and `list` to artifact contracts

### Step 3a: Schema and types

**`draft.ts`** — add `fields` and `list` to `ArtifactContractSchema`:

```typescript
const ArtifactContractSchema = Type.Object(
  {
    id: IdField("Unique artifact identifier within this plan."),
    description: Type.String({
      minLength: 1,
      maxLength: 1000,
      description: "What this artifact represents.",
    }),
    fields: Type.Optional(
      Type.Array(
        IdField("A field name the artifact value must contain."),
        { minItems: 1 },
      ),
    ),
    list: Type.Optional(
      Type.Boolean({
        description:
          "If true, the artifact value is an array of objects each with the " +
          "declared fields. Defaults to false.",
      }),
    ),
  },
  {
    description:
      "Compile-time declaration of an artifact's identity, description, and structure.",
  },
);
```

**`types.ts`** — extend `ArtifactShape` and update how the compiler builds it:

```typescript
export type ArtifactShape =
  | { readonly kind: "text" }
  | { readonly kind: "record"; readonly fields: readonly string[] }
  | { readonly kind: "record_list"; readonly fields: readonly string[] };
```

`ArtifactContract` keeps `shape: ArtifactShape`.

### Step 3b: Compiler

**`compile.ts`** — in `buildArtifacts()`, derive `shape` from the doc's
`fields` and `list`:

```typescript
const shape: ArtifactShape = c.fields
  ? c.list
    ? { kind: "record_list", fields: c.fields }
    : { kind: "record", fields: c.fields }
  : { kind: "text" };

artifacts.set(id, { id, description: c.description, shape });
```

Delete the old `{ kind: "untyped_json" }` type and the `untyped_json` arm in
`validateShape`. The exhaustive switch enforces coverage of the three new
variants.

### Step 3c: Validation

**`artifacts.ts`** — replace `validateShape`:

```typescript
const validateRecord = (
  value: unknown,
  fields: readonly string[],
): Result<void, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(
      `expected an object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
  }
  const obj = value as Record<string, unknown>;
  const missing = fields.filter((f) => !(f in obj));
  if (missing.length > 0) {
    return err(`missing fields: ${missing.join(", ")}`);
  }
  return ok(undefined);
};

const validateShape = (
  value: unknown,
  contract: ArtifactContract,
): Result<void, string> => {
  switch (contract.shape.kind) {
    case "text":
      return typeof value === "string"
        ? ok(undefined)
        : err(`expected a string, got ${typeof value}`);
    case "record":
      return validateRecord(value, contract.shape.fields);
    case "record_list": {
      if (!Array.isArray(value)) {
        return err(`expected an array, got ${typeof value}`);
      }
      for (let i = 0; i < value.length; i++) {
        const r = validateRecord(value[i], contract.shape.fields);
        if (!r.ok) return err(`element [${i}]: ${r.error}`);
      }
      return ok(undefined);
    }
  }
};
```

### Step 3d: Prompt injection

**`complete-step.ts`** — in `buildCompletionInstruction`, update the writable
artifact lines to show field names and list status:

```typescript
.map((id) => {
  const contract = input.artifactContracts.get(id);
  const desc = contract?.description ?? "";
  const line = `  - ${unwrap(id)}: ${desc}`.trimEnd();
  const hints = formatShapeHint(contract?.shape);
  return hints ? `${line}\n${hints}` : line;
})
```

Add `formatShapeHint`:

```typescript
const formatShapeHint = (shape?: ArtifactShape): string => {
  if (!shape) return "";
  switch (shape.kind) {
    case "text":
      return "    Value: plain text";
    case "record":
      return `    Fields: ${shape.fields.join(", ")}`;
    case "record_list":
      return `    Fields (list): ${shape.fields.join(", ")}\n` +
             "    Produce one <item> per entry found.";
  }
};
```

Also update the format example in the instruction to show field tags for
record artifacts.

**`engine.ts`** — in `renderArtifact`, show the shape to reading actors.
Change the parameter from `description: string` to the full
`ArtifactContract | undefined` and derive description + shape hint from it.

### Step 3e: Templates

Update artifact declarations in bundled templates:

| Template | Artifact | `fields` | `list` |
|---|---|---|---|
| `bug-fix` | `diagnosis` | `[root_cause, file, line, fix]` | `true` |
| `bug-fix` | `fix_notes` | _(omit)_ | _(omit)_ |
| `verified-edit` | `change_notes` | _(omit)_ | _(omit)_ |
| `reviewed-edit` | `notes` | _(omit)_ | _(omit)_ |
| `reviewed-edit` | `spec_verdict` | `[compliant, gaps]` | _(omit)_ |
| `reviewed-edit` | `quality_verdict` | `[approved, issues, fixes]` | _(omit)_ |
| `debate` | `debate_log` | `[role, claims]` | `true` |
| `multi-gate` | `change_notes` | _(omit)_ | _(omit)_ |

Artifacts without `fields` are text. Templates' instruction prose can drop
the field enumeration since the completion protocol now carries it.

### Step 3f: Tests

**`draft.test.ts`:**
- Schema accepts artifact with `fields`
- Schema accepts artifact with `fields` and `list: true`
- Schema accepts artifact without `fields` (text)
- Schema rejects `fields` with empty array

**`artifacts.test.ts`:**
- Text shape accepts string, rejects number, rejects object
- Record shape accepts object with all fields, rejects missing field, permits
  extra fields, rejects non-object
- Record list accepts array of conforming objects, rejects element missing
  field (reports index), rejects non-array, accepts empty array

**`compile.test.ts`:**
- Artifact without `fields` compiles to `text` shape
- Artifact with `fields` compiles to `record` shape
- Artifact with `fields` + `list: true` compiles to `record_list` shape

**`complete-step.test.ts`:**
- Completion instruction includes field hint for record artifacts
- Completion instruction includes list hint for record_list artifacts

Update all test fixtures from `shape: { kind: "untyped_json" }` to no shape
(handled in Phase 1) — by Phase 3 these are already gone.

### Verify

`npx tsc --noEmit && npx vitest run`

**Commit:** `feat: add fields and list to artifact contracts with validation`

---

## Dependency graph

```
Phase 1: remove shape from schema
  │
  ▼
Phase 2: XML completion protocol
  │
  ▼
Phase 3: fields + list + prompt injection + validation
```

Strictly sequential. Phase 2 depends on Phase 1 (the schema must be clean
before changing the protocol). Phase 3 depends on Phase 2 (field validation
requires reliable XML transport for structured artifact values).

## File change summary

| File | Phase 1 | Phase 2 | Phase 3 |
|---|---|---|---|
| `src/plan/draft.ts` | delete shape | — | add `fields`, `list` |
| `src/plan/types.ts` | — | — | new `ArtifactShape` variants |
| `src/plan/compile.ts` | hardcode shape | — | derive shape from fields/list |
| `src/runtime/artifacts.ts` | — | — | new `validateShape` arms |
| `src/actors/complete-step.ts` | — | XML parser + format | field hints |
| `src/actors/engine.ts` | — | adapt to new ParsedCompletion | shape in reader prompt |
| `plans/*.md` | remove shape lines | — | add fields/list |
| `examples/*` | remove shape | — | add fields/list |
| `test/plan/draft.test.ts` | remove shape | — | field schema tests |
| `test/plan/compile.test.ts` | remove shape | — | shape derivation tests |
| `test/runtime/artifacts.test.ts` | remove shape | — | validation tests |
| `test/runtime/scheduler.test.ts` | remove shape | — | — |
| `test/actors/complete-step.test.ts` | remove shape | rewrite parse tests | field hint tests |
| `test/templates/substitute.test.ts` | remove shape | — | — |
| `test/replay.integration.test.ts` | remove shape | — | — |
| `test/index.confirmation.test.ts` | remove shape | — | — |

## Risks

**Phase 1** — Low risk. Mechanical removal, caught by `tsc`.

**Phase 2** — Highest risk. The completion protocol is the critical path
between actors and the scheduler. The XML parser must handle:
- Whitespace and newlines inside and between tags
- XML special characters in field values (`&lt;`, `&gt;`, `&amp;`)
- Missing or malformed tags (graceful error, not crash)
- Actors that emit the old JSON format during transition (reject clearly)

The regex-based parser must be thoroughly tested. Edge cases in tag extraction
(self-closing tags, nested angle brackets in prose) need explicit test
coverage.

**Phase 3** — Moderate risk. The main concern is the `engine.ts` parameter
narrowing (changing `buildTaskPrompt`'s contracts parameter from
`{ description: string }` to `ArtifactContract`). The only call site already
passes `ArtifactContract` values, so this is safe.
