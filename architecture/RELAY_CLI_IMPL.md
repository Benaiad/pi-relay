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
- Lines 138–157: scheduler construction with `createSdkActorEngine`
- Lines 159–194: event subscription, `scheduler.run()`, report building

**What stays in `executePlan`**:
- Actor validation, compilation (needs `ExtensionContext`)
- Review dialog (needs `ctx.hasUI`, `ctx.ui.select`)
- `AgentToolResult<RelayDetails>` formatting

`executePlan` passes an `onProgress` callback to `runPlan`. The callback
receives `{ event, state, report, checkOutput }` on every scheduler event —
the same data `emitUpdate` currently reads from the scheduler directly. This
replaces the pattern where `executePlan` subscribes to the scheduler and
calls `scheduler.getState()` / `scheduler.getAudit()`.

**Verify**: `npm run build && npm test` — behavior unchanged.

### Step 2: Parameter defaults

**`src/templates/types.ts`**: Add `default?: string` to `TemplateParameter`.
Keep `required` as derived field (`required = default === undefined`).

**`src/templates/discovery.ts`**: In `parseParameters`, parse `default` from
frontmatter entry. Support both old (`required: true/false`) and new
(`default: "value"`) forms.

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

### Step 3: Template `cwd`

**`src/templates/types.ts`**: Add `cwd?: string` to `PlanTemplate`.

**`src/templates/discovery.ts`**: Extract `cwd` from frontmatter in
`parseTemplateFile`.

**`src/templates/substitute.ts`**: Add `cwd?: string` to
`TemplateInstantiation`. Substitute placeholders in cwd using the same
args map:

```typescript
const resolvedCwd = template.cwd
  ? template.cwd.replace(PLACEHOLDER_RE, (match, name: string) =>
      substitutionMap.get(name) ?? match)
  : undefined;
```

Check for residual placeholders in resolved cwd.

**`src/replay.ts`**: After instantiation, resolve `instantiation.value.cwd`
relative to `ctx.cwd` and pass the effective cwd through to `executePlan`.

**Tests**: cwd substitution, residual placeholder → error.

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
  readonly output: "json" | "text" | "stream-json";
  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly apiKey?: string;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}
```

Parse `-e key=value`, `-e @file.json`, `--dry-run`, `--output`, `--model`,
`--thinking`, `--api-key`, `--help`. First non-flag arg is template path.

**`src/cli/output.ts`**: Formatters for json, text, stream-json output modes.

**`src/cli/main.ts`**:

```typescript
async function main(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  if (parsed.help) { printHelp(); return; }
  // ... diagnostics check ...

  // Load template from file
  const template = parseTemplateFile(resolve(parsed.templatePath), "project", warnings);

  // Merge params: @file + -e flags
  const params = { ...(paramsFromFile ?? {}), ...parsed.params };

  // Instantiate (applies defaults, substitutes cwd)
  const instantiation = instantiateTemplate(template, params);

  // Resolve cwd
  const cwd = instantiation.value.cwd
    ? resolve(process.cwd(), instantiation.value.cwd)
    : process.cwd();

  // Discover actors (bundled + project)
  const packageRoot = findPackageRoot(...);
  const actorDiscovery = discoverActors(cwd, "both", { bundledDir });

  // Compile
  const compileResult = compile(instantiation.value.plan, registry);

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

  // Validate actors, resolve model
  const validatedActors = validateActors(...);

  // Run
  const result = await runPlan({
    program, actorsByName, modelRegistry: services.modelRegistry, cwd,
    onProgress: (progress) => { /* stream output */ },
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

- `src/core/run-plan.test.ts` — fake actor engine, success/failure/abort
- `src/cli/args.test.ts` — `-e` parsing, `@file`, `--dry-run`, errors
- Extend `src/templates/substitute.test.ts` — defaults, cwd

**Verify**: `npm test`

## Dependency graph

```
Step 1 (runPlan)     ← independent
Step 2 (defaults)    ← independent
Step 3 (cwd)         ← depends on 2
Step 4 (packageRoot) ← independent
Step 5 (CLI)         ← depends on 1, 2, 3, 4
Step 6 (package)     ← depends on 5
Step 7 (tests)       ← depends on all
```

## Risks

1. **`parseTemplateFile` is module-private.** Change `const` to
   `export const` in discovery.ts.

2. **`findModel` in `actors/validate.ts` is already exported.** CLI reuses
   it for `--model` resolution.

3. **Actor discovery scope.** Extension uses `"user"`, CLI uses `"both"`.
   Intentional: CLI includes project actors, no review dialog needed.
