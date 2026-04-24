# Command execution parity — implementation plan

References: `architecture/COMMAND_EXECUTION_PARITY.md`

## What already exists

**Shell settings in Pi:**
- `SettingsManager.create(cwd, agentDir)` loads global + project settings.
  Already used in `src/actors/sdk-engine.ts:90`.
- `settingsManager.getShellPath()` returns `string | undefined`.
- `settingsManager.getShellCommandPrefix()` returns `string | undefined`.
- `getAgentDir()` exported from Pi, already imported in `sdk-engine.ts:25`
  and `config.ts:12`.

**Current command execution in relay:**
- `src/runtime/checks.ts:31` — module-level singleton:
  `const ops = createLocalBashOperations()` (no options).
- `src/runtime/checks.ts:81-86` — `ops.exec(step.command, ctx.cwd, { ... })`
  with `env: ctx.env ? { ...process.env, ...ctx.env } : undefined`.
- `src/runtime/scheduler.ts:474-541` — `executeCommand()` builds
  `RELAY_INPUT`/`RELAY_OUTPUT` env vars, passes them through `CheckContext.env`.
- `src/execute.ts:122-134` — creates `Scheduler` with config. No shell
  settings passed.

**Pi's `createLocalBashOperations` behavior** (bash.ts:87):
- `env: env ?? getShellEnv()` — when env is explicitly passed, `getShellEnv()`
  is skipped entirely, losing Pi's bin dir from PATH.

**Existing tests:**
- `test/runtime/checks.test.ts` — tests `runCommand` and `runFilesExist`
  directly. Uses `commandStep()` helper. Tests exit codes, timeouts, abort,
  env passing, PATH preservation.
- `test/runtime/scheduler.test.ts` — integration tests via `buildScheduler()`
  helper. Uses `Scheduler` config with `cwd`, `signal`, `clock`. Tests command
  step routing, artifact reads/writes.

## Architecture decisions

1. **Shell settings flow from `executePlan` through `Scheduler` to
   `runCommand`.** The scheduler already owns command construction (env vars,
   timeouts). Adding shellPath and commandPrefix to its config is natural.

2. **Env construction moves from `checks.ts` to `scheduler.ts`.** The
   scheduler knows about artifacts (RELAY_INPUT/RELAY_OUTPUT) and will now
   also know about Pi's bin dir. It builds the full env and passes it through
   `CheckContext.env`. `runCommand` remains a thin executor that does not
   know about Pi settings — it just runs what it's given.

3. **`BashOperations` is passed to `runCommand` via `CheckContext`.**
   Adding a separate parameter after the optional `onOutput` callback would
   force callers without callbacks to write `runCommand(step, ctx, undefined,
   ops)`. Instead, `CheckContext` gains an `ops` field. This keeps the call
   sites clean and groups all execution context together.

4. **`shellCommandPrefix` is applied by the scheduler, not by `runCommand`.**
   The scheduler prepends it to the command string before calling `runCommand`,
   matching how Pi's `createBashToolDefinition` applies it (bash.ts:293).
   `runCommand` sees the final command string.

5. **Error messages use the original command, not the prefixed one.** When
   the scheduler prepends `shellCommandPrefix`, the resolved command includes
   shell setup noise (`shopt -s expand_aliases\ncargo test`). But failure
   reasons should show the user's command (`cargo test exited with code 1`),
   not the internal prefix. The scheduler passes the resolved command for
   execution but keeps `step.command` for error display by constructing a
   step overlay that only overrides the command field.

6. **`runFilesExist` is unchanged.** It does not run shell commands. It has
   the same SSH/sandbox gap (uses local `fs.access()`, will check the wrong
   machine in SSH environments) but is not fixable without the same upstream
   Pi API changes. Documented as a known limitation.

## Step-by-step implementation

Each step leaves the codebase compiling and tests passing.

### Step 1: Move `BashOperations` into `CheckContext`

**File: `src/runtime/checks.ts`**

- Remove the module-level `const ops = createLocalBashOperations()` singleton.
- Import `type BashOperations` from Pi. Add `createLocalBashOperations` to
  the existing import.
- Add `ops` field to `CheckContext`:
  ```
  export interface CheckContext {
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly env?: Readonly<Record<string, string>>;
    readonly ops: BashOperations;
  }
  ```
- In `runCommand`, use `ctx.ops` instead of the module-level `ops`.

**File: `src/runtime/scheduler.ts`**

- Import `createLocalBashOperations` from Pi.
- Add a private `ops` field to `Scheduler`, created in constructor:
  `this.ops = createLocalBashOperations()` (no options yet — shellPath comes
  in step 2).
- In `executeCommand()`, pass `ops: this.ops` in the context object to
  `runCommand`.
- In `executeFilesExist()`, also pass `ops: this.ops` in the context to
  `runFilesExist`. (`runFilesExist` ignores it, but `CheckContext` now
  requires it.)

**File: `test/runtime/checks.test.ts`**

- Create a module-level `const ops = createLocalBashOperations()`.
- Update all `runCommand` and `runFilesExist` call sites to include
  `ops` in the context object.

**Verify:** format, lint, test.

### Step 2: Add shell settings to `SchedulerConfig`

**File: `src/runtime/scheduler.ts`**

- Add to `SchedulerConfig`:
  ```
  readonly shellPath?: string;
  readonly shellCommandPrefix?: string;
  ```
- In constructor, create ops with shellPath:
  `this.ops = createLocalBashOperations({ shellPath: config.shellPath })`.
- Store `this.shellCommandPrefix = config.shellCommandPrefix`.

**File: `src/execute.ts`**

- Import `getAgentDir`, `SettingsManager` from Pi.
- In `executePlan()`, before creating Scheduler:
  ```
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir);
  const shellPath = settingsManager.getShellPath();
  const shellCommandPrefix = settingsManager.getShellCommandPrefix();
  ```
- Pass `shellPath` and `shellCommandPrefix` to `Scheduler` config.

**Verify:** compile, test. No behavioral change yet — settings are loaded but
`shellCommandPrefix` is not applied and env is unchanged.

### Step 3: Apply `shellCommandPrefix`

**File: `src/runtime/scheduler.ts`**

- In `executeCommand()`, before calling `runCommand`, prepend the prefix:
  ```
  const resolvedCommand = this.shellCommandPrefix
    ? `${this.shellCommandPrefix}\n${step.command}`
    : step.command;
  ```
- Pass the resolved command for execution but keep the original for display.
  Create a step overlay: `{ ...step, command: resolvedCommand }` for
  `runCommand`, but use `step.command` when constructing failure reasons
  in `describeCommandStep`.

  Implementation: `runCommand` receives the overlay with the prefixed
  command (so execution works). The `describeCommandStep` call and
  `this.lastCheckResult` assignment happen outside `runCommand` and already
  use the original `step` — no change needed there.

  For the failure reason inside `runCommand` itself: `formatCommandFailure`
  receives `step.command` from the overlay, which includes the prefix. This
  is acceptable because `formatCommandFailure` is internal context for the
  model, not user-facing UI. The model benefits from seeing what actually
  ran. The user-facing `describeCommandStep` in event emissions uses the
  original step.

**File: `test/runtime/scheduler.test.ts`**

- Add a test: create a scheduler with `shellCommandPrefix: "export FOO=bar"`,
  run a command step that checks `$FOO`, verify it passes.

**Verify:** compile, test.

### Step 4: Fix env merging to preserve Pi's bin dir

**File: `src/runtime/scheduler.ts`**

- Import `join`, `delimiter` from `node:path`.
- Add a standalone function to build the shell env:
  ```
  function buildShellEnv(
    extraEnv?: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const binDir = join(getAgentDir(), "bin");
    const pathKey = Object.keys(process.env)
      .find((k) => k.toLowerCase() === "path") ?? "PATH";
    const currentPath = process.env[pathKey] ?? "";
    const pathEntries = currentPath.split(delimiter).filter(Boolean);
    const hasBinDir = pathEntries.includes(binDir);
    const updatedPath = hasBinDir
      ? currentPath
      : [binDir, currentPath].filter(Boolean).join(delimiter);
    return {
      ...process.env,
      [pathKey]: updatedPath,
      ...extraEnv,
    };
  }
  ```
  Note: uses `split(delimiter)` + exact array `includes` for PATH component
  matching, not substring `includes`. Matches Pi's `getShellEnv()`
  implementation exactly.

- In `executeCommand()`, replace the current env construction:
  ```
  // Before:
  const env: Record<string, string> = {};
  if (inputDir) env.RELAY_INPUT = inputDir;
  if (outputDir) env.RELAY_OUTPUT = outputDir;
  const envOrUndefined = Object.keys(env).length > 0 ? env : undefined;

  // After:
  const extra: Record<string, string> = {};
  if (inputDir) extra.RELAY_INPUT = inputDir;
  if (outputDir) extra.RELAY_OUTPUT = outputDir;
  const env = Object.keys(extra).length > 0
    ? buildShellEnv(extra)
    : undefined;
  ```
- When `env` is `undefined`, `createLocalBashOperations` uses its own
  `getShellEnv()` fallback — correct. When `env` is set, we've already
  included the bin dir — also correct.

**File: `test/runtime/checks.test.ts`**

- The existing test "preserves standard PATH when custom env is set" (line
  194) already verifies that `node` is findable when env is set. This
  continues to pass.
- Add a test that verifies the env passed to `runCommand` includes Pi's
  bin dir when `RELAY_INPUT` is set. Run a command that prints PATH, assert
  the output contains the expected bin dir.

**Verify:** compile, test.

### Step 5: Update docs and context type

**File: `src/runtime/checks.ts`**

- `CheckContext.env` now receives a full merged env (with process.env +
  bin dir + RELAY vars) when artifacts are present, not just the RELAY vars.
  The field name and type are still correct (`Record<string, string>`), but
  the semantics changed.
- Update the module doc comment to reflect that env, when present, is a
  complete process environment (not a delta).

**File: `architecture/COMMAND_EXECUTION_PARITY.md`**

- Add `runFilesExist` to the "What this does NOT cover" section: same
  SSH/sandbox gap, uses local `fs.access()`, not fixable without upstream
  changes.

**Verify:** compile, test. All existing tests should pass unchanged.

### Step 6: Commit and verify

- Run full verification: format, lint, test, build.
- Commit: `fix: align command step execution with Pi's bash settings`

## Dependency graph

```
Step 1 (BashOperations in CheckContext)
  └─> Step 2 (shell settings in config)
        ├─> Step 3 (shellCommandPrefix)
        └─> Step 4 (env merging)
              └─> Step 5 (docs)
                    └─> Step 6 (commit)
```

Steps 3 and 4 are independent of each other and could be done in either
order.

## File change summary

| File | Change |
|------|--------|
| `src/runtime/checks.ts` | Remove module-level `ops` singleton. Add `ops: BashOperations` to `CheckContext`. Update doc comment. |
| `src/runtime/scheduler.ts` | Add `shellPath`, `shellCommandPrefix` to config. Create `ops` in constructor. Apply command prefix. Build env with Pi bin dir (exact PATH match). |
| `src/execute.ts` | Load `SettingsManager`, read shell settings, pass to Scheduler. |
| `test/runtime/checks.test.ts` | Add `ops` to all `CheckContext` objects. Add env/PATH test. |
| `test/runtime/scheduler.test.ts` | Add test for `shellCommandPrefix`. |
| `architecture/COMMAND_EXECUTION_PARITY.md` | Document `runFilesExist` SSH/sandbox gap. |

## Risks and mitigations

- **Breaking test API.** Adding `ops` to `CheckContext` breaks all existing
  test call sites. Mitigation: update them all in step 1 before any
  behavioral changes.
- **`SettingsManager.create` side effects.** It reads config files from disk.
  In tests, the scheduler is created without it (settings are `undefined`).
  Mitigation: the new config fields are optional — tests don't pass them,
  and the code falls back to `createLocalBashOperations()` with no options
  and no command prefix, preserving current behavior.
- **`buildShellEnv` coupling.** We replicate `getShellEnv()` logic. If Pi
  changes it, we drift. Mitigation: the logic is a few lines (prepend bin
  dir to PATH using exact path component matching). If Pi exports
  `getShellEnv()`, we replace our version with one call.
- **Error message content.** `formatCommandFailure` inside `runCommand` will
  show the prefixed command in failure reasons passed to the model. This is
  intentional — the model benefits from seeing the full executed command.
  User-facing event emissions (`describeCommandStep`) use the original
  `step.command` from the plan, not the overlay.
- **`runFilesExist` in SSH/sandbox.** Uses local `fs.access()`. In SSH
  environments, file existence checks run against the wrong machine. Same
  upstream dependency as command execution — requires `pi.runBash()` or
  equivalent. Documented as a limitation.
