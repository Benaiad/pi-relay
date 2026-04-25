# Relay CLI: Implementation Plan

Reference: `architecture/RELAY_CLI.md`

## What already exists

- **Template system**: `templates/discovery.ts` (parse `.md` files),
  `templates/substitute.ts` (parameter substitution on parsed YAML),
  `templates/types.ts` (PlanTemplate, TemplateParameter)
- **Actor system**: `actors/discovery.ts`, `actors/validate.ts`,
  `actors/sdk-engine.ts` (in-process sessions via `createAgentSession`)
- **Compiler**: `plan/compile.ts` (PlanDraftDoc → Program)
- **Scheduler**: `runtime/scheduler.ts` (sequential step executor)
- **Execute pipeline**: `execute.ts` (validates → compiles → reviews → runs)
- **Report**: `runtime/run-report.ts` (`renderRunReportText`)

## How pi does things

Pi's `main.ts` (line 517–612):

1. `AuthStorage.create()` — reads `~/.pi/agent/auth.json` + env vars
2. `createAgentSessionServices({ cwd, agentDir, authStorage, ... })`
   → `{ settingsManager, modelRegistry, resourceLoader, diagnostics }`
3. Resolve model from CLI flags against the registry
4. `createAgentSessionFromServices({ services, sessionManager, model, ... })`
5. Dispatch to mode: `runPrintMode` (single-shot) or `InteractiveMode`

Pi's arg parsing: hand-rolled `parseArgs()` in `cli/args.ts`. A `for` loop
over `process.argv`, returns an `Args` struct with diagnostics. No library.

Pi's auth: `AuthStorage.getApiKey()` checks runtime override → auth.json →
OAuth → `getEnvApiKey()` (maps `"anthropic"` → `ANTHROPIC_API_KEY`). For CLI
`--api-key`, pi calls `authStorage.setRuntimeApiKey(provider, key)`.

## Steps

Each step produces a building, tested increment.

### Step 1: Extract `runPlan` from `execute.ts`

**New file**: `src/core/run-plan.ts`

```typescript
interface RunPlanConfig {
  readonly program: Program;
  readonly actorsByName: ReadonlyMap<ActorId, ValidatedActor>;
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: SchedulerEventHandler;
  readonly onOutput?: (stepId: StepId, text: string) => void;
  readonly shellPath?: string;
  readonly shellCommandPrefix?: string;
}

interface RunPlanResult {
  readonly report: RunReport;
  readonly state: RelayRunState;
  readonly artifactStore: ArtifactStore;
  readonly audit: AuditLog;
}
```

Takes a pre-compiled `Program` + validated actors. Constructs the scheduler,
wires event/output subscriptions, runs, returns the raw result.

**What moves into `runPlan`** (from execute.ts):
- Lines 138–157: `SettingsManager.create`, `AuditLog`, `ArtifactStore`,
  `Scheduler` construction with `createSdkActorEngine`
- Lines 159–194: event subscription, `scheduler.run()`, report building

**What stays in `executePlan`**:
- Lines 49–67: actor validation, compilation (needs `ExtensionContext` for
  `ctx.modelRegistry`, `ctx.model`, `pi.getThinkingLevel()`)
- Lines 84–134: review dialog (needs `ctx.hasUI`, `ctx.ui.select`)
- Lines 159–194: the `onUpdate` callback wiring (needs
  `AgentToolUpdateCallback<RelayDetails>`)
- Return value formatting as `AgentToolResult<RelayDetails>`

**Refactored `executePlan`** calls compile → review → `runPlan` → format.
The `onUpdate` wiring subscribes to the scheduler via `onEvent`/`onOutput`
callbacks passed to `runPlan`.

Wait — `executePlan` currently creates the scheduler and subscribes directly.
With the extraction, it passes callback functions to `runPlan` which
internally subscribes. This means the `emitUpdate` logic in executePlan
(lines 159–174) becomes the `onEvent`/`onOutput` callbacks.

Concretely, `executePlan` passes:

```typescript
const result = await runPlan({
  program,
  actorsByName,
  modelRegistry: ctx.modelRegistry,
  cwd: ctx.cwd,
  signal,
  onEvent: () => emitUpdate(false),
  onOutput: () => emitUpdate(false),
  shellPath: settingsManager.getShellPath(),
  shellCommandPrefix: settingsManager.getShellCommandPrefix(),
});
```

And after `runPlan` returns, it does one final `emitUpdate(true)` and
formats the result.

**But**: the `emitUpdate` function in execute.ts reads `scheduler.getState()`
and `scheduler.getAudit()`. With the extraction, the scheduler is internal
to `runPlan`. The extension can't reach it.

Two options:

**A)** `runPlan` returns intermediate state snapshots via callback:
```typescript
onEvent?: (event: RelayEvent, state: RelayRunState, audit: AuditLog) => void;
```

**B)** `runPlan` exposes the scheduler for direct subscription (leaky).

Option A is cleaner. The callback receives the event plus a snapshot of the
current state. The extension's `emitUpdate` logic uses these instead of
reaching into the scheduler.

Revised callback:

```typescript
interface RunPlanProgress {
  readonly event: RelayEvent;
  readonly state: RelayRunState;
  readonly report: RunReport;
  readonly checkOutput?: ReadonlyMap<StepId, string>;
}

interface RunPlanConfig {
  // ...
  readonly onProgress?: (progress: RunPlanProgress) => void;
}
```

This replaces both `onEvent` and the state-reading pattern. The extension
formats `RunPlanProgress` into its `AgentToolUpdateCallback`. The CLI
formats it into NDJSON or stderr progress.

**Verify**: `npm run build && npm test`. All existing tests pass unchanged.

### Step 2: Parameter defaults

**File: `src/templates/types.ts`**

```typescript
interface TemplateParameter {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;      // kept for backward compat, derived
  readonly default?: string;       // NEW
}
```

Keep `required` as derived: `required = default === undefined`.

**File: `src/templates/discovery.ts`**

In `parseParameters`:

```typescript
const hasDefault = "default" in e && typeof e.default === "string";
const required = hasDefault ? false : e.required !== false;
const defaultValue = hasDefault ? (e.default as string) : undefined;
params.push({
  name: e.name, description: e.description,
  required, default: defaultValue,
});
```

**File: `src/templates/substitute.ts`**

In `instantiateTemplate`, before the missing-params check:

```typescript
const effectiveArgs: Record<string, string> = { ...args };
for (const param of template.parameters) {
  if (param.default !== undefined && !(param.name in effectiveArgs)) {
    effectiveArgs[param.name] = param.default;
  }
}
```

Use `effectiveArgs` instead of `args` for the rest of the function.

**File: `src/replay.ts`**

Update `buildReplayToolDescription` param signature to show defaults:

```typescript
const paramSig = t.parameters.map((p) => {
  if (p.default !== undefined) return `${p.name}="${p.default}"`;
  return p.required ? p.name : `${p.name}?`;
}).join(", ");
```

**Tests**: Extend `substitute.test.ts`:
- Param with default, not provided → uses default
- Param with default, provided → uses provided value
- Param without default, not provided → error

**Verify**: `npm run build && npm test`

### Step 3: Template `cwd`

**File: `src/templates/types.ts`**

Add `cwd?: string` to `PlanTemplate`.

**File: `src/templates/discovery.ts`**

In `parseTemplateFile`:

```typescript
const cwd = typeof frontmatter.cwd === "string" ? frontmatter.cwd : undefined;
return { name, description, parameters, cwd, rawPlan, source, filePath };
```

**File: `src/templates/substitute.ts`**

Add `cwd?: string` to `TemplateInstantiation`.

Resolve cwd after substitution using the same placeholder regex:

```typescript
const resolvedCwd = template.cwd
  ? template.cwd.replace(PLACEHOLDER_RE, (match, name: string) => {
      const value = substitutionMap.get(name);
      return value !== undefined ? value : match;
    })
  : undefined;
```

Check for residual placeholders in cwd:

```typescript
if (resolvedCwd) {
  PLACEHOLDER_RE.lastIndex = 0;
  if (PLACEHOLDER_RE.test(resolvedCwd)) {
    return err({ kind: "unresolved_placeholder", ... });
  }
}
```

Return `cwd: resolvedCwd` in the result.

**File: `src/replay.ts`**

After instantiation, check `instantiation.value.cwd` and resolve it:

```typescript
const effectiveCwd = instantiation.value.cwd
  ? resolve(ctx.cwd, instantiation.value.cwd)
  : ctx.cwd;
```

Pass `effectiveCwd` instead of `ctx.cwd` to `executePlan`. This makes
template cwd work in the extension too.

**Tests**: Test cwd substitution, residual placeholder detection.

**Verify**: `npm run build && npm test`

### Step 4: Extract `findPackageRoot` to shared util

**Goal**: Both `pi-relay.ts` (extension) and `cli/main.ts` need
`findPackageRoot`. Currently it's a private function in `pi-relay.ts`.

**New file**: `src/utils/package-root.ts`

Move `findPackageRoot` from `pi-relay.ts` into this module. Export it.
Update `pi-relay.ts` to import from the new location.

**Verify**: `npm run build && npm test`

### Step 5: CLI entry point

**New file**: `src/cli/args.ts`

Hand-rolled arg parsing (matching pi's pattern):

```typescript
interface CliArgs {
  readonly templatePath: string;
  readonly params: Record<string, string>;
  readonly paramsFile?: string;
  readonly output: "json" | "text" | "stream-json";
  readonly timeout: number;
  readonly maxCost?: number;
  readonly model?: string;
  readonly thinking: ThinkingLevel;
  readonly apiKey?: string;
  readonly dryRun: boolean;
  readonly help: boolean;
  readonly diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}
```

Parse `-e key=value`, `-e @file.json`, `--dry-run`, `--output`, `--timeout`,
`--max-cost`, `--model`, `--thinking`, `--api-key`, `--help`. First non-flag
argument is the template path.

**New file**: `src/cli/output.ts`

Three formatters:

- `formatJsonOutput(result, metadata)` → `CliOutput` JSON string
- `formatTextProgress(progress)` → stderr line
- `formatStreamJsonEvent(progress)` → NDJSON line

**New file**: `src/cli/main.ts`

Main flow:

```typescript
async function main(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);
  if (parsed.help) { printHelp(); return; }
  if (parsed.diagnostics.some(d => d.type === "error")) {
    for (const d of parsed.diagnostics) console.error(d.message);
    process.exitCode = 2; return;
  }

  // Load template from file (export parseTemplateFile from discovery.ts)
  const warnings: TemplateWarning[] = [];
  const template = parseTemplateFile(resolve(parsed.templatePath), "project", warnings);
  if (!template) { /* stderr + exit 2 */ }

  // Merge params: @file + -e flags
  let params = parsed.paramsFile
    ? JSON.parse(readFileSync(parsed.paramsFile, "utf-8"))
    : {};
  params = { ...params, ...parsed.params };

  // Instantiate (applies defaults, substitutes cwd)
  const instantiation = instantiateTemplate(template, params);
  if (!instantiation.ok) { /* stderr + exit 2 */ }

  // Resolve cwd
  const cwd = instantiation.value.cwd
    ? resolve(process.cwd(), instantiation.value.cwd)
    : process.cwd();
  // Validate cwd exists and is a directory

  // Discover actors (bundled + user + project)
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const bundledActorsDir = packageRoot ? join(packageRoot, "actors") : undefined;
  const actorDiscovery = discoverActors(cwd, "both", { bundledDir: bundledActorsDir });

  // Compile
  const registry = actorRegistryFromDiscovery(actorDiscovery);
  const compileResult = compile(instantiation.value.plan, registry);
  if (!compileResult.ok) { /* stderr + exit 3 */ }

  // Dry run: print plan summary, exit
  if (parsed.dryRun) {
    printPlanSummary(compileResult.value, cwd, parsed.templatePath);
    return;
  }

  // Build services (pi pattern)
  const authStorage = AuthStorage.create();
  if (parsed.apiKey) {
    authStorage.setRuntimeApiKey("anthropic", parsed.apiKey);
  }
  const services = await createAgentSessionServices({
    cwd, agentDir: getAgentDir(), authStorage,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
    },
  });
  const { modelRegistry, settingsManager } = services;

  // Resolve model
  const available = modelRegistry.getAvailable();
  if (available.length === 0) {
    console.error("No models available. Set ANTHROPIC_API_KEY.");
    process.exitCode = 4; return;
  }
  const defaultModel = parsed.model
    ? findModel(parsed.model, modelRegistry) ?? available[0]
    : available[0];

  // Validate actors
  const validatedActors = validateActors(
    actorDiscovery.actors, modelRegistry, defaultModel,
    parsed.thinking, (msg) => console.error(`Warning: ${msg}`),
  );
  const actorsByName = new Map(validatedActors.map(a => [ActorId(a.name), a]));

  // Setup abort: timeout, cost, signals
  const controller = new AbortController();
  let abortReason: "timeout" | "cost" | "signal" | undefined;

  const timeoutId = setTimeout(() => {
    abortReason = "timeout";
    controller.abort();
  }, parsed.timeout * 1000);

  process.on("SIGINT", () => {
    if (abortReason === "signal") process.exit(130); // second SIGINT = force
    abortReason = "signal";
    controller.abort();
  });
  process.on("SIGTERM", () => { abortReason = "signal"; controller.abort(); });

  let accumulatedCost = 0;

  // Run
  const result = await runPlan({
    program: compileResult.value,
    actorsByName,
    modelRegistry,
    cwd,
    signal: controller.signal,
    onProgress: (progress) => {
      // Cost tracking
      if (parsed.maxCost && "usage" in progress.event && progress.event.usage) {
        accumulatedCost += progress.event.usage.cost;
        if (accumulatedCost > parsed.maxCost) {
          abortReason = "cost";
          controller.abort();
        }
      }
      // Output streaming
      if (parsed.output === "stream-json") {
        writeStdout(formatStreamJsonEvent(progress));
      } else if (parsed.output === "text") {
        writeStderr(formatTextProgress(progress));
      }
    },
    shellPath: settingsManager.getShellPath(),
    shellCommandPrefix: settingsManager.getShellCommandPrefix(),
  });

  clearTimeout(timeoutId);

  // Output
  if (parsed.output === "json" || parsed.output === "stream-json") {
    const output = buildCliOutput(result, {
      template: parsed.templatePath, cwd, accumulatedCost, abortReason,
    });
    writeStdout(JSON.stringify(output));
  } else {
    writeStdout(renderRunReportText(result.report, result.artifactStore));
  }

  // Exit code
  if (result.report.outcome === "success") { process.exitCode = 0; }
  else if (abortReason === "timeout") { process.exitCode = 124; }
  else if (abortReason === "cost") { process.exitCode = 4; }
  else if (abortReason === "signal") { process.exitCode = 130; }
  else { process.exitCode = 1; }
}

main(process.argv.slice(2));
```

**Export `parseTemplateFile`** from `src/templates/discovery.ts`: change
`const parseTemplateFile` to `export const parseTemplateFile`.

**Verify**: `npm run build`. Manual test with `--dry-run`.

### Step 6: Package configuration

**File: `package.json`**

Add bin entry:

```json
{
  "bin": {
    "relay": "./dist/cli/main.js"
  }
}
```

Ensure `src/cli/main.ts` starts with `#!/usr/bin/env node`.

The `findPackageRoot` utility (from Step 4) locates bundled `actors/` and
`plans/` dirs relative to the CLI binary — same walk from `import.meta.url`
that the extension uses.

**Verify**: `npm run build && npm link && relay plans/verified-edit.md --help`

### Step 7: Tests

**File: `src/core/run-plan.test.ts`**

Test `runPlan` with a fake `ActorEngine`:
- Success path: action → command → terminal(success)
- Failure path: action → command(fail) → terminal(failure)
- Abort: signal fires mid-run → partial report
- Progress callback receives events

**File: `src/cli/args.test.ts`**

- `-e key=value` parsing
- `-e @file.json` detection
- `--dry-run` flag
- Missing template path → error
- Unknown flags → error

**File: `src/templates/substitute.test.ts`** (extend)

- Parameter defaults (new)
- Template cwd substitution (new)
- Cwd with residual placeholder → error (new)

**Verify**: `npm test`

## Dependency graph

```
Step 1 (runPlan)
  ↓
Step 2 (defaults) ← independent of 1
  ↓
Step 3 (cwd)      ← depends on 2 (uses defaults for cwd param)
  ↓
Step 4 (findPackageRoot) ← independent
  ↓
Step 5 (CLI)      ← depends on 1, 2, 3, 4
  ↓
Step 6 (package)  ← depends on 5
  ↓
Step 7 (tests)    ← depends on all
```

Steps 1, 2, and 4 are independent and can be done in parallel.

## Risks

1. **`createAgentSessionServices` loads resources.** Even with
   `noExtensions: true`, it creates a `DefaultResourceLoader` and calls
   `.reload()`. Verified: it skips discovery when `noExtensions` is set but
   still returns a valid loader. Startup cost is minimal.

2. **`SdkActorEngine` creates its own `SettingsManager` per step.** The CLI
   creates services once for the model registry + settings. The per-step
   settings manager reads from the same files — no conflict.

3. **`parseTemplateFile` is module-private.** Step 5 needs it exported.
   Simple change: `const` → `export const` in discovery.ts.

4. **`findModel` in `actors/validate.ts` is already exported.** The CLI
   reuses it for `--model` resolution.

5. **Actor discovery scope.** The extension uses `"user"` (no project
   actors). The CLI uses `"both"` (includes project actors). This is
   intentional — CI runs are trusted, no review dialog.

6. **Relay config filtering.** The extension uses `loadRelayConfig()` to
   filter disabled actors/plans. The CLI skips this — in CI the template
   names its actors explicitly, and the user's desktop deny-list should not
   affect headless runs.
