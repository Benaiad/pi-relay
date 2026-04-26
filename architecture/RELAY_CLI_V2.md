# Headless Template Execution via `/replay`

## What this is

A `/replay` command registered by the pi-relay extension that runs templates
headlessly in pi's print mode. No custom CLI binary.

```bash
pi -p --model sonnet "/replay plans/verified-edit.md task='Fix the bug' verify='npm test'"
```

Pi's `session.prompt()` dispatches `/` commands to extension handlers before
the LLM. No LLM call, no wasted tokens. Pi handles auth, model registry,
and session management. The command handler loads the template, runs the
plan, writes the report, sets the exit code.

## How it works

1. User runs `pi -p --model sonnet "/replay plans/template.md key=value ..."`
2. Pi starts in print mode, loads extensions (including pi-relay)
3. `session.prompt("/replay ...")` is called
4. Pi sees the `/` prefix, finds the registered `replay` command
5. Handler executes directly — no LLM call
6. Handler: load template → substitute params → compile → run via `runPlan`
7. Handler: write report to stderr, set `process.exitCode`
8. Pi exits with the handler's exit code

## Invocation

```bash
pi -p --model sonnet "/replay <template.md> [key=value]..."
```

`--model` and `--thinking` are pi's own flags — reuse its model resolution
(substring matching, provider/model patterns, thinking clamping). The
command handler reads `ctx.model` and `pi.getThinkingLevel()` as defaults
for actors that don't declare their own.

```bash
# Basic
pi -p --model sonnet "/replay plans/verified-edit.md task='Fix the bug' verify='npm test'"

# With thinking
pi -p --model sonnet --thinking medium "/replay plans/reviewed-edit.md task='Refactor auth' criteria='Tests pass' verify='npm test'"

# Actors with their own model config don't need --model
pi -p "/replay plans/debate.md topic='REST vs GraphQL' position='GraphQL' max_rounds=3"
```

The `/replay` command coexists with the `replay` tool. The tool is called
by the model (LLM-driven). The command is invoked by the user with `/`
(direct execution). Different dispatch paths, same name.

## Arg parsing

The handler receives a single string: everything after `/replay `. Parse as:

```
<template-path> [key=value]...
```

First token is the template path. Remaining tokens are `key=value` params.
Tokens containing `=` are params. Everything else is an error.

Values can be quoted: `task='Fix the bug'` or `task="Fix the bug"`. The
shell strips the outer quotes from the `pi -p "..."` invocation; the
handler strips quotes from individual values.

## The command handler

Registered in `pi-relay.ts` alongside the existing `/relay` command:

```typescript
pi.registerCommand("replay", {
  description: "Run a plan template headlessly",
  async handler(args, ctx) {
    const parsed = parseReplayArgs(args);
    if (!parsed.ok) {
      console.error(parsed.error);
      process.exitCode = 2;
      return;
    }

    const template = parseTemplateFile(resolve(parsed.templatePath), "project", warnings);
    if (!template) { /* error, exit 2 */ }

    const instantiation = instantiateTemplate(template, parsed.params);
    if (!instantiation.ok) { /* error, exit 2 or 3 */ }

    const plan = instantiation.value.plan;
    const cwd = plan.cwd ? resolve(ctx.cwd, plan.cwd) : ctx.cwd;

    const actorDiscovery = discoverActors(cwd, "both", { bundledDir });
    const compileResult = compile(plan, actorRegistryFromDiscovery(actorDiscovery));
    if (!compileResult.ok) { /* error, exit 3 */ }

    const defaultThinking = pi.getThinkingLevel();
    const validatedActors = validateActors(
      actorDiscovery.actors, ctx.modelRegistry,
      ctx.model, defaultThinking,
      (msg) => console.error(`Warning: ${msg}`),
    );

    // Fail early if any actor has no model
    for (const actor of validatedActors) {
      if (!actor.resolvedModel) {
        console.error(`Actor '${actor.name}' has no model. Use pi --model <name>.`);
        process.exitCode = 3;
        return;
      }
    }

    const actorsByName = new Map(validatedActors.map(a => [ActorId(a.name), a]));
    const settingsManager = SettingsManager.create(cwd, getAgentDir());

    const result = await runPlan({
      program: compileResult.value,
      actorsByName,
      modelRegistry: ctx.modelRegistry,
      cwd,
      shellPath: settingsManager.getShellPath(),
      shellCommandPrefix: settingsManager.getShellCommandPrefix(),
    });

    console.error(renderRunReportText(result.report, result.artifactStore));
    process.exitCode = result.report.outcome === "success" ? 0 : 1;
  },
});
```

## Output

Print mode captures stdout. The handler writes the report to stderr via
`console.error()`. CI captures stderr in logs. The exit code signals
pass/fail.

| Exit code | Meaning |
|-----------|---------|
| 0 | Success terminal reached |
| 1 | Failure or incomplete |
| 2 | Bad args, missing params, file not found |
| 3 | Compile error, missing actor, no model |

## What we keep from the current implementation

- `src/core/run-plan.ts` — the extracted scheduler lifecycle
- Parameter defaults on `TemplateParameter`
- Plan `cwd` field on `PlanDraftSchema`
- `findPackageRoot` in `src/utils/package-root.ts`
- Exported `parseTemplateFile` and `loadActorsFromDir`

## What we replace

- `src/cli/main.ts` → `/replay` command handler in `pi-relay.ts`
- `src/cli/args.ts` → `parseReplayArgs` — simpler, parses `key=value` tokens

## What we remove

- `bin` entry in `package.json`
- `tsconfig.build.json`
- `npm run build` script
- `dist` in `files` array

## CI usage

```yaml
# GitHub Actions
- run: npm install -g @mariozechner/pi-coding-agent
- run: pi install https://github.com/benaiad/pi-relay
- run: pi -p --model sonnet "/replay plans/verified-edit.md task='Fix the bug' verify='npm test'"
```

## Verified

**Exit code propagation works.** `runPrintMode` returns 0 after a handled
slash command. `main.ts` only overwrites `process.exitCode` when
`runPrintMode` returns non-zero (line 726). The handler's `process.exitCode`
sticks.

**Pi requires `--model` in print mode** (main.ts line 666 exits if no model
is available). Actors without model config need `--model` on the pi command.
Actors that declare their own `model:` in frontmatter work without it — but
pi still requires at least one model to be available at startup.

**`/replay` coexists with the `replay` tool.** Tools and commands are
separate registries. The model calls the tool; the user invokes the command
with `/`.
