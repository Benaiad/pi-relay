# Tool-Based Completion Protocol

## Problem

Actors signal completion by emitting an XML block in free-form text:

```xml
<relay-complete>
<route>done</route>
<artifact id="notes">plain text value</artifact>
</relay-complete>
```

The scheduler regex-parses this from the actor's final assistant message. This
has several problems:

1. **No schema enforcement.** The model can emit malformed XML, miss tags, or
   nest things incorrectly. The regexes silently produce wrong results rather
   than failing cleanly.

2. **Structure inference is ambiguous.** `parseArtifactContent` guesses whether
   content is a record, a list, or plain text by trying three strategies in
   order. A text artifact containing `<tag>value</tag>` gets misidentified as a
   record.

3. **Prompt overhead.** `buildCompletionInstruction` generates a multi-paragraph
   protocol spec with examples on every actor invocation. The model must
   "remember" to emit the block as its last action.

4. **Subprocess indirection.** Actors spawn as `pi` CLI subprocesses. The XML
   protocol exists because there is no structured channel between the subprocess
   and the scheduler. But pi exposes `createAgentSession` with `customTools`,
   making subprocess spawning unnecessary.

## Proposal

Replace the XML completion protocol with a terminating tool call. Each actor
step gets a dynamically-constructed `relay_complete` tool whose schema is
derived from the step's declared routes and writable artifacts. The model calls
the tool with structured JSON arguments. `terminate: true` ends the agent turn.

Replace subprocess spawning with in-process `createAgentSession` from pi's SDK.
The scheduler creates a session per actor invocation, registers the completion
tool alongside the actor's declared tools, sends the task prompt, and reads the
structured result directly from the tool's `details`.

## User experience

No change. Plan authors still write the same YAML plans with the same artifact
contracts, routes, and actor declarations. The completion protocol is invisible
to plan authors — it is internal machinery between the actor and the scheduler.

Actors may behave slightly better because the model is calling a tool (native
capability it's trained on) instead of emitting hand-crafted XML (prompt
engineering).

## How it works

### Completion tool construction

For each action step invocation, the scheduler constructs a `relay_complete`
tool definition from the step's metadata:

```
Step declaration:
  routes: [done, needs_fix]
  writes: [review_notes (text), issues (record_list: file, severity, description)]

Becomes tool parameters:
  route: "done" | "needs_fix"           (string union from step.routes)
  review_notes: string                  (text shape → string)
  issues: Array<{file, severity, description}>  (record_list shape → typed array)
```

The route parameter uses a string enum so the API rejects invalid route names.
Each writable artifact becomes a top-level parameter whose type is derived from
its `ArtifactShape`:

| ArtifactShape   | Tool parameter type                                    |
|-----------------|--------------------------------------------------------|
| `text`          | `string`                                               |
| `record`        | `object` with one `string` property per declared field |
| `record_list`   | `array` of objects, each with `string` field per field |

Artifacts the step can write but doesn't have to are marked optional in the
schema. The model omits them if it has nothing to write.

The tool's `execute` function is trivial — it returns the params as `details`
with `terminate: true`. No side effects. The scheduler reads `details` after
`prompt()` resolves.

### Actor invocation via SDK

Today, `createSubprocessActorEngine` spawns a pi CLI process per action step.
The new engine uses `createAgentSession` from `@mariozechner/pi-coding-agent`:

```
1. Build system prompt (actor preamble only — no completion protocol section)
2. Construct relay_complete tool from step metadata
3. Create session:
   - model: from actor config
   - thinkingLevel: from actor config
   - tools: actor's declared tools + "relay_complete"
   - customTools: [relayCompleteTool]
   - systemPrompt: actor preamble (appended via session API)
4. Subscribe to session events for progress streaming
5. session.prompt(taskPrompt)
6. On resolution: extract relay_complete tool call from messages
7. Return ActionOutcome with route + writes from tool details
```

### Progress streaming

The subprocess engine currently parses line-delimited JSON from pi's stdout.
The SDK engine subscribes to `AgentSessionEvent`:

- `message_update` with assistant text → emit `action_progress` with text item
- `tool_execution_start` → emit `action_progress` with tool_call item
- `agent_end` → extract completion, build `ActionOutcome`

The `TranscriptItem` type and `ActorProgressEvent` interface stay the same.
The scheduler and UI see identical progress events.

### Extracting completion from messages

After `prompt()` resolves, walk the session's messages backward to find the
last `toolResult` for `relay_complete`. The tool's `details` field contains the
structured route and artifact values — no parsing needed.

If no `relay_complete` call exists in the messages (the model finished without
calling the tool), return `no_completion`. The scheduler's existing retry logic
handles this identically to today's "completion block not found" case.

### System prompt changes

The completion protocol instruction (`buildCompletionInstruction`) is replaced
by the tool's own `description` and `promptGuidelines`. These are shorter and
leverage the model's native understanding of tool calling:

```
description: "Signal that you have completed this step. Choose a route and
provide values for any artifacts you want to commit."

promptGuidelines:
  - "Call relay_complete exactly once, as your final action."
  - "Do not call relay_complete until every task requirement is met."
```

The actor's system prompt (preamble from the actor markdown file) is unchanged.

### Abort handling

Today: `SIGTERM` → 5s grace → `SIGKILL`.

With in-process sessions: pass an `AbortSignal` to the session. The agent loop
checks the signal between turns and tool executions. On abort, `prompt()`
rejects, and the engine returns `ActionOutcome { kind: "aborted" }`.

The abort behavior is functionally equivalent. The scheduler's abort handling
does not change.

## Data model

### New type: `CompletionToolParams`

Dynamic per step. Not a static type — constructed at runtime from
`ArtifactContract[]` and `RouteId[]`. The TypeBox schema serves as both the
type definition and the JSON Schema sent to the API.

### Changes to `ActorEngine`

The `ActorEngine` interface (`runAction(request): Promise<ActionOutcome>`)
does not change. The new implementation is a drop-in replacement for
`createSubprocessActorEngine`.

### Changes to `ActionOutcome`

None. The `completed` variant already carries `route: RouteId` and
`writes: ReadonlyMap<ArtifactId, unknown>`. The new engine populates these
from the tool's `details` instead of from `parseCompletion`.

### Changes to `ActionRequest`

None. The request already carries everything the new engine needs: step
metadata, actor config, artifact snapshot, abort signal, progress callback.

## What gets deleted

- `buildCompletionInstruction` and the completion protocol prompt text
- `parseCompletion`, `parseArtifactContent`, `parseFieldTags`, `unescapeXml`
- `stripCompletionTag` (UI no longer needs to strip XML from actor text)
- `buildExampleBlock`, `formatShapeHint` (only used by completion instruction)
- All XML regexes: `COMPLETE_RE`, `ROUTE_RE`, `ARTIFACT_RE`, `ITEM_RE`, `FIELD_TAG_RE`
- `spawnAndStream`, `getPiInvocation` (subprocess machinery)
- `extractFinalAssistantText` (replaced by walking session messages)
- The `buildSystemPrompt` helper that concatenates preamble + completion
  instruction

`complete-step.ts` can be deleted entirely. The engine simplifies
substantially.

## What stays the same

- `ActorEngine` interface and `ActionOutcome` type
- `ActionRequest` and `ActorConfig` types
- `ArtifactStore` and shape validation (commit still validates shapes)
- Scheduler dispatch, routing, retry, and commit logic
- Actor discovery (markdown files with frontmatter)
- `TranscriptItem` and progress event types
- Plan types, artifact contracts, branded IDs
- All UI rendering code

## Security

No change in trust boundary. The actor's tool access is still controlled by
the `tools` allowlist in `ActorConfig`. The `relay_complete` tool has no side
effects — it just returns its params. Artifact values are still validated by
`ArtifactStore.commit` before being accepted.

The in-process model removes the subprocess isolation boundary. A bug in pi's
agent loop could affect the scheduler process. This is mitigated by:
- `prompt()` runs async and rejects on failure (try/catch)
- The abort signal provides a timeout mechanism
- The scheduler already handles `engine_error` and retries

## Tradeoffs

### What we gain

- **Schema enforcement at the API level.** Invalid routes, missing fields, and
  wrong types are rejected by the Anthropic API before the model's response is
  even returned. No regex parsing, no structure inference.

- **Less prompt overhead.** The completion protocol instruction is ~40 lines of
  imperative text per invocation. The tool description is ~3 lines. The model
  already knows how to call tools.

- **No parsing ambiguity.** The artifact shape is encoded in the tool schema.
  Text artifacts are strings, record artifacts are objects with typed fields.
  No guessing.

- **Cleaner codebase.** `complete-step.ts` (250 lines), subprocess spawning
  and streaming logic, temp file management — all deleted.

- **Better model behavior.** Tool calling is a native capability the model is
  trained on. XML-in-text is prompt engineering that varies in reliability
  across models and over time.

### What we lose

- **Subprocess isolation.** A crash in the agent loop now affects the scheduler
  process. Mitigated by async error handling and abort signals, but the failure
  domain is broader.

- **Version coupling.** The engine depends on pi's internal SDK types. Pi
  upgrades that change `createAgentSession`, `AgentSession`, or tool
  registration could break the engine. Today, the subprocess boundary insulates
  from internal changes — only the CLI interface and JSON streaming format
  matter.

  Note: pi-relay already declares `@mariozechner/pi-coding-agent ^0.69.0` as a
  peer dependency, so this coupling already exists at the package level. The
  question is whether the programmatic API surface is stable enough.

### Risk: SDK API stability

`createAgentSession` is pi's public SDK entry point, exported from the package
index. It accepts `customTools` and `tools` as documented options. If this API
changes, pi-relay breaks. The subprocess approach is insulated from internal
changes but coupled to CLI args and JSON output format — a different stability
surface, not necessarily a more stable one.

### Risk: resource lifecycle

`createSubprocessActorEngine` gets resource cleanup for free — process exit
cleans everything. In-process sessions need explicit `session.dispose()`. A
leaked session could accumulate memory. The engine must dispose in all paths:
success, error, and abort.

## What this does NOT cover

- Migrating command steps (they don't use the completion protocol)
- Changing plan YAML syntax or artifact contract declarations
- Changing the actor markdown format
- Adding new artifact shapes beyond text/record/record_list
- Changing the scheduler's retry or routing logic
