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
-e key=value          Set a template parameter
-e @file.json         Load parameters from JSON file
--dry-run             Validate and show the compiled plan, then exit. No LLM calls.
--cwd <path>          Override working directory
--output <mode>       json (default if !TTY) | text (default if TTY) | stream-json
--timeout <seconds>   Process-level timeout (default: 3600)
--max-cost <usd>      Abort if LLM cost exceeds this
--model <name>        Default model for actors (e.g. claude-sonnet-4-5)
--thinking <level>    Default thinking level (default: medium)
```

Every flag has a `RELAY_` env var: `RELAY_CWD`, `RELAY_TIMEOUT`,
`RELAY_MAX_COST`, `RELAY_MODEL`, `RELAY_THINKING`, `RELAY_OUTPUT_MODE`.
Plus `ANTHROPIC_API_KEY` for auth. Precedence: flag > env var > default.

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
  - name: lint
    description: Lint command.
    default: "npm run lint"
```

```bash
# Only task is required
relay plans/verified-edit.md -e task="Fix the bug"
# verify defaults to "npm test", lint defaults to "npm run lint"
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

## Template `cwd`

```yaml
---
name: api-verified-edit
description: Edit the API package and verify.
cwd: packages/api
parameters:
  - name: task
---
```

Optional. Relative to the template file's parent directory, or to project
root (directory containing `.pi/`). Supports `{{placeholder}}`:

```yaml
cwd: "{{package_path}}"
```

Absolute paths are a validation error.

`PlanTemplate` gains `readonly cwd?: string`. `TemplateInstantiation` gains
`readonly cwd?: string` (after substitution).

### Resolution

```
if --cwd flag    → resolve(flag)                  // relative to shell cwd
if template cwd  → join(projectRoot, templateCwd) // relative to project root
else             → process.cwd()
```

Flag overrides template.

## What changes in the codebase

`executePlan` in `execute.ts` couples compile→schedule→run to
`ExtensionContext` and `ExtensionAPI`. The CLI can't provide these.

`executePlan` does six things:

1. Validate actors against the model registry
2. Compile the plan
3. Show an interactive review dialog *(pi-only)*
4. Construct the scheduler with an actor engine
5. Run the scheduler
6. Format the result as `AgentToolResult<RelayDetails>` *(pi-only)*

Steps 1–2 and 4–5 are the engine. Steps 3 and 6 are extension glue.

### New function: `runPlan` in `src/core/run-plan.ts`

```typescript
interface RunPlanConfig {
  readonly plan: PlanDraftDoc;
  readonly actorDiscovery: ActorDiscovery;
  readonly modelRegistry: ModelRegistry;
  readonly defaultModel: Model<Api> | undefined;
  readonly defaultThinkingLevel: ThinkingLevel;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onWarning?: (message: string) => void;
  readonly shellPath?: string;
  readonly shellCommandPrefix?: string;
}

interface RunPlanResult {
  readonly report: RunReport;
  readonly state: RelayRunState;
  readonly artifactStore: ArtifactStore;
  readonly audit: AuditLog;
}

function runPlan(config: RunPlanConfig): Promise<RunPlanResult>
```

Internally:

```
validateActors(actors, modelRegistry, defaultModel, thinkingLevel, onWarning)
  → actorsByName: Map<ActorId, ValidatedActor>

compile(plan, actorRegistryFromDiscovery(discovery))
  → Program (or bail)

new Scheduler({
  program,
  actorEngine: createSdkActorEngine({ modelRegistry }),
  actorsByName, cwd, signal,
  audit: new AuditLog(),
  artifactStore: new ArtifactStore(program, clock),
  shellPath, shellCommandPrefix,
})

scheduler.run() → RunReport
```

`SdkActorEngine` constructs everything per action step internally. The only
external input is `modelRegistry`.

`executePlan` becomes a wrapper: extract values from context, show review
dialog, call `runPlan`, format as `AgentToolResult<RelayDetails>`.

### Headless environment

`AuthStorage` already reads `ANTHROPIC_API_KEY` from the environment — no
special registration needed. The auth priority chain in pi's SDK is:
runtime override (`setRuntimeApiKey`) → auth.json → OAuth → env var →
fallback. In CI, the env var path handles it.

```typescript
const authStorage = AuthStorage.create();

// --api-key flag: inject as runtime override (same mechanism pi uses for its --api-key)
if (cliApiKey) {
  authStorage.setRuntimeApiKey("anthropic", cliApiKey);
}

const registry = ModelRegistry.create(authStorage);
```

`ModelRegistry.getAvailable()` returns models whose providers have auth
configured. With `ANTHROPIC_API_KEY` set, anthropic models are available
automatically.

Default model: `--model` flag or first available. Actors with `model:` in
their frontmatter override this.

### CLI entry point: `src/cli/main.ts`

```
parse args (template file, -e params, options)
  ↓
load template from file path
  ↓
merge params: @file.json + -e flags + parameter defaults
  ↓
instantiateTemplate(template, params) → plan + cwd
  ↓
discover actors (bundled + user + project)
  ↓
resolve cwd (--cwd > template cwd > process.cwd())
  ↓
compile plan (validate structure, resolve actors, build program)
  ↓
if --dry-run → print plan summary → exit 0
  ↓
build ModelRegistry from ANTHROPIC_API_KEY
  ↓
runPlan({ plan, actors, registry, model, cwd, signal })
  ↓
format output (json/text/stream-json)
  ↓
exit(code)
```

### `--dry-run`

Runs the full validation pipeline — parse, substitute, discover actors,
resolve cwd, compile — then prints the compiled plan and exits. No LLM
calls, no `ModelRegistry` construction, no API key needed.

```bash
relay plans/verified-edit.md -e task="Fix the bug" -e verify="npm test" --dry-run
```

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

Exit 0 if valid. Same exit 2/3 codes if params are wrong or compilation
fails. Useful in CI to catch config errors before the expensive step:

```yaml
# GitHub Actions
- run: relay plans/verified-edit.md -e task="..." -e verify="..." --dry-run
- run: relay plans/verified-edit.md -e task="..." -e verify="..."
```

## Output

### Exit codes

| Code | Meaning |
|------|---------|
| 0    | Success terminal reached |
| 1    | Failure terminal or incomplete |
| 2    | Bad args, missing params, file not found |
| 3    | Compile error, missing actor |
| 4    | Runtime error, no API key |
| 124  | Timeout |

### JSON output (default when piped)

```typescript
interface CliOutput {
  readonly outcome: "success" | "failure" | "incomplete" | "aborted" | "timeout" | "error";
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

## Timeout and cost

**Process timeout** (`--timeout`): `setTimeout` → `abort()`. Exit 124.

**Cost cap** (`--max-cost`): subscribe to scheduler events, sum `usage.cost`,
abort when exceeded. Exit 4.

Both use the existing `AbortSignal` path. No scheduler changes.

## Signals

SIGINT → abort → exit 130. SIGTERM → abort → exit 143.

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
  src/execute.ts               # Wrapper around runPlan + review dialog
  src/templates/types.ts       # TemplateParameter: default replaces required
                               # PlanTemplate: gains cwd?: string
  src/templates/discovery.ts   # Extract cwd + default from frontmatter
  src/templates/substitute.ts  # Apply defaults, cwd in TemplateInstantiation
  package.json                 # bin entry

Unchanged:
  src/plan/                    # compile, draft, types, program, ids
  src/actors/                  # discovery, validate, sdk-engine
  src/runtime/                 # scheduler, artifacts, audit, events, checks
  src/render/                  # TUI — not used by CLI
  src/pi-relay.ts              # Extension entry
  src/replay.ts                # Tool registration
```

## Verified

**Auth in CI works out of the box.** `AuthStorage.getApiKey()` checks env
vars via `getEnvApiKey()` from `pi-ai`, which maps `"anthropic"` →
`ANTHROPIC_API_KEY`. `ModelRegistry.getAvailable()` uses
`AuthStorage.hasAuth()` which also checks env vars. No special registration
needed — just set `ANTHROPIC_API_KEY` in CI.

For an explicit `--api-key` flag, use `authStorage.setRuntimeApiKey(provider,
key)` — same mechanism pi's own `--api-key` uses (main.ts line 578).

## Open questions

1. **Binary name.** `relay` is clean but might conflict. Depends on
   distribution strategy.

2. **Actor discovery in CI.** Actors are discovered from bundled dirs (ship
   with the package) + user/project dirs. In CI, bundled actors are found
   via the installed package. Project actors come from `.pi/pi-relay/actors/`
   in the repo. This works without changes.
