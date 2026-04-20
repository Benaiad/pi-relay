## Analysis: Why the Relay Schema is Hard for AI Models

After reading through the codebase, here's a structured breakdown of the complexity problem and what can be done about it:

### The Current State

The `relay` tool requires the model to produce a **~180-line JSON schema** (7.8KB in TypeBox form, 34 `Type.*` calls) with a deeply nested discriminated union structure. A simple verified-edit plan requires the model to correctly produce:

```json
{
  "task": "...",
  "entryStep": "implement",
  "artifacts": [],
  "steps": [
    { "kind": "action", "id": "implement", "actor": "worker", "instruction": "...", "reads": [], "writes": [], "routes": { "done": "verify" } },
    { "kind": "verify_command", "id": "verify", "command": "npm test", "onPass": "done", "onFail": "failed" },
    { "kind": "terminal", "id": "done", "outcome": "success", "summary": "Done." },
    { "kind": "terminal", "id": "failed", "outcome": "failure", "summary": "Failed." }
  ]
}
```

Even this simplest plan requires **4 distinct step kinds**, correct `kind` discriminators, different routing semantics per kind (`routes` vs `onPass`/`onFail`), consistent `id` references, and artifact wiring with `reads`/`writes`.

### Specific Pain Points

1. **Cognitive load of 4 step kinds** — The model must remember the field layout for `action`, `verify_command`, `verify_files_exist`, and `terminal`. Each has different required fields and routing conventions. This was already improved by the Flatten Step Types change (eliminating nested `check` objects), but 4 kinds is still a lot.

2. **Ceremonial boilerplate** — Every plan needs at least 2 terminal steps (success + failure). The `artifacts: []` array is required even for plans with no artifacts. The `reads: []` and `writes: []` arrays are required on every action step. This is noise the model must get right.

3. **Artifact ceremony** — The `shape: { kind: "untyped_json" }` field is required on every artifact declaration but only has one possible value. The FLATTEN_STEP_TYPES arch doc explicitly calls this out as "dead weight."

4. **Inconsistent routing** — Action steps use `routes: { name: target }` (a map). Verify steps use `onPass`/`onFail` (two separate fields). The model has to remember which routing style applies to which step kind.

5. **ID consistency** — Every `routes.*`, `onPass`, `onFail`, `entryStep`, `reads.*`, and `writes.*` must reference an existing step or artifact ID. One typo and the plan fails to compile. The model gets no autocomplete or incremental validation.

### What Can Be Done

Here are several approaches, from least to most invasive:

---

#### 1. **Eliminate `shape` from artifacts** (trivial)
Right now every artifact declares `shape: { kind: "untyped_json" }` — the only possible value. Remove it from the schema and default it internally. One less thing to think about.

```json
// Before
artifacts: [{ id: "notes", description: "Worker notes", shape: { kind: "untyped_json" } }]

// After
artifacts: [{ id: "notes", description: "Worker notes" }]
```

---

#### 2. **Default `reads`/`writes` to empty arrays** (easy)
Make `reads` and `writes` optional on action steps, defaulting to `[]`. Most steps don't use artifacts. The model shouldn't need to write `"reads": [], "writes": []` on every single step.

---

#### 3. **Auto-generate terminal steps** (moderate)
Instead of requiring the model to write terminal steps explicitly, allow the schema to have no terminals and auto-create `done` (success) and `failed` (failure) terminals. This eliminates the most boilerplate-heavy step kind.

```json
// Before: model writes 4 steps for a simple plan
steps: [implement, verify, done_terminal, failed_terminal]

// After: model writes 2 steps, terminals are implicit
steps: [
  { kind: "action", id: "implement", ..., routes: { done: "verify" } },
  { kind: "verify_command", id: "verify", ..., onPass: "done", onFail: "failed" }
]
// "done" and "failed" are auto-created as terminals
```

---

#### 4. **Unify routing** (moderate, more controversial)
Give verify steps a `routes` map with fixed `pass`/`fail` keys instead of separate `onPass`/`onFail` fields. This makes the routing model uniform across all non-terminal steps.

```json
// Before
{ "kind": "verify_command", "onPass": "done", "onFail": "failed", ... }

// After
{ "kind": "verify_command", "routes": { "pass": "done", "fail": "failed" }, ... }
```

The architecture doc argues this is "pure ceremony" since verify always has exactly 2 outcomes. But the cognitive benefit of one routing model may outweigh the ceremony argument.

---

#### 5. **Higher-level abstractions / "plan builders"** (biggest impact, most work)
Instead of making the model construct the raw DAG, offer a more declarative surface that compiles down to the current IR. For example:

```json
{
  "task": "Add rate limiting",
  "steps": [
    { "kind": "action", "actor": "worker", "instruction": "..." },
    { "kind": "verify", "command": "npm test" }
  ]
}
```

Where the compiler infers:
- Sequential ordering from array position
- `entryStep` = first step
- Auto-generated terminals
- `id` from array index or a short name
- `routes` = linear chain with failure branch

This is essentially what the `replay` templates already do — they're higher-level abstractions over the raw DAG. The question is whether to expose a simplified *ad-hoc* building surface too.

---

#### 6. **Lean into `replay` for common patterns** (pragmatic, already available)
The five bundled templates (`verified-edit`, `bug-fix`, `reviewed-edit`, `multi-gate`, `debate`) already cover most use cases. The system prompt already steers models toward `replay` when a template matches. The `relay` tool is only needed for genuinely novel DAG topologies.

This suggests the most impactful thing might not be simplifying the `relay` schema at all, but rather:
- Making the model's system prompt better at recognizing when `replay` applies
- Adding more templates for common patterns
- Making template authoring easier

---

### My Recommendation

A layered approach:

1. **Quick wins** (#1 + #2): Remove `shape` from artifacts, default `reads`/`writes` to `[]`. These are low-risk, reduce boilerplate, and don't change the conceptual model.

2. **Auto-terminals** (#3): Big ergonomic win for the common case. The model should rarely need to think about terminal steps.

3. **Keep `relay` as a power tool**: Accept that `relay` is inherently complex because it's building a DAG. Instead of trying to make the raw schema "easy," invest in making `replay` cover more cases and making the system prompt smarter about choosing `replay` vs `relay`.

Want me to draft an architecture doc for any of these changes, or implement the quick wins?