# Relay CLI v2: Slash Command via `pi -p`

## Discovery

Pi's `session.prompt()` checks for `/` prefix before sending to the LLM. If
the message matches a registered extension command, the handler executes
directly — no LLM call. This works in print mode (`pi -p`).

This means pi-relay can register a `/relay-run` command that executes
templates headlessly:

```bash
pi -p "/relay-run plans/verified-edit.md task='Fix the bug' verify='npm test'"
```

Pi handles everything: auth, model registry, session management, extension
loading. The command handler gets `ExtensionCommandContext` with `cwd`,
`modelRegistry`, `model`, and `hasUI: false`. No custom CLI binary needed.

## How it works

1. User runs `pi -p "/relay-run <template> key=value ..."`
2. Pi starts in print mode, loads extensions (including pi-relay)
3. `session.prompt("/relay-run ...")` is called
4. Pi sees the `/` prefix, finds the registered `relay-run` command
5. Command handler executes directly — **no LLM call**
6. Handler: loads template, substitutes, compiles, runs via `runPlan`
7. Handler: writes report to stderr, sets `process.exitCode`
8. Pi exits

## The command handler

```typescript
pi.registerCommand("relay-run", {
  description: "Run a relay plan template headlessly",
  async handler(args, ctx) {
    // Parse: "plans/verified-edit.md task='Fix the bug' verify='npm test'"
    const parsed = parseRelayRunArgs(args);

    // Load template from file
    const template = parseTemplateFile(resolve(parsed.templatePath), "project", warnings);

    // Instantiate with params
    const instantiation = instantiateTemplate(template, parsed.params);
    const plan = instantiation.value.plan;

    // Resolve cwd
    const cwd = plan.cwd ? resolve(ctx.cwd, plan.cwd) : ctx.cwd;

    // Discover actors
    const actorDiscovery = discoverActors(cwd, "both", { bundledDir });

    // Compile
    const compileResult = compile(plan, actorRegistryFromDiscovery(actorDiscovery));

    // Validate actors against the session's model registry
    const defaultModel = parsed.model
      ? findModel(parsed.model, ctx.modelRegistry)
      : ctx.model;
    const defaultThinking = parsed.thinking ?? "off";
    const validatedActors = validateActors(
      actorDiscovery.actors, ctx.modelRegistry,
      defaultModel, defaultThinking, (msg) => console.error(msg),
    );

    // Check all actors have models
    for (const actor of validatedActors) {
      if (!actor.resolvedModel) {
        console.error(`Actor '${actor.name}' has no model.`);
        process.exitCode = 3;
        return;
      }
    }

    // Run
    const result = await runPlan({
      program: compileResult.value,
      actorsByName,
      modelRegistry: ctx.modelRegistry,
      cwd,
    });

    // Output report to stderr (stdout is captured by print mode)
    console.error(renderRunReportText(result.report, result.artifactStore));
    process.exitCode = result.report.outcome === "success" ? 0 : 1;
  },
});
```

## Arg parsing

The handler receives a single string (everything after `/relay-run `). Parse
it as:

```
<template-path> [key=value]... [@file.json] [--model provider/name] [--thinking level] [--dry-run]
```

First token is the template path. Remaining tokens are either `key=value`
params, `@file.json` for params from file, or flags.

This is simpler than the standalone CLI args because there's no `-e` prefix —
the args are already inside the command string.

```bash
pi -p "/relay-run plans/verified-edit.md task='Fix the bug' verify='npm test'"
pi -p "/relay-run plans/reviewed-edit.md @ci/params.json --model anthropic/claude-sonnet-4-5"
pi -p "/relay-run plans/verified-edit.md task='Fix it' --dry-run"
```

## Output

Print mode captures stdout via `takeOverStdout()`. The command handler uses
`console.error()` for the report — this goes to stderr, which CI captures in
logs. The exit code signals pass/fail.

| Exit code | Meaning |
|-----------|---------|
| 0 | Success terminal reached |
| 1 | Failure terminal, incomplete, or aborted |

Pre-execution errors (missing template, bad params, compile error) also go to
stderr via `console.error()`. Exit codes 2/3/4 as before.

## What about `--model` and `--thinking`?

Two options:

**A) Flags inside the command string:**
```bash
pi -p "/relay-run plans/test.md task='...' --model anthropic/claude-sonnet-4-5"
```

Parsed by the command handler's arg parser.

**B) Pi's own flags:**
```bash
pi -p --model anthropic/claude-sonnet-4-5 "/relay-run plans/test.md task='...'"
```

Pi's `--model` sets `ctx.model` on the session. The command handler reads
`ctx.model` as the default. No extra parsing needed.

Option B is better — it reuses pi's existing model resolution, including
provider auth, model registry, thinking level clamping. The command handler
just reads `ctx.model` and `ctx.thinkingLevel` (via `pi.getThinkingLevel()`).

```bash
pi -p --model anthropic/claude-sonnet-4-5 --thinking medium "/relay-run plans/test.md task='Fix it' verify='npm test'"
```

The only custom flags the command handler needs to parse: `--dry-run` and
`--actors-dir`. Everything else comes from pi's flags.

## What changes vs the current CLI implementation

**Keep:**
- `src/core/run-plan.ts` — the extracted engine (Step 1)
- Parameter defaults (Step 2)
- Plan `cwd` in `PlanDraftSchema` (Step 3)
- `findPackageRoot` extraction (Step 4)
- Export of `parseTemplateFile` and `loadActorsFromDir`

**Replace:**
- `src/cli/main.ts` → becomes the `/relay-run` command handler in `pi-relay.ts`
- `src/cli/args.ts` → simplified arg parser for the command string

**Remove:**
- `bin` entry in `package.json`
- `tsconfig.build.json`
- `npm run build` script
- `dist/` in `files` array

The relay extension is no longer a standalone binary. It's just a pi
extension with a command that works in print mode.

## CI usage

```bash
# Install pi and pi-relay
npm install -g @mariozechner/pi-coding-agent
pi install https://github.com/benaiad/pi-relay

# Run a template
pi -p --model anthropic/claude-sonnet-4-5 "/relay-run plans/verified-edit.md task='Fix the bug' verify='npm test'"

# Dry run (no LLM calls, no API key needed)
pi -p "/relay-run plans/verified-edit.md task='Fix the bug' verify='npm test' --dry-run"

# Params from file
pi -p --model anthropic/claude-sonnet-4-5 "/relay-run plans/reviewed-edit.md @ci/params.json"
```

## Advantages over standalone CLI

1. **No custom binary.** No build step, no `dist/`, no `bin` entry. The
   extension is the CLI.
2. **No auth setup.** Pi handles `ANTHROPIC_API_KEY`, OAuth, models.json,
   provider registration. The command handler just reads `ctx.modelRegistry`.
3. **No service construction.** No `createAgentSessionServices`,
   `AuthStorage.create()`, `SettingsManager`. Pi already built all of this.
4. **Pi's model resolution.** `--model` and `--thinking` use pi's existing
   resolver, including substring matching, provider/model patterns, and
   thinking level clamping.
5. **Single install.** `pi install pi-relay` gives you both the interactive
   tools and the headless command. No separate `npm install -g`.

## Risks

1. **Print mode stdout capture.** The report goes to stderr, not stdout.
   CI captures both, but piping `pi -p "/relay-run ..." | less` doesn't
   work for the report. Acceptable for CI use.

2. **Exit code propagation.** Print mode returns an exit code from
   `runPrintMode`. After a slash command, `session.prompt()` returns
   normally (the command was handled). Print mode sees no assistant message
   and returns exit code 0. We need `process.exitCode` set by the handler
   to override this. Verify this works by checking if pi respects
   `process.exitCode` set during a command handler.

3. **`ctx.model` may be undefined in print mode without `--model`.** Pi's
   print mode errors if no model is selected (main.ts line 666). But with a
   slash command, the model might not be needed (e.g., `--dry-run`). The
   command is executed before the model check. Need to verify the startup
   sequence.

4. **Quoting.** `pi -p "/relay-run plans/test.md task='Fix the bug'"` —
   the shell handles the outer quotes, pi gets the inner string. Nested
   quotes can be tricky. Users may need to use `@file.json` for complex
   task descriptions.
