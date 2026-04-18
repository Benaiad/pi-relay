# Reuse Pi's BashOperations for Check Execution

## Problem

`checks.ts` hand-rolls command execution with `spawn`, manual timeout
handling, and manual signal wiring. This duplicates infrastructure
that Pi already solves in `createLocalBashOperations()` — the same
backend that Pi's bash tool uses when the LLM calls `bash`.

The hand-rolled version has correctness gaps:

1. **No process tree kill.** `proc.kill("SIGTERM")` only kills the
   direct child. A check like `npm test` spawns a tree. Timeout
   fires, `sh` dies, the Jest workers live on.
2. **No `waitForChildProcess`.** Uses `proc.on("close")` which can
   hang on Windows when descendants inherit the child's stdio
   handles.
3. **No detached child tracking.** If pi exits (SIGHUP/SIGTERM),
   spawned check processes are orphaned with no cleanup.
4. **No shell config.** Uses `shell: true`, delegating to the OS
   default. Pi's `getShellConfig()` respects the user's `shellPath`
   setting and handles cross-platform resolution (Git Bash on
   Windows, `/bin/bash` vs `sh` on Unix).

These are not theoretical — process tree orphans happen whenever a
check command spawns children, which is the common case for build
and test commands.

## Solution

Replace the manual `spawn` wiring in `runCommandExitsZero` with
`createLocalBashOperations()` from `@mariozechner/pi-coding-agent`.
This is already a peer dependency. The function returns a
`BashOperations` with a single method:

```
exec(command, cwd, { onData, signal, timeout, env })
  → Promise<{ exitCode: number | null }>
```

This is the execution backend that Pi's bash tool call uses. It
handles shell resolution, process tree kill, detached child tracking,
abort signal propagation, timeout with SIGTERM → SIGKILL escalation
(5-second grace), and the Windows stdio-hang workaround.

## What changes

`runCommandExitsZero` drops its manual `spawn` + event wiring
(~60 lines) and calls `ops.exec()` instead.

**Kept in checks.ts:** `runCheck` dispatch, `runFileExists`,
`formatCommandFailure`, `truncateOutput`. These are check-domain
logic — they decide pass/fail and format the reason string. That
is not command execution infrastructure.

**Dropped from checks.ts:** The `spawn` call, the manual timeout
timer, the SIGTERM → SIGKILL dance, the abort listener setup, the
`close` event handler.

## Tradeoff: merged stdout/stderr

`BashOperations.exec` streams both stdout and stderr through a
single `onData` callback. The current code captures them separately
so `formatCommandFailure` can label them:

```
npm test exited with code 1; stderr: ... | stdout: ...
```

With merged output, the failure reason becomes:

```
npm test exited with code 1; output: ...
```

This is a formatting change, not a correctness change. The check's
job is pass/fail with a diagnostic reason. The actor receiving the
failure reason does not need separate stream labels — it can rerun
the command itself to see the full output.

## What this does NOT cover

- **`engine.ts` subprocess spawning.** The actor engine spawns `pi`
  subprocesses with `shell: false` and a JSON streaming protocol.
  That is process orchestration, not shell command execution. It
  correctly uses bare `spawn` and should not change.
- **Adding new check kinds.** Out of scope.
- **Output truncation changes.** `truncateOutput` stays as-is.
  Pi's `truncateTail` is designed for tool output sent to the LLM;
  check failure reasons have a different size constraint
  (800 chars, not 50KB).
