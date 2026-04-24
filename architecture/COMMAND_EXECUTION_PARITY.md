# Command execution parity with Pi

## Problem

Relay command steps bypass Pi's bash execution pipeline. A command step runs via
a bare `createLocalBashOperations()` call with no options, which means:

1. User-configured `shellPath` is ignored.
2. User-configured `shellCommandPrefix` is ignored.
3. When relay injects `RELAY_INPUT`/`RELAY_OUTPUT` env vars, it replaces
   Pi's `getShellEnv()` entirely, dropping Pi's managed bin directory from PATH.

These are concrete local-execution bugs that affect any user who has customized
their Pi shell settings.

There is also a broader environment question: relay command steps do not
participate in Pi's extension-based bash tool replacement (sandbox, SSH,
containers). This document covers the local parity fixes in scope and the
extension question as an upstream dependency.

## Sandbox and SSH behavior today

Pi's sandbox and SSH extensions work by **replacing the registered bash tool**,
not by sandboxing the Pi process itself. When the model calls the `bash` tool,
the extension intercepts it and wraps or redirects the command. Relay does not
call the bash tool — it calls `createLocalBashOperations()` directly.

**Sandbox:** Command steps do not fail. They succeed, but run with full local
privileges. This is a silent sandbox escape — the user expects all bash
execution to be sandboxed, but relay's verification gates bypass it.

**SSH:** Command steps run locally instead of on the remote host. If the project
exists only on the remote machine, commands like `cargo test` fail because the
source files are missing locally. If the project is synced, commands run against
potentially stale local state. Either way, the behavior is wrong.

**This is not relay-specific.** pi-autoresearch has the same problem — its
`run_experiment` tool uses raw `child_process.spawn("bash", ["-c", command])`
and its git operations use `pi.exec()`, both of which bypass sandbox/SSH. Every
Pi extension that runs commands outside the model's bash tool falls through the
same gap. The problem is systemic in Pi's extension API.

## Why we cannot fix sandbox/SSH today

Pi's extension API provides no mechanism for an extension to run a command
through the session's active bash backend. We investigated every path:

- **`pi.exec()`** exists on ExtensionAPI but is raw `spawn()` — no shell
  resolution, no sandbox wrapping, no extension hooks.
- **`pi.getAllTools()`** returns metadata only (name, description, parameters)
  — no `execute` function. Cannot call the registered bash tool.
- **`user_bash` event** only fires for interactive `!` commands. Cannot be
  triggered programmatically by extensions. Unreliable for caching operations.
- **`extensionRunner.emitUserBash()`** resolves bash operations correctly but
  lives on `AgentSession`, not on `ExtensionAPI` or `ExtensionContext`.
- **No tool query API.** `ExtensionAPI` has `registerTool()` but no
  `getRegisteredTool()`. The tool registry is private to the extension manager.
- **No tool registration events.** Extensions cannot observe when other
  extensions register or replace tools.

## Upstream proposal: environment-aware `pi.exec`

The cleanest fix is for Pi to make `pi.exec()` environment-aware. Today it is
a raw `spawn()`. If it routed through the active bash operations (respecting
registered tool overrides, sandbox wrapping, SSH redirection), every extension
that uses `pi.exec()` — relay, autoresearch, and any future extension — would
automatically get correct sandbox/SSH behavior.

Alternatively, Pi could add a dedicated `pi.runBash()` method:

```typescript
pi.runBash(command: string, options?: {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  onData?: (data: Buffer) => void;
}): Promise<{ exitCode: number | null }>
```

This would emit a synthetic `user_bash`-style resolution internally, get the
active `BashOperations` from whatever sandbox/SSH extension is loaded, apply
`shellCommandPrefix` and `shellPath` from settings, and execute the command.
It would not record in session history.

Either approach closes the gap for all extensions. Until Pi ships one of these,
sandbox/SSH bypass is a documented limitation.

## What changes now

### 1. Load shell settings at execution time

`executePlan()` in `execute.ts` already receives `ExtensionContext`, which
carries `cwd`. We create a `SettingsManager` (already exported from Pi, already
used in `sdk-engine.ts`) and read `shellPath` and `shellCommandPrefix`.

These two values are passed into `Scheduler` as part of its config.

### 2. Pass shell settings to `runCommand`

`runCommand` in `checks.ts` gains an optional parameter for shell settings:

```
shellPath:          passed to createLocalBashOperations({ shellPath })
shellCommandPrefix: prepended to the command string before execution
```

The module-level `const ops = createLocalBashOperations()` singleton goes away.
Instead, `runCommand` creates the operations with the correct shell path. This
could be created once per scheduler run and passed in, or once per
`runCommand` call — the cost is negligible either way since it just captures
a closure.

### 3. Fix env merging

The current code:

```
env: ctx.env ? { ...process.env, ...ctx.env } : undefined
```

When `ctx.env` is set (i.e., when RELAY_INPUT/RELAY_OUTPUT are present), this
replaces the `env` parameter entirely, which causes `createLocalBashOperations`
to skip its default `getShellEnv()` call (the fallback is `env ?? getShellEnv()`).
The result: Pi's managed bin directory is missing from PATH.

`getShellEnv()` is not exported from Pi's package. We replicate its behavior
using `getAgentDir()` (already exported, already used in our `config.ts`).
`getShellEnv()` does one thing: prepends `join(getAgentDir(), "bin")` to PATH.
We do the same when constructing the env for command steps:

```typescript
const binDir = join(getAgentDir(), "bin");
const pathKey = Object.keys(process.env)
  .find(k => k.toLowerCase() === "path") ?? "PATH";
const currentPath = process.env[pathKey] ?? "";
const updatedPath = currentPath.includes(binDir)
  ? currentPath
  : `${binDir}${delimiter}${currentPath}`;

const env = {
  ...process.env,
  [pathKey]: updatedPath,
  ...ctx.env,  // RELAY_INPUT, RELAY_OUTPUT
};
```

This mirrors `getShellEnv()` exactly. The coupling is to a stable convention
("Pi's bin dir should be on PATH"), not to an internal implementation detail.

**Rejected alternative: inline env vars in the command string.** We considered
prepending `RELAY_INPUT=... RELAY_OUTPUT=... command` to avoid overriding the
`env` parameter. This is wrong: `VAR=value command` in shell only sets the
variable for the immediately following simple command, not for compound commands
(`&&`, `||`, `;`, pipes). Since step commands are arbitrary shell strings, this
would silently lose the env vars in many cases.

### 4. Apply shellCommandPrefix

The scheduler prepends `shellCommandPrefix` to the command string before passing
it to `runCommand`:

```
resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command
```

This matches how Pi's bash tool applies the prefix in
`createBashToolDefinition` (bash.ts:293).

## Data flow after the change

1. `executePlan()` loads `SettingsManager`, reads `shellPath` and
   `shellCommandPrefix`.
2. These are passed into `Scheduler` config.
3. When the scheduler reaches a command step:
   - It creates artifact input/output temp directories (unchanged).
   - It builds env with Pi's bin dir on PATH, plus RELAY_INPUT/RELAY_OUTPUT.
   - It prepends `shellCommandPrefix` to the command if configured.
   - It calls `runCommand(step, ctx, onOutput, { shellPath })`.
4. `runCommand` creates `createLocalBashOperations({ shellPath })` and calls
   `ops.exec(resolvedCommand, cwd, { onData, signal, timeout, env })`.
5. The env includes Pi's bin directory on PATH because we constructed it
   to match `getShellEnv()`.

## What this does NOT cover

- **Sandbox extension support.** Command steps still bypass sandbox wrapping.
  Requires upstream Pi API change (`pi.runBash()` or environment-aware
  `pi.exec()`).
- **SSH extension support.** Command steps still run locally. Same dependency.
- **`runFilesExist` in SSH/sandbox.** `runFilesExist` uses local `fs.access()`
  to check file existence. In SSH environments where the project lives on a
  remote machine, these checks run against the local filesystem — wrong
  machine. Same class of problem as command execution, same upstream
  dependency.
- **Artifact staging for remote environments.** Temp directories use local
  `/tmp`. For SSH/container execution, artifacts would need remote staging.
  Not relevant until remote command execution exists.
- **Actor session bash environment.** Actor sessions use `noExtensions: true`,
  so they also bypass sandbox/SSH tool overrides. Separate design question.

## Files changed

- `src/execute.ts` — load SettingsManager, pass shell settings to Scheduler.
- `src/runtime/scheduler.ts` — accept shell settings in config, construct env
  with Pi bin dir, apply shellCommandPrefix.
- `src/runtime/checks.ts` — accept shell settings in `runCommand`, remove
  module-level ops singleton, create ops per call with shellPath.
- Tests for: command prefix application, custom shell path, env merging with
  Pi bin dir preserved.

## Risks

- **Coupling to `getShellEnv()` behavior.** If Pi's `getShellEnv()` evolves
  beyond "prepend bin dir to PATH," our replication will drift. Mitigated by:
  the function has been stable, and we can request Pi export it. If they do,
  we replace our three lines with a direct call.
- **`shellCommandPrefix` ordering.** The prefix must come before the step
  command, matching Pi's bash tool behavior. The scheduler owns this
  concatenation.
