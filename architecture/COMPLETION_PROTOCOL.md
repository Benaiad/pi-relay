# Completion Protocol — Problem and Solutions

## Problem

The current completion protocol requires actors to emit artifact
values inside a JSON payload embedded in an XML-like tag:

```
<relay-complete>{"route":"done","writes":{"debate_log":{"role":"critic","critique":"The argument fails because..."}}}</relay-complete>
```

This fails frequently because:

1. **Long strings break JSON.** The model must escape every `"`, `\n`,
   `\`, and special character inside JSON string values. For a 2000-word
   debate argument, this is error-prone. One unescaped quote and the
   JSON is invalid.

2. **Trailing text after JSON.** The model sometimes writes extra
   content after the JSON closing brace but before the closing tag.
   We added `tryExtractJson` to handle this, but it's a workaround.

3. **The model doesn't know it's generating JSON.** It writes free
   text, then has to switch to precise JSON serialization for the
   completion tag. This context switch is where most errors happen.

The root cause: artifacts are serialized as JSON values embedded in
a hand-written JSON string. Models are bad at this for long content.

## What we want

The actor produces:
- A **route** — which outgoing edge to follow (always a short string)
- **Artifact values** — structured data or prose to commit
- **Narration** — free-form explanation the planner sees

The route is always short and structured. Artifact values range from
simple objects (`{root_cause: "...", fix: "..."}`) to long prose
(debate arguments). Narration is always free text.

## Solution options

### Option A: Separate artifact tags (text-based)

Split artifacts out of the completion JSON into their own tags:

```
Here is my full argument about the topic...

<relay-artifact id="debate_log">
role: advocate
claims:
  - Free will is an illusion
  - Determinism follows from physics
</relay-artifact>

<relay-complete>{"route":"done"}</relay-complete>
```

The completion JSON stays tiny — just the route and an empty writes
object. Artifact values go in `<relay-artifact>` tags as free text
or YAML. No JSON escaping needed.

Pros:
- No JSON serialization of long text
- Artifacts can be prose, YAML, or any format
- The completion JSON never breaks

Cons:
- Two different tag types to parse
- The model needs to learn a new protocol element
- YAML parsing for artifact values adds ambiguity
- No schema validation on artifact content

### Option B: Structured output via API (constrained decoding)

Use the model provider's structured output feature to force the
completion response to match a JSON schema. The model cannot produce
invalid JSON — the provider's constrained decoder rejects invalid
tokens during generation.

Claude API supports this via `output_config: { json_schema: ... }`
with guaranteed schema compliance. OpenAI, Google, and others have
similar features.

For relay, this would mean: instead of asking the model to write
`<relay-complete>` as free text, register a synthetic tool
(`complete_step`) with a TypeBox schema. The model calls the tool
instead of writing a tag. The provider validates the JSON. Artifact
values are tool parameters, not hand-serialized strings.

```ts
// Synthetic tool registered for each action step
{
  name: "complete_step",
  parameters: {
    route: { type: "string", enum: ["done", "failure"] },
    writes: {
      debate_log: { type: "object", properties: {...} }
    }
  }
}
```

The model calls `complete_step(route: "done", writes: {...})`.
The provider guarantees the JSON is valid. The engine reads it
from the tool call, not from free text.

Pros:
- Zero JSON errors — constrained decoding guarantees validity
- Schema validation at the provider level
- The model uses tool calling, which it already knows how to do
- Artifact values can have schemas (typed artifacts)
- No custom tags to parse

Cons:
- Requires the subprocess pi to support `tool_choice: forced`
  or equivalent — currently pi doesn't expose this for extensions
- The synthetic tool would conflict with pi's built-in tool system
- Artifact values are still JSON — long strings still need escaping,
  but the provider handles it correctly
- Provider-dependent — not all providers support structured output
- Adds latency (schema compilation on first use, ~100-300ms)

### Option C: Keep the current protocol, improve robustness

Keep `<relay-complete>` as-is but:
1. The `tryExtractJson` parser handles trailing text (already done)
2. Instruct the model to keep artifact values short (already done)
3. Add retry-on-parse-failure with better error messages
4. Accept that long prose in artifacts will sometimes fail

Pros:
- No protocol change
- Already implemented

Cons:
- The fundamental fragility remains
- Long artifact values will keep failing
- Workaround, not a fix

### Option D: Tool-based completion via pi's tool system

Register `complete_step` as a real pi tool in the actor subprocess.
The model calls it like any other tool. Pi's tool system handles
JSON serialization and validation.

The difference from Option B: this uses pi's existing tool
infrastructure, not the raw API's structured output feature. The
tool's parameter schema is a TypeBox schema (same as relay's own
tool schema). Pi validates the arguments before returning them.

```ts
// In the actor subprocess, register a synthetic tool:
pi.registerTool({
  name: "complete_step",
  parameters: Type.Object({
    route: Type.String({ enum: [...allowedRoutes] }),
    writes: Type.Object({
      // per-artifact schemas generated from contracts
    })
  }),
  execute(_, params) {
    // Return the completion to the engine
    return { content: [{ type: "text", text: JSON.stringify(params) }] };
  }
});
```

But this requires the actor subprocess to register a custom tool,
which means loading a mini-extension in the subprocess. Currently
we spawn with `--no-extensions` to prevent exactly this.

Pros:
- Uses pi's tool validation
- The model calls a tool, not a tag — familiar pattern
- TypeBox schema validation

Cons:
- Requires loading an extension in the subprocess
- Circular dependency risk (relay extension in subprocess)
- Complex setup per actor spawn

## Recommendation

**Option B (structured output) is the long-term answer.** Constrained
decoding eliminates JSON errors at the provider level. But it requires
pi to expose `tool_choice` or `output_config` to extensions, which
it doesn't today.

**Option A (separate artifact tags) is the pragmatic near-term fix.**
It eliminates JSON serialization for artifact values entirely. The
completion JSON stays tiny (just the route). Artifacts can be free
text, YAML, or short JSON. The parser is simple. No provider
dependency.

**Option C (current + robustness) is what we have now.** It works for
most cases but fails on long prose artifacts (debates, detailed
reviews).

## Open question

Does pi expose any way to force tool calling or structured output
in subprocess mode? If so, Option B becomes immediately viable.
If not, Option A is the path forward.
