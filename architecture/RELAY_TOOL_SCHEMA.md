Here's the schema definition the models see for the `relay` tool — this is what's provided to them as the function signature:

```json
{
  "type": "object",
  "required": ["task", "steps"],
  "properties": {
    "task": {
      "type": "string",
      "minLength": 1,
      "maxLength": 4000,
      "description": "Natural-language description of what this plan accomplishes."
    },
    "successCriteria": {
      "type": "string",
      "maxLength": 2000,
      "description": "How success will be judged. Referenced by actors and reviewers as part of their context."
    },
    "artifacts": {
      "type": "array",
      "description": "Every artifact the plan produces or consumes. Defaults to none.",
      "items": {
        "type": "object",
        "required": ["id", "description", "shape"],
        "properties": {
          "id": {
            "type": "string",
            "description": "Unique artifact identifier within this plan.",
            "minLength": 1,
            "maxLength": 128,
            "pattern": "^[a-zA-Z0-9_.:-]+$"
          },
          "description": {
            "type": "string",
            "minLength": 1,
            "maxLength": 1000,
            "description": "What this artifact represents, e.g. 'parsed requirements' or 'test output JSON'."
          },
          "shape": {
            "type": "object",
            "required": ["kind"],
            "properties": {
              "kind": { "const": "untyped_json" }
            },
            "description": "The stored shape of an artifact. v0.1 only supports `untyped_json`; named TypeBox shapes land in v0.2."
          }
        },
        "description": "Compile-time declaration of an artifact's identity, description, and shape."
      }
    },
    "steps": {
      "type": "array",
      "minItems": 1,
      "maxItems": 64,
      "description": "All steps in the plan. Must contain the entry step and at least one terminal step. Max 64 steps.",
      "items": {
        "anyOf": [
          {
            "type": "object",
            "required": ["kind", "id", "actor", "instruction", "routes"],
            "properties": {
              "kind": { "const": "action" },
              "id": { "type": "string", "description": "Unique step identifier within this plan.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" },
              "actor": { "type": "string", "description": "ActorId of the agent that will run this step. Must match an actor discovered in the relay-actors directory.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" },
              "instruction": { "type": "string", "minLength": 1, "maxLength": 8000, "description": "Task instruction handed to the actor, describing exactly what to do." },
              "reads": { "type": "array", "items": { "type": "string", "description": "An ArtifactId this actor may read.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" }, "description": "Artifacts visible to this step's actor in its input snapshot. Every read must have a writer. Defaults to none." },
              "writes": { "type": "array", "items": { "type": "string", "description": "An ArtifactId this step may commit.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" }, "description": "Artifacts this step is allowed to produce. Each artifact has at most one writing step. Defaults to none." },
              "routes": {
                "type": "object",
                "minProperties": 1,
                "description": "Map of route names to target step IDs, e.g. { \"done\": \"next-step\", \"failure\": \"handle-error\" }. The actor must emit exactly one of these route names on completion.",
                "patternProperties": {
                  "^[a-zA-Z0-9_.:-]+$": { "type": "string", "description": "StepId the runtime transitions to when this route is emitted.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" }
                }
              },
              "maxRuns": { "type": "integer", "minimum": 1, "maximum": 10000, "description": "Maximum times this step can be activated in a single run. Defaults to 10. Increase for steps that are re-entered via back-edges in long-running loops (e.g. an experiment loop that runs overnight)." }
            },
            "description": "An LLM-backed step. The actor runs with the declared tool list and must call `complete_step` with the chosen route and any artifact writes."
          },
          {
            "type": "object",
            "required": ["kind", "id", "command", "onPass", "onFail"],
            "properties": {
              "kind": { "const": "verify_command" },
              "id": { "type": "string", "description": "Unique step identifier within this plan.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" },
              "command": { "type": "string", "minLength": 1, "description": "Shell command to run, e.g. 'npm test' or 'cargo test && cargo clippy'. Executed via bash." },
              "timeoutMs": { "type": "integer", "minimum": 100, "maximum": 600000, "description": "Timeout in milliseconds. Defaults to 600000 (10 minutes)." },
              "onPass": { "type": "string", "description": "StepId transitioned to when the command exits 0.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" },
              "onFail": { "type": "string", "description": "StepId transitioned to when the command exits non-zero or times out.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" }
            },
            "description": "A deterministic verification step that runs a shell command. Pass iff the command exits 0 within the timeout. Stdout and stderr are captured for the failure reason. Neither reads nor writes artifacts."
          },
          {
            "type": "object",
            "required": ["kind", "id", "paths", "onPass", "onFail"],
            "properties": {
              "kind": { "const": "verify_files_exist" },
              "id": { "type": "string", "description": "Unique step identifier within this plan.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" },
              "paths": { "type": "array", "minItems": 1, "items": { "type": "string", "minLength": 1, "description": "Absolute or working-directory-relative path that must exist." }, "description": "Paths that must all exist for the check to pass. Failure reason lists which are missing." },
              "onPass": { "type": "string", "description": "StepId transitioned to when all paths exist.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" },
              "onFail": { "type": "string", "description": "StepId transitioned to when one or more paths are missing.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" }
            },
            "description": "A deterministic verification step that checks filesystem paths. Pass iff every listed path exists. Neither reads nor writes artifacts."
          },
          {
            "type": "object",
            "required": ["kind", "id", "outcome", "summary"],
            "properties": {
              "kind": { "const": "terminal" },
              "id": { "type": "string", "description": "Unique step identifier within this plan.", "minLength": 1, "maxLength": 128, "pattern": "^[a-zA-Z0-9_.:-]+$" },
              "outcome": { "anyOf": [{ "const": "success" }, { "const": "failure" }], "description": "Whether reaching this terminal represents the plan succeeding or failing." },
              "summary": { "type": "string", "minLength": 1, "maxLength": 2000, "description": "Human-readable summary of this terminal outcome, shown in the run report." }
            },
            "description": "A terminal step. Reaching one ends the run with the declared outcome."
          }
        ],
        "description": "One node in the plan DAG. Exactly one of: action, verify_command, verify_files_exist, or terminal."
      }
    },
    "entryStep": {
      "type": "string",
      "description": "StepId where execution begins. Defaults to the first step in `steps`.",
      "minLength": 1,
      "maxLength": 128,
      "pattern": "^[a-zA-Z0-9_.:-]+$"
    }
  },
  "description": "A structured plan for a multi-step workflow. Submit one of these via the `relay` tool when a task requires multiple actors, verification gates, or outcomes where partial success is unacceptable. For simple one-shot edits, Q&A, or single-tool work, call the underlying tools directly instead."
}
```

Plus the prose description text that accompanies it:

> Execute a structured multi-step workflow with typed artifacts and deterministic verification gates. Use this for tasks that require multiple specialized actors, verification gates (tests/checks), or workflows where partial success is unacceptable. Do NOT use this for single-tool edits, Q&A, explanations, or simple bug fixes — call the underlying tools directly instead. YOU are the planner: when you submit a plan, the step instructions must already contain concrete file paths, commands, and decisions you have reasoned through. Do NOT add a 'planner' actor to the plan expecting a second round of planning to happen at runtime — actors execute, they do not plan. If you need to scout the codebase, use your own read/grep/find tools before calling relay, then bake the findings into the plan's instructions.
>
> Available actors for the 'actor' field of each action step. Use these names EXACTLY:
>   - worker: General-purpose implementer... [allowed tools: read, edit, write, grep, find, ls, bash]
>   - reviewer: Reviews an implementation... [allowed tools: read, grep, find, ls, bash]
>   - advocate: Argues for a position... [allowed tools: read, grep, find, ls]
>   - critic: Challenges a position... [allowed tools: read, grep, find, ls]
>   - judge: Evaluates debate arguments... [allowed tools: read, grep, find, ls]
>
> Each action step carries an 'instruction' field that is the task-specific prompt for that step. The actor's persona (tool list, coding standards, output style) stays the same across steps; the 'instruction' is how you tell the SAME actor to do DIFFERENT work at different points in the plan.
>
> Artifacts accumulate: every commit appends an entry with attribution (step, attempt). Readers see the full history. A review loop looks like: create writes notes → review reads notes writes verdict → fix reads verdict writes notes → (back-edge) review → accepted terminates.

Key changes from the previous schema version:
- `required` is now `["task", "steps"]` — was `["task", "artifacts", "steps", "entryStep"]`
- `entryStep` is optional — defaults to the first step in `steps`
- `artifacts` is optional — defaults to empty
- `reads` and `writes` on action steps are optional — default to empty
- Action step `required` is now `["kind", "id", "actor", "instruction", "routes"]` — was `["kind", "id", "actor", "instruction", "reads", "writes", "routes"]`
