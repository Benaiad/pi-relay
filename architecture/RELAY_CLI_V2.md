# Headless Template Execution via `/replay` — NOT FEASIBLE

## The idea

Register a `/replay` command in the pi-relay extension. Pi's
`session.prompt()` dispatches `/` commands to extension handlers before the
LLM — no LLM call. Run templates headlessly via:

```bash
pi -p --model sonnet "/replay plans/verified-edit.md task='Fix the bug' verify='npm test'"
```

## Why it doesn't work

### Print mode captures stdout

Pi's print mode calls `takeOverStdout()` before extensions load. After the
takeover, all `process.stdout.write` calls are redirected to stderr. The
command handler has no way to write to real stdout.

- `console.log("report")` → goes to stderr
- `console.error("report")` → goes to stderr
- `process.stdout.write("report")` → goes to stderr (redirected)

Only `writeRawStdout()` (an internal pi function) writes to real stdout.
It is not exported in pi's public API. Extensions cannot use it.

### Pi's output modes don't help

**Text mode** (`pi -p`): After a slash command returns, print mode reads
the last assistant message. There is none (no LLM call happened) → stdout
is empty.

**JSON mode** (`pi -p --mode json`): Writes a session header + NDJSON
events. The slash command produces no session events → only a stale header
on stdout.

In both modes, the plan report is only on stderr. This means:

- `pi -p "/replay ..." > report.txt` captures nothing
- `pi -p "/replay ..." 2> report.txt` captures the report, but this is
  non-standard and breaks user expectations

### Other extensions avoid this problem by using the LLM

The `/review` extension (earendil-works/pi-review) works around this by
calling `pi.sendUserMessage(prompt)` — it sends a crafted prompt to the
LLM, and the model's response flows through pi's normal output pipeline.
The command is just a setup layer; the model produces the actual output.

This pattern doesn't apply to `/replay` because the whole point is to
execute plans directly without an LLM dispatch call. The plan execution
(actors, commands, verification gates) is the output — there's no model
response to capture.

### Pi requires a model in print mode

`main.ts` line 666: `if (appMode !== "interactive" && !session.model)`
→ `process.exit(1)`. Pi exits before the slash command runs if no model
is available. This blocks use cases where all actors declare their own
model (no `--model` needed) or validation-only runs.

## Conclusion

The slash command approach is blocked by pi's stdout capture in print mode.
The report cannot reach stdout, which breaks standard output redirection
and CI expectations. The standalone CLI (`src/cli/main.ts`) is the correct
approach — it controls its own stdout and doesn't depend on pi's output
pipeline.
