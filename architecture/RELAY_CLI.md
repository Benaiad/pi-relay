# Relay CLI: Headless Template Execution

## What this is

A one-shot command that runs a relay template file and exits. Designed for CI.

```bash
relay plans/verified-edit.md -e task="Add input validation to signup.ts" -e verify="npm test"
```

You point at a template file, pass variables with `-e`, get a result. Like
`ansible-playbook site.yml -e version=1.2.3`. The file is the contract — you
see it in your repo, you review it in PRs, you point at it and run it.

## Invocation

```bash
relay <file> [-e key=value]... [-e @file.json] [options]
```

`<file>` is a path to a template `.md` file. Always explicit, never
discovered. The template lives in your repo alongside your code.

```bash
# Run a template from your project
relay plans/verified-edit.md -e task="Fix the bug" -e verify="npm test"

# Vars from file (Ansible convention)
relay plans/reviewed-edit.md -e @ci/params.json

# Mixed: file provides base values, -e flags override
relay plans/reviewed-edit.md -e @ci/params.json -e verify="cargo test"

# Override working directory via parameter
relay plans/bug-fix.md -e bug="Auth fails" -e verify="npm test" -e cwd=packages/api
```

`-e @file.json` loads a JSON object `{ "key": "value" }`. `-e key=value`
flags are applied after, overriding file values.

Actors are still discovered from bundled + user + project directories. The
template references actors by name (`actor: worker`), and the runtime
resolves them. Templates are project-specific workflows you write and version.
Actors are reusable role definitions that ship with relay or live in your
config.

### Options

```
-e key=value              Set a template parameter
-e @file.json             Load parameters from JSON file
--dry-run                 Validate and show the compiled plan, then exit. No LLM calls.
--output <mode>           json (default if !TTY) | text (default if TTY) | stream-json
--model <provider/name>   Default model for actors without model config (e.g. anthropic/claude-sonnet-4-5)
--thinking <level>        Default thinking level for actors without thinking config (default: off)
--api-key <key>           API key (defaults to ANTHROPIC_API_KEY env var)
```

### Model and thinking resolution

Actors can declare `model:` and `thinking:` in their frontmatter. The CLI
flags are fallbacks for actors that don't.

```
per actor:
  model    = actor frontmatter model:    → or --model flag → or error
  thinking = actor frontmatter thinking: → or --thinking flag → or "off"
```

`--model` is only required when one or more actors in the plan don't declare
their own model. If all actors specify `model:`, `--model` is unnecessary.

`--thinking` defaults to `"off"` — no extended thinking unless explicitly
requested. This keeps CI costs predictable.

`--model` uses the same `provider/model-name` format as actor frontmatter:
`anthropic/claude-sonnet-4-5`, `openai/gpt-4o`, etc.

If an actor has no model and `--model` isn't provided:

```
Error: Actor 'worker' has no model configured.
Use --model <provider/name> or add 'model:' to the actor file.
```

## No Jinja

The current `{{placeholder}}` substitution operates on the *parsed* YAML
object, not the raw string. This is a safety property: a parameter value
containing YAML special characters (`"`, `:`, `\n`) cannot corrupt the
document structure.

Jinja is a string template engine. It would either lose this safety or
require escaping values before substitution. The features people want from
Jinja:

- **Defaults** → `default:` field in parameter schema (see below)
- **Env vars** → the CI system templates these into `-e` values
- **Conditionals** → separate templates, or pass the computed value

Every useful Jinja feature is solvable at the parameter schema level or
belongs in the CI workflow definition. Adding Jinja creates a second
templating layer that fights with GitHub Actions' `${{ }}`, GitLab's
`$CI_*`, etc. Not worth it.

## Parameter defaults

Current model: `required: true | false`, optional params default to empty
string. This is useless — an empty string is never the right default.

New model: a parameter with `default` is optional. A parameter without
`default` is required. No `required` field.

```yaml
parameters:
  - name: task
    description: What to implement.
  - name: verify
    description: Verification command.
    default: "npm test"
```

```bash
# Only task is required
relay plans/verified-edit.md -e task="Fix the bug"
# verify defaults to "npm test"
```

### Type change

```typescript
interface TemplateParameter {
  readonly name: string;
  readonly description: string;
  readonly default?: string;     // replaces `required: boolean`
}
```

A parameter is required iff `default` is undefined. During substitution, if a
parameter has a default and wasn't provided, use the default. The `required`
field is removed — it's derived from the presence of `default`.

### Migration

Existing templates use `required: true` (which is the same as no `default`)
or `required: false` (which defaulted to empty string). The parser accepts
both forms during transition:

- `required: true` → no default (same behavior)
- `required: false` → `default: ""` (preserves existing behavior)
- `default: "value"` → new form, takes precedence over `required`

## Plan `cwd`

`cwd` is a field on `PlanDraftDoc` — the plan itself, not the template
frontmatter. Both the ad-hoc `relay` tool and templates set it the same way.

### In a template

`cwd` goes in the plan body and participates in normal `{{placeholder}}`
substitution:

```yaml
---
name: bug-fix
description: Diagnose, fix, verify.
parameters:
  - name: cwd
    description: Working directory.
    default: "."
  - name: bug
    description: The bug.
  - name: verify
    description: Shell command that proves the fix.
---

cwd: "{{cwd}}"
task: "{{bug}}"
steps:
  - type: action
    name: diagnose
    ...
```

No `-e cwd=...` → defaults to `"."`. With `-e cwd=packages/api` → that
directory becomes the working directory for all steps.

### In an ad-hoc relay plan

The model sets `cwd` directly:

```json
{
  "cwd": "packages/api",
  "task": "Fix the auth bug",
  "steps": [...]
}
```

### How it works

1. `cwd` is an optional field in `PlanDraftSchema`
2. In templates, it's substituted along with the rest of the plan body
3. `executePlan` / CLI reads `plan.cwd` and resolves it relative to
   `process.cwd()` (or `ctx.cwd` in the extension)
4. If absent, uses `process.cwd()` (CLI) or `ctx.cwd` (extension)
5. The resolved cwd is passed to `runPlan`, which passes it to the scheduler

One code path for both relay and replay. No special `cwdOverride`, no
changes to `replay.ts`, no cwd in template frontmatter.

## What changes in the codebase

`executePlan` in `execute.ts` couples compile→schedule→run to
`ExtensionContext` and `ExtensionAPI`. The CLI can't provide these.

### New function: `runPlan` in `src/core/run-plan.ts`

```typescript
interface RunPlanConfig {
  readonly program: Program;
  readonly actorsByName: ReadonlyMap<ActorId, ValidatedActor>;
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: RunPlanProgress) => void;
  readonly shellPath?: string;
  readonly shellCommandPrefix?: string;
}

interface RunPlanProgress {
  readonly event: RelayEvent;
  readonly state: RelayRunState;
  readonly report: RunReport;
  readonly checkOutput?: ReadonlyMap<StepId, string>;
}

interface RunPlanResult {
  readonly report: RunReport;
  readonly state: RelayRunState;
  readonly artifactStore: ArtifactStore;
  readonly audit: AuditLog;
}

function runPlan(config: RunPlanConfig): Promise<RunPlanResult>
```

Takes a pre-compiled `Program` and validated actors. `onProgress` fires on
every scheduler event with a state snapshot — callers use it for streaming
output (CLI) or TUI updates (extension).

`executePlan` becomes a wrapper: resolve cwd from `plan.cwd`, compile,
review dialog, call `runPlan`, format as `AgentToolResult<RelayDetails>`.

### Headless environment

Uses `createAgentSessionServices` (pi's pattern):

```typescript
const authStorage = AuthStorage.create();
if (cliApiKey) {
  authStorage.setRuntimeApiKey("anthropic", cliApiKey);
}

const services = await createAgentSessionServices({
  cwd, agentDir, authStorage,
  resourceLoaderOptions: {
    noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
  },
});
const { modelRegistry, settingsManager } = services;
```

`ANTHROPIC_API_KEY` picked up automatically by `AuthStorage.getApiKey()`.

### CLI data flow

```
parse args (template file, -e params, options)
  ↓
load template from file path
  ↓
merge params: @file.json + -e flags + parameter defaults
  ↓
instantiateTemplate(template, params) → PlanDraftDoc (with cwd)
  ↓
resolve cwd from plan.cwd (or process.cwd())
  ↓
discover actors (bundled + project)
  ↓
compile plan
  ↓
if --dry-run → print plan summary → exit 0
  ↓
build services via createAgentSessionServices
  ↓
validate actors against model registry
  ↓
runPlan({ program, actorsByName, registry, cwd })
  ↓
format output (json/text/stream-json)
  ↓
exit(code)
```

### `--dry-run`

Parse, substitute, discover actors, compile — then print the compiled plan
and exit. No LLM calls, no service construction, no API key needed.

```
Template: plans/verified-edit.md
CWD: /home/runner/work/myapp

Steps:
  implement (action, actor: worker)
    → done → verify
  verify (command: npm test)
    → success → done
    → failure → failed
  done (terminal: success)
  failed (terminal: failure)

Artifacts:
  change_notes (text, writer: implement)

Actors:
  worker ✓ (bundled, tools: read, edit, write, grep, find, ls, bash)

Plan compiles. Ready to run.
```

## Output

### Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success terminal reached |
| 1    | Failure terminal, incomplete, or aborted |
| 2    | Bad args, missing params, file not found |
| 3    | Compile error, missing actor |
| 4    | Runtime error, no API key |

### JSON output (default when piped)

```typescript
interface CliOutput {
  readonly outcome: "success" | "failure" | "incomplete" | "aborted" | "error";
  readonly exit_code: number;
  readonly duration_ms: number;
  readonly cost_usd: number;
  readonly template: string;
  readonly cwd: string;
  readonly steps: readonly {
    readonly name: string;
    readonly type: "action" | "command" | "files_exist" | "terminal";
    readonly outcome: string;
    readonly attempts: number;
    readonly duration_ms: number;
    readonly route?: string;
    readonly exit_code?: number | null;
    readonly reason?: string;
    readonly cost_usd?: number;
  }[];
  readonly artifacts: Record<string, unknown>;
  readonly report: string;
}
```

### Text output (default in terminal)

Progress to stderr. Markdown report to stdout (`renderRunReportText`).

### Stream JSON (`--output stream-json`)

NDJSON to stdout. One `RelayEvent` per line. Final line is `CliOutput`.

## Error messages

| Scenario | Message | Exit |
|----------|---------|------|
| File not found | `"Template file not found: plans/foo.md"` | 2 |
| Invalid template | Parse error details | 2 |
| Missing param | `"Required parameter 'task' not provided"` | 2 |
| Invalid cwd | Resolved path + reason | 2 |
| Unresolved `{{}}` | Placeholder name + field path | 3 |
| Compile failure | `formatCompileError` + available actors | 3 |
| No models | `"No models available. Set ANTHROPIC_API_KEY."` | 4 |

## File changes

```
New:
  src/core/run-plan.ts         # Extracted engine
  src/cli/main.ts              # One-shot CLI entry point

Modified:
  src/execute.ts               # Resolve plan.cwd, wrapper around runPlan
  src/plan/draft.ts            # PlanDraftSchema gains optional cwd field
  src/templates/types.ts       # TemplateParameter: default replaces required
  src/templates/discovery.ts   # Parse default from frontmatter
  src/templates/substitute.ts  # Apply parameter defaults
  src/pi-relay.ts              # Extract findPackageRoot to shared util
  package.json                 # bin entry

Unchanged:
  src/replay.ts                # cwd flows through PlanDraftDoc naturally
  src/plan/compile.ts          # cwd is not a compilation concern
  src/actors/                  # discovery, validate, sdk-engine
  src/runtime/                 # scheduler, artifacts, audit, events, checks
  src/render/                  # TUI — not used by CLI
```

## Verified

**Auth in CI works out of the box.** `AuthStorage.getApiKey()` checks env
vars via `getEnvApiKey()` from `pi-ai`, which maps `"anthropic"` →
`ANTHROPIC_API_KEY`. No special registration needed.

## Open questions

1. **Binary name.** `relay` is clean but might conflict. Depends on
   distribution strategy.
