# Relay CLI: Implementation Plan

Reference: `architecture/RELAY_CLI.md`

## What already exists

- **Template system**: `templates/discovery.ts`, `templates/substitute.ts`,
  `templates/types.ts`
- **Actor system**: `actors/discovery.ts`, `actors/validate.ts`,
  `actors/sdk-engine.ts`
- **Compiler**: `plan/compile.ts` (PlanDraftDoc → Program)
- **Scheduler**: `runtime/scheduler.ts`
- **Execute pipeline**: `execute.ts` (validates → compiles → reviews → runs)
- **Report**: `runtime/run-report.ts` (`renderRunReportText`)

## How pi does things

Pi's `main.ts`:

1. `AuthStorage.create()` — reads auth.json + env vars
2. `createAgentSessionServices({ cwd, agentDir, authStorage, ... })`
   → `{ settingsManager, modelRegistry, resourceLoader }`
3. Resolve model from CLI flags
4. Dispatch to mode: `runPrintMode` (single-shot) or `InteractiveMode`

Arg parsing: hand-rolled loop over `process.argv`, returns struct with
diagnostics. Auth: `authStorage.setRuntimeApiKey()` for `--api-key`.

## Steps

### Step 1: Extract `runPlan` from `execute.ts`

**New file**: `src/core/run-plan.ts`

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
```

**What moves into `runPlan`** (from execute.ts):
- Scheduler construction with `createSdkActorEngine` (lines 138–157)
- Event subscription, `scheduler.run()`, report building (lines 159–194)

`runPlan` fires `onProgress` on every scheduler event with a snapshot of
`{ event, state, report, checkOutput }`. The caller decides how to present
it (TUI updates for extension, NDJSON for CLI, throttled or not).

**What stays in `executePlan`**:
- Actor validation, compilation (needs `ExtensionContext`)
- cwd resolution from `plan.cwd` (new, see Step 3)
- Review dialog (needs `ctx.hasUI`, `ctx.ui.select`)
- `AgentToolResult<RelayDetails>` formatting
- `onUpdate` throttling (100ms debounce, driven by `onProgress` callback)

**Verify**: `npm run build && npm test` — behavior unchanged.

### Step 2: Parameter defaults

**`src/templates/types.ts`**: Add `default?: string` to `TemplateParameter`.
Keep `required` as derived field (`required = default === undefined`).

**`src/templates/discovery.ts`**: In `parseParameters`, parse `default` from
frontmatter entry. Support both old (`required: true/false`) and new
(`default: "value"`) forms.

```typescript
const hasDefault = "default" in e && typeof e.default === "string";
const required = hasDefault ? false : e.required !== false;
const defaultValue = hasDefault ? (e.default as string) : undefined;
```

**`src/templates/substitute.ts`**: Before missing-params check, apply
defaults:

```typescript
const effectiveArgs: Record<string, string> = { ...args };
for (const param of template.parameters) {
  if (param.default !== undefined && !(param.name in effectiveArgs)) {
    effectiveArgs[param.name] = param.default;
  }
}
```

**`src/replay.ts`**: Update `buildReplayToolDescription` to show defaults in
parameter signature.

**Tests**: Extend `substitute.test.ts` — default applied, default overridden,
no default + missing → error.

**Verify**: `npm run build && npm test`

### Step 3: Plan `cwd`

**`src/plan/draft.ts`**: Add optional `cwd` to `PlanDraftSchema`:

```typescript
cwd: Type.Optional(
  Type.String({
    description: "Working directory for all steps. Resolved relative to " +
      "the caller's cwd. Defaults to the caller's cwd when omitted.",
  }),
),
```

This is the only schema change. The compiler doesn't need to know about
`cwd` — it's not a compilation concern. The scheduler already receives
`cwd` as a constructor argument.

**`src/execute.ts`**: After compilation, resolve cwd:

```typescript
const effectiveCwd = plan.cwd
  ? resolve(ctx.cwd, plan.cwd)
  : ctx.cwd;
```

Pass `effectiveCwd` to `runPlan` instead of `ctx.cwd`. Validate it exists
and is a directory.

No changes to `replay.ts`. The template's `cwd: "{{cwd}}"` is in the plan
body, gets substituted by `instantiateTemplate` along with everything else,
and arrives in the `PlanDraftDoc` as `plan.cwd`. `executePlan` picks it up
from there. One code path.

No changes to `PlanTemplate` or `TemplateInstantiation`. The cwd lives in
the plan, not in template metadata.

**Tests**: Template with `cwd: "{{cwd}}"` parameter + default, ad-hoc plan
with `cwd: "subdir"`.

**Verify**: `npm run build && npm test`

### Step 4: Extract `findPackageRoot`

Move `findPackageRoot` from `pi-relay.ts` to `src/utils/package-root.ts`.
Export it. Update `pi-relay.ts` to import from new location.

**Verify**: `npm run build && npm test`

### Step 5: CLI entry point

**`src/cli/args.ts`**: Hand-rolled arg parsing.

```typescript
interface CliArgs {
  readonly templatePath: string;
  readonly params: Record<string, string>;
  readonly paramsFile?: string;
  readonly model?: string;          // provider/model-name format, fallback for actors
  readonly thinking?: ThinkingLevel; // fallback for actors, undefined = "off"
  readonly apiKey?: string;
  readonly actorsDir?: string;      // override actor discovery directory
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}
```

Parse `-e key=value`, `-e @file.json`, `--dry-run`, `--model`, `--thinking`,
`--api-key`, `--actors-dir`, `--help`. First non-flag arg is template path.

**`src/cli/main.ts`**:

```typescript
async function main(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  if (parsed.help) { printHelp(); return; }

  // Load template from file
  const template = parseTemplateFile(resolve(parsed.templatePath), "project", warnings);

  // Merge params: @file + -e flags
  const params = { ...(paramsFromFile ?? {}), ...parsed.params };

  // Instantiate (applies defaults, substitutes plan body including cwd)
  const instantiation = instantiateTemplate(template, params);
  const plan = instantiation.value.plan;

  // Resolve cwd from plan
  const cwd = plan.cwd ? resolve(process.cwd(), plan.cwd) : process.cwd();

  // Discover actors
  // --actors-dir: load from that directory only (no bundled/project discovery)
  // default: bundled (from package) + project (.pi/pi-relay/actors/)
  const actorDiscovery = parsed.actorsDir
    ? { actors: loadActorsFromDir(resolve(parsed.actorsDir), "project"), projectDir: null, userDir: "" }
    : discoverActors(cwd, "both", { bundledDir });

  // Compile
  const compileResult = compile(plan, actorRegistryFromDiscovery(actorDiscovery));

  // Dry run
  if (parsed.dryRun) { printPlanSummary(...); return; }

  // Build services (pi pattern)
  const authStorage = AuthStorage.create();
  if (parsed.apiKey) authStorage.setRuntimeApiKey("anthropic", parsed.apiKey);
  const services = await createAgentSessionServices({
    cwd, agentDir: getAgentDir(), authStorage,
    resourceLoaderOptions: { noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });

  // Resolve default model from --model flag (if provided)
  const defaultModel = parsed.model
    ? findModel(parsed.model, services.modelRegistry)
    : undefined;
  if (parsed.model && !defaultModel) {
    console.error(`Model '${parsed.model}' not found. Check provider/name format.`);
    process.exitCode = 3; return;
  }

  // Validate actors (actor model > --model > undefined, actor thinking > --thinking > "off")
  const defaultThinking = parsed.thinking ?? "off";
  const validatedActors = validateActors(
    actorDiscovery.actors, services.modelRegistry, defaultModel,
    defaultThinking, (msg) => console.error(`Warning: ${msg}`),
  );

  // Fail early if any actor has no resolved model
  for (const actor of validatedActors) {
    if (!actor.resolvedModel) {
      console.error(
        `Actor '${actor.name}' has no model configured.\n` +
        `Use --model <provider/name> or add 'model:' to the actor file.`
      );
      process.exitCode = 3; return;
    }
  }

  // Run
  const result = await runPlan({
    program: compileResult.value, actorsByName,
    modelRegistry: services.modelRegistry, cwd,
    onProgress: (progress) => { /* progress to stderr */ },
    shellPath: services.settingsManager.getShellPath(),
    shellCommandPrefix: services.settingsManager.getShellCommandPrefix(),
  });

  // Output + exit
}

main(process.argv.slice(2));
```

**Export `parseTemplateFile`** from `src/templates/discovery.ts`.

**Verify**: `npm run build`. Manual test with `--dry-run`.

### Step 6: Package configuration

Add to `package.json`:

```json
{ "bin": { "relay": "./dist/cli/main.js" } }
```

`#!/usr/bin/env node` at top of `src/cli/main.ts`.

**Verify**: `npm run build && npm link && relay plans/verified-edit.md --help`

### Step 7: Tests

- `src/core/run-plan.test.ts` — fake actor engine, success/failure/abort,
  onProgress fires
- `src/cli/args.test.ts` — `-e` parsing, `@file`, `--dry-run`, errors
- Extend `src/templates/substitute.test.ts` — parameter defaults
- Plan cwd: template with `cwd: "{{cwd}}"` + default, ad-hoc with `cwd`

**Verify**: `npm test`

## Dependency graph

```
Step 1 (runPlan)     ← independent
Step 2 (defaults)    ← independent
Step 3 (plan cwd)    ← independent (only touches draft.ts + execute.ts)
Step 4 (packageRoot) ← independent
Step 5 (CLI)         ← depends on 1, 2, 3, 4
Step 6 (package)     ← depends on 5
Step 7 (tests)       ← depends on all
```

Steps 1–4 are all independent.

## Risks

1. **`parseTemplateFile` and `loadActorsFromDir` are module-private.**
   Change `const` to `export const` in their respective discovery.ts files.

2. **Adding `cwd` to `PlanDraftSchema` changes the tool description.** The
   model sees a new optional field. This is intentional — the model can set
   cwd on ad-hoc plans.

3. **Existing plans don't have `cwd`.** The field is optional and defaults
   to the caller's cwd. No migration needed.

4. **`findModel` in `actors/validate.ts` is already exported.** CLI reuses
   it for `--model` resolution.
