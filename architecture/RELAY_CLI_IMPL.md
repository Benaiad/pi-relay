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

Pi's `main.ts` (line 517–612) follows this pattern:

1. `AuthStorage.create()` — reads `~/.pi/agent/auth.json` + env vars
2. `createAgentSessionServices({ cwd, agentDir, authStorage, ... })`
   → returns `{ settingsManager, modelRegistry, resourceLoader, diagnostics }`
3. Resolve model from CLI flags against the registry
4. `createAgentSessionFromServices({ services, sessionManager, model, ... })`
5. Dispatch to mode: `runPrintMode` (single-shot) or `InteractiveMode`

The CLI should use `createAgentSessionServices` to construct the service
layer — not build ModelRegistry manually. This gives us auth storage, model
registry with models.json support, and settings management for free.

Pi's arg parsing is hand-rolled (`cli/args.ts`): a `for` loop over
`process.argv`, returns an `Args` struct with diagnostics. No library.

Pi's `AuthStorage.getApiKey()` checks: runtime override → auth.json → OAuth
→ `getEnvApiKey()` (which maps `"anthropic"` → `ANTHROPIC_API_KEY`). For
CLI `--api-key`, pi calls `authStorage.setRuntimeApiKey(provider, key)`.

## Steps

Each step produces a building, tested increment.

### Step 1: Extract `runPlan` from `execute.ts`

**Goal**: Separate the engine (validate → compile → schedule → run) from the
extension glue (review dialog, `AgentToolResult` formatting).

**New file**: `src/core/run-plan.ts`

```typescript
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";

export interface RunPlanConfig {
  readonly plan: PlanDraftDoc;
  readonly actorDiscovery: ActorDiscovery;
  readonly modelRegistry: ModelRegistry;
  readonly defaultModel: Model<Api> | undefined;
  readonly defaultThinkingLevel: ThinkingLevel;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onWarning?: (message: string) => void;
  readonly onEvent?: SchedulerEventHandler;
  readonly shellPath?: string;
  readonly shellCommandPrefix?: string;
}

export interface RunPlanResult {
  readonly report: RunReport;
  readonly state: RelayRunState;
  readonly artifactStore: ArtifactStore;
  readonly audit: AuditLog;
}
```

**Extract from `executePlan`** (execute.ts lines 46–195):

Move lines 49–67 (actor validation, compilation) and lines 138–194
(scheduler construction, event wiring, `scheduler.run()`) into `runPlan`.

Leave in `executePlan`: the review dialog (lines 84–134), the `onUpdate`
callback wiring, and the `AgentToolResult<RelayDetails>` formatting.

`executePlan` becomes:

```typescript
export const executePlan = async (input: ExecuteInput): Promise<AgentToolResult<RelayDetails>> => {
  const { plan, discovery, signal, onUpdate, ctx, pi, toolName } = input;

  // Compile first (needed for review dialog)
  const registry = actorRegistryFromDiscovery(discovery);
  const compileResult = compile(plan, registry);
  if (!compileResult.ok) { /* ... same error formatting ... */ }

  // Review dialog (extension-only)
  if (ctx.hasUI) { /* ... same dialog logic ... */ }

  const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());

  const result = await runPlan({
    plan,
    actorDiscovery: discovery,
    modelRegistry: ctx.modelRegistry,
    defaultModel: ctx.model,
    defaultThinkingLevel: pi.getThinkingLevel(),
    cwd: ctx.cwd,
    signal,
    onWarning: (msg) => ctx.ui.notify(msg, "warning"),
    shellPath: settingsManager.getShellPath(),
    shellCommandPrefix: settingsManager.getShellCommandPrefix(),
  });

  /* ... format result as AgentToolResult<RelayDetails> using onUpdate ... */
};
```

Wait — the review dialog needs the compiled program for impact analysis, and
`runPlan` also compiles. That's double compilation. Two options:

**Option A**: `runPlan` takes a `PlanDraftDoc` and compiles internally. The
extension compiles separately for the review dialog. Compilation is cheap
and pure — double-compiling is harmless.

**Option B**: `runPlan` takes a pre-compiled `Program`. The extension and CLI
both compile before calling `runPlan`.

Option B is cleaner — compile once, use everywhere. But it means `runPlan`
also needs the `ValidatedActor` map since that's needed by the scheduler.

Revised interface:

```typescript
export interface RunPlanConfig {
  readonly program: Program;
  readonly actorsByName: ReadonlyMap<ActorId, ValidatedActor>;
  readonly modelRegistry: ModelRegistry;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: SchedulerEventHandler;
  readonly shellPath?: string;
  readonly shellCommandPrefix?: string;
}
```

This is better. Compilation and actor validation happen outside `runPlan`.
Both the extension and CLI do: validate actors → compile → (optionally review)
→ `runPlan`. The shared function is just the scheduler lifecycle.

**Changes to `execute.ts`**: The existing `executePlan` function keeps its
signature and all review dialog logic. Internally it calls `runPlan` after
compiling and reviewing. The event wiring (subscribe, onUpdate) stays in
`executePlan` because it depends on `AgentToolUpdateCallback` which is an
extension type.

**Verify**: `npm run build && npm test` — all existing tests pass, no
behavioral change.

### Step 2: Parameter defaults

**Goal**: Replace `required: boolean` with `default?: string` on
`TemplateParameter`. Backward compatible.

**File: `src/templates/types.ts`**

```typescript
interface TemplateParameter {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;      // kept for backward compat, derived from default
  readonly default?: string;       // NEW
}
```

Keep `required` as a derived field so existing code that checks
`param.required` still works. Derive it: `required = default === undefined`.

**File: `src/templates/discovery.ts`**

In `parseParameters`, after parsing each entry:

```typescript
const hasDefault = "default" in e && typeof e.default === "string";
const required = hasDefault ? false : e.required !== false;
const defaultValue = hasDefault ? (e.default as string) : undefined;
params.push({ name: e.name, description: e.description, required, default: defaultValue });
```

This handles:
- `required: true` → required, no default (existing behavior)
- `required: false` → not required, default is `""` (existing behavior)
- `default: "npm test"` → not required, default is `"npm test"` (new)
- Neither → required, no default (existing behavior)

**File: `src/templates/substitute.ts`**

In `instantiateTemplate`, before checking missing params, apply defaults:

```typescript
// Apply defaults for params not provided
for (const param of template.parameters) {
  if (param.default !== undefined && !(param.name in args)) {
    args = { ...args, [param.name]: param.default };
  }
}
```

Wait — `args` is `Readonly<Record<string, string>>`. Create a merged copy:

```typescript
const effectiveArgs: Record<string, string> = { ...args };
for (const param of template.parameters) {
  if (param.default !== undefined && !(param.name in effectiveArgs)) {
    effectiveArgs[param.name] = param.default;
  }
}
```

Then use `effectiveArgs` instead of `args` for the rest of the function.

**File: `src/replay.ts`**

In `buildReplayToolDescription`, update the param signature to show defaults:

```typescript
const paramSig = t.parameters.map((p) => {
  if (p.default !== undefined) return `${p.name}="${p.default}"`;
  return p.required ? p.name : `${p.name}?`;
}).join(", ");
```

**Tests**: Add tests for default parameter behavior in
substitute.test.ts. Test cases:
- Param with default, not provided → uses default
- Param with default, provided → uses provided value
- Param without default, not provided → error (existing behavior)
- Backward compat: `required: false` still works

**Verify**: `npm run build && npm test`

### Step 3: Template `cwd`

**Goal**: Add optional `cwd` to template frontmatter. Substitutable.

**File: `src/templates/types.ts`**

```typescript
interface PlanTemplate {
  readonly name: string;
  readonly description: string;
  readonly parameters: readonly TemplateParameter[];
  readonly cwd?: string;                    // NEW
  readonly rawPlan: Record<string, unknown>;
  readonly source: TemplateSource;
  readonly filePath: string;
}
```

**File: `src/templates/discovery.ts`**

In `parseTemplateFile`, after parsing parameters:

```typescript
const cwd = typeof frontmatter.cwd === "string" ? frontmatter.cwd : undefined;
return { name, description, parameters, cwd, rawPlan, source, filePath };
```

**File: `src/templates/substitute.ts`**

Add `cwd` to `TemplateInstantiation`:

```typescript
interface TemplateInstantiation {
  readonly plan: PlanDraftDoc;
  readonly cwd?: string;                    // NEW
  readonly templateName: string;
  readonly templateArgs: Readonly<Record<string, string>>;
}
```

In `instantiateTemplate`, after substitution and validation, resolve cwd:

```typescript
let resolvedCwd: string | undefined;
if (template.cwd) {
  resolvedCwd = typeof template.cwd === "string"
    ? substituteValue(template.cwd, substitutionMap) as string
    : undefined;
}

return ok({
  plan: cloned as PlanDraftDoc,
  cwd: resolvedCwd,
  templateName: template.name,
  templateArgs: /* ... */,
});
```

Note: `substituteValue` is an existing internal function that handles
`{{placeholder}}` replacement. We reuse it for the cwd string.

Actually, `substituteValue` returns `unknown` (due to coercion). For cwd we
want string only. Extract the string substitution into a separate helper or
just do inline replacement:

```typescript
const resolveCwd = (cwd: string, map: ReadonlyMap<string, string>): string =>
  cwd.replace(PLACEHOLDER_RE, (match, name: string) => map.get(name) ?? match);
```

**Tests**: Test cwd substitution in substitute.test.ts.

**Verify**: `npm run build && npm test`

### Step 4: CLI entry point

**Goal**: Create the one-shot CLI. Matches pi's patterns.

**New file**: `src/cli/main.ts`

Structure follows pi's `main.ts` flow:

```typescript
#!/usr/bin/env node

import { resolve } from "node:path";
import {
  AuthStorage,
  createAgentSessionServices,
  getAgentDir,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { discoverActors, actorRegistryFromDiscovery } from "../actors/discovery.js";
import { validateActors } from "../actors/validate.js";
import { compile } from "../plan/compile.js";
import { formatCompileError } from "../plan/compile-error-format.js";
import { runPlan } from "../core/run-plan.js";
import { renderRunReportText } from "../runtime/run-report.js";
import { loadTemplateFile } from "./template-loader.js";
import { parseCliArgs, type CliArgs } from "./args.js";
import { formatOutput } from "./output.js";
```

**Arg parsing** (`src/cli/args.ts`): Hand-rolled, same pattern as pi.

```typescript
interface CliArgs {
  templatePath: string;
  params: Record<string, string>;
  paramsFile?: string;
  cwd?: string;
  output: "json" | "text" | "stream-json";
  timeout: number;
  maxCost?: number;
  model?: string;
  thinking: ThinkingLevel;
  apiKey?: string;
  dryRun: boolean;
  help: boolean;
  diagnostics: Array<{ type: "warning" | "error"; message: string }>;
}
```

Parse `-e key=value`, `-e @file.json`, `--dry-run`, `--cwd`, `--output`,
`--timeout`, `--max-cost`, `--model`, `--thinking`, `--api-key`, `--help`.
First non-flag argument is the template path.

**Template loading** (`src/cli/template-loader.ts`):

Unlike the extension which uses discovery, the CLI loads a single file:

```typescript
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { parse as parseYaml } from "yaml";

export const loadTemplateFile = (filePath: string): PlanTemplate => {
  // Same logic as parseTemplateFile in discovery.ts, but:
  // - Takes a file path directly (no directory scanning)
  // - Throws on error instead of pushing to warnings array
  // - Source is always "project"
};
```

This reuses the same frontmatter parsing and YAML parsing but without the
discovery machinery. Could also just call `parseTemplateFile` from
discovery.ts directly since it's already a standalone function — check if
it's exported.

Looking at discovery.ts: `parseTemplateFile` is a module-private function
(`const parseTemplateFile`). Two options:

**Option A**: Export it. The CLI calls it directly.
**Option B**: Extract the parsing logic into a shared function.

Option A is simpler. Export `parseTemplateFile` from discovery.ts. The CLI
calls it with `(filePath, "project", warnings)` and checks warnings.

**CWD resolution** (inline in main.ts):

```typescript
const resolveCwd = (
  cliCwd: string | undefined,
  templateCwd: string | undefined,
): string => {
  if (cliCwd) return resolve(cliCwd);
  if (templateCwd) {
    if (path.isAbsolute(templateCwd)) {
      throw new Error("Template cwd must be relative");
    }
    const projectRoot = findProjectRoot(process.cwd());
    if (!projectRoot) {
      throw new Error("Template declares cwd but no .pi/ project root found");
    }
    const resolved = resolve(projectRoot, templateCwd);
    if (!resolved.startsWith(projectRoot)) {
      throw new Error("Template cwd escapes project root");
    }
    return resolved;
  }
  return process.cwd();
};
```

`findProjectRoot`: walk up from cwd looking for `.pi/` directory, return its
parent.

**Main flow** (in `src/cli/main.ts`):

```typescript
async function main(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);

  if (parsed.help) { printHelp(); process.exit(0); }
  if (parsed.diagnostics.some(d => d.type === "error")) {
    for (const d of parsed.diagnostics) console.error(d.message);
    process.exit(2);
  }

  // 1. Load template
  const warnings: TemplateWarning[] = [];
  const template = parseTemplateFile(resolve(parsed.templatePath), "project", warnings);
  if (!template) {
    console.error(`Failed to load template: ${parsed.templatePath}`);
    for (const w of warnings) console.error(`  ${w.message}`);
    process.exit(2);
  }

  // 2. Merge params: @file + -e flags + defaults
  let params = parsed.paramsFile ? JSON.parse(readFileSync(parsed.paramsFile, "utf-8")) : {};
  params = { ...params, ...parsed.params };

  // 3. Instantiate template
  const instantiation = instantiateTemplate(template, params);
  if (!instantiation.ok) {
    console.error(formatTemplateError(instantiation.error));
    process.exit(2);
  }

  // 4. Resolve cwd
  const cwd = resolveCwd(parsed.cwd, instantiation.value.cwd);

  // 5. Discover actors
  const packageRoot = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const bundledActorsDir = packageRoot ? join(packageRoot, "actors") : undefined;
  const actorDiscovery = discoverActors(cwd, "both", { bundledDir: bundledActorsDir });

  // 6. Build services (pi pattern)
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create();
  if (parsed.apiKey) {
    authStorage.setRuntimeApiKey("anthropic", parsed.apiKey);
  }
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage,
    resourceLoaderOptions: {
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });
  const { modelRegistry, settingsManager } = services;

  // 7. Resolve model
  const available = modelRegistry.getAvailable();
  if (available.length === 0) {
    console.error("No models available. Set ANTHROPIC_API_KEY or run 'pi /login'.");
    process.exit(4);
  }
  const defaultModel = parsed.model
    ? findModel(parsed.model, modelRegistry) ?? available[0]
    : available[0];

  // 8. Validate actors + compile
  const actorRegistry = actorRegistryFromDiscovery(actorDiscovery);
  const validatedActors = validateActors(
    actorDiscovery.actors, modelRegistry, defaultModel,
    parsed.thinking, (msg) => console.error(`Warning: ${msg}`),
  );
  const actorsByName = new Map(validatedActors.map(a => [ActorId(a.name), a]));

  const compileResult = compile(instantiation.value.plan, actorRegistry);
  if (!compileResult.ok) {
    console.error(`Compile error: ${formatCompileError(compileResult.error)}`);
    process.exit(3);
  }

  // 9. Dry run: print plan summary and exit
  if (parsed.dryRun) {
    printPlanSummary(compileResult.value, actorsByName, cwd, parsed.templatePath);
    process.exit(0);
  }

  // 10. Run
  const controller = new AbortController();
  setupSignalHandlers(controller);
  setupTimeout(controller, parsed.timeout);

  let accumulatedCost = 0;
  const costHandler = parsed.maxCost
    ? (event: RelayEvent) => {
        if ("usage" in event && event.usage) {
          accumulatedCost += event.usage.cost;
          if (accumulatedCost > parsed.maxCost!) controller.abort();
        }
      }
    : undefined;

  const result = await runPlan({
    program: compileResult.value,
    actorsByName,
    modelRegistry,
    cwd,
    signal: controller.signal,
    onEvent: costHandler,
    shellPath: settingsManager.getShellPath(),
    shellCommandPrefix: settingsManager.getShellCommandPrefix(),
  });

  // 11. Output
  const output = formatOutput(result, {
    template: parsed.templatePath,
    cwd,
    accumulatedCost,
  });
  // ... write to stdout based on parsed.output mode ...

  // 12. Exit
  const exitCode = result.report.outcome === "success" ? 0
    : result.state.phase === "aborted" && parsed.maxCost && accumulatedCost > parsed.maxCost ? 4
    : result.state.phase === "aborted" ? 124  // timeout
    : 1;
  process.exit(exitCode);
}

main(process.argv.slice(2));
```

**Output formatting** (`src/cli/output.ts`):

Three formatters:

- `text`: `renderRunReportText(report, artifactStore)` to stdout.
  Progress events to stderr during execution.
- `json`: Build `CliOutput` object, `JSON.stringify` to stdout.
- `stream-json`: Each `RelayEvent` is one NDJSON line to stdout during
  execution. Final line is the `CliOutput` summary.

**Dry run output** (`printPlanSummary`):

Walks the compiled `Program`, prints steps with their types, routes,
artifacts, and actor resolution status. Same format as shown in the design
doc.

**Signal handling**:

```typescript
const setupSignalHandlers = (controller: AbortController) => {
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
};
```

**Verify**: `npm run build`. Manual test:

```bash
node dist/cli/main.js plans/verified-edit.md \
  -e task="Add a comment to README.md" \
  -e verify="true" \
  --dry-run
```

### Step 5: Package configuration

**File: `package.json`**

Add bin entry:

```json
{
  "bin": {
    "relay": "./dist/cli/main.js"
  }
}
```

Ensure `dist/cli/main.js` starts with `#!/usr/bin/env node`.

**Bundled template/actor discovery**: The CLI finds bundled actors the same
way `pi-relay.ts` does — `findPackageRoot` walks up from `import.meta.url`
looking for the `package.json` with `pi.extensions`. The `actors/` and
`plans/` dirs are siblings of `package.json`.

**Verify**: `npm run build && npm link && relay plans/verified-edit.md --help`

### Step 6: Tests

**File: `src/core/run-plan.test.ts`**

Test `runPlan` with a fake `ActorEngine` (the scheduler already supports
this pattern in existing tests). Verify:
- Success path: action → command → terminal(success) → report
- Failure path: action → command(fail) → terminal(failure) → report
- Abort: signal fires mid-run → partial report

**File: `src/cli/args.test.ts`**

Test arg parsing: `-e key=value`, `-e @file`, `--dry-run`, edge cases.

**File: `src/templates/substitute.test.ts`** (extend existing)

Add tests for parameter defaults and cwd substitution.

**Verify**: `npm test`

## Dependency graph

```
Step 1 (runPlan extraction)
  ↓
Step 2 (parameter defaults)     ← independent of Step 1
  ↓
Step 3 (template cwd)           ← independent of Steps 1-2
  ↓
Step 4 (CLI entry point)        ← depends on Steps 1, 2, 3
  ↓
Step 5 (package config)         ← depends on Step 4
  ↓
Step 6 (tests)                  ← depends on all
```

Steps 1, 2, 3 are independent and could be done in parallel. Step 4 depends
on all three. Steps 5 and 6 depend on Step 4.

## Risks

1. **`createAgentSessionServices` may load extensions even with
   `noExtensions: true`**. Verify by reading the implementation — it should
   skip discovery but still return a valid `resourceLoader`. Based on reading
   the code, `DefaultResourceLoader` respects the `noExtensions` flag.

2. **`SdkActorEngine` creates its own `SettingsManager` per step**. The CLI
   creates services once for the model registry. The per-step settings
   manager reads from the same files. No conflict, but worth knowing — shell
   path and prefix are read fresh per step.

3. **The `findModel` function** in `actors/validate.ts` is already exported
   for testing. The CLI reuses it for `--model` resolution.

4. **`parseTemplateFile` is module-private**. Step 4 needs to export it or
   extract the parsing logic. The function is already well-isolated — just
   change `const` to `export const`.
