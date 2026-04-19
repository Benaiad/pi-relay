# pi-relay

Multi-step workflows for [pi](https://pi.dev/) — actors do the work, verification gates decide pass/fail.

```bash
pi install https://github.com/benaiad/pi-relay
```

Or install manually:

```bash
# Copy
cp -r . ~/.pi/agent/extensions/pi-relay/
cd ~/.pi/agent/extensions/pi-relay && npm install --omit=dev

# Or symlink (changes take effect immediately)
ln -s "$(pwd)" ~/.pi/agent/extensions/pi-relay
```

Without relay, the assistant handles everything in a single conversation turn. Relay lets it break complex work into a plan with multiple actors, verification gates, and structured routing between steps. The assistant decides when a task needs relay — you just describe what you want.

Three things are added to pi:

- **`relay` tool** — the assistant builds and executes an ad-hoc plan: steps, actors, artifacts, verification gates.
- **`replay` tool** — the assistant runs a saved plan template by name with arguments.
- **`/relay` command** — interactive TUI to browse, enable, and disable actors and templates.

## How it works

1. The assistant calls `relay` (ad-hoc plan) or `replay` (saved template) based on the task.
2. The plan is compiled — actor references, route targets, and artifact contracts are validated.
3. You review the plan and choose: **Run**, **Refine**, or **Cancel**.
4. The scheduler executes steps sequentially. Action steps spawn isolated agent subprocesses. Verify steps run shell commands or check file existence and route on the outcome — pass or fail, no interpretation.
5. The run report shows what happened: per-step outcomes, tool calls, and actor transcripts. Press `Ctrl+O` to expand the full step-by-step detail.

## Core concepts

### Step kinds

A plan is a DAG of steps. Four kinds:

- **`action`** — an actor (LLM agent) runs with a restricted tool set and emits a route on completion.
- **`verify_command`** — runs a shell command. Pass if exit 0, fail otherwise. Output is captured for the failure reason.
- **`verify_files_exist`** — checks that all listed paths exist on the filesystem.
- **`terminal`** — ends the run with a declared outcome: success or failure.

### Routes

Action steps declare a map of route names to target steps:

```yaml
routes: { done: verify, failure: failed }
```

The actor chooses which route to emit on completion. Multi-way branching is supported — a judge step might route to `resolved` or `unresolved`, each pointing to a different next step.

Verify steps route via fixed `onPass` / `onFail` fields.

### Artifacts

Structured state passed between steps. Declared at the plan level with an id and description, then read and written by action steps. The runtime enforces that only declared writers commit values. Artifacts accumulate across loop iterations with attribution metadata.

### Back-edges and loops

Routes can point to earlier steps, creating loops. A verify step that fails can route back to an action step, which re-runs with the failure reason in its prompt. The `maxRuns` field on action steps caps iterations to prevent runaway loops.

## Included templates

Five templates ship with the extension, plus one example. Each implements a different workflow topology — from a single gate to multi-round adversarial loops. The assistant picks the right one via `replay`, or builds a custom plan with `relay`.

### verified-edit

The simplest useful topology: do the work, then prove it didn't break anything.

```mermaid
graph LR
    implement["implement\n(worker)"] --> verify{verify}
    verify -- pass --> done([done])
    verify -- fail --> failed([failed])
```

**Parameters:** `task`, `verify`

```
Use replay with the verified-edit template:
  task: Add input validation to the signup handler in src/api/signup.ts
  verify: npm test
```

### bug-fix

Diagnosis before code changes. The worker writes a structured root-cause analysis to an artifact, then reads it back when fixing. No "let me just try something."

```mermaid
graph LR
    diagnose["diagnose\n(worker)"] --> fix["fix\n(worker)"]
    fix --> verify{verify}
    verify -- pass --> done([done])
    verify -- fail --> failed([failed])
```

**Parameters:** `bug`, `verify`

```
Use replay with the bug-fix template:
  bug: Login returns 500 when email contains a + character
  verify: npm test -- --grep auth
```

### reviewed-edit

Two-pass review with a fix loop. Spec compliance first, code quality second. Reviewers run in fresh contexts — no memory of the implementation reasoning, so they evaluate the code as-is.

```mermaid
graph LR
    implement["implement\n(worker)"] --> spec["spec review\n(reviewer)"]
    spec -- approved --> quality["quality review\n(reviewer)"]
    spec -- changes requested --> fix["fix\n(worker)"]
    quality -- approved --> verify{verify}
    quality -- changes requested --> fix
    fix --> spec
    verify -- pass --> done([done])
    verify -- fail --> failed([failed])
```

**Parameters:** `task`, `criteria`, `verify`

```
Use replay with the reviewed-edit template:
  task: Add rate limiting to the /api/upload endpoint
  criteria: Returns 429 after 10 requests per minute per IP. Includes Retry-After header.
  verify: npm test && npm run lint
```

### multi-gate

Three sequential verification gates with per-gate failure reporting. Use instead of `verified-edit` when you need to know exactly which gate failed — a compound `lint && tsc && test` command hides which step broke.

```mermaid
graph LR
    implement["implement\n(worker)"] --> g1{gate 1}
    g1 -- pass --> g2{gate 2}
    g1 -- fail --> f1([fail 1])
    g2 -- pass --> g3{gate 3}
    g2 -- fail --> f2([fail 2])
    g3 -- pass --> done([done])
    g3 -- fail --> f3([fail 3])
```

**Parameters:** `task`, `gate1`, `gate1_name`, `gate2`, `gate2_name`, `gate3`, `gate3_name`

```
Use replay with the multi-gate template:
  task: Refactor the config parser to use Zod schemas
  gate1: npm run lint
  gate1_name: lint
  gate2: npx tsc --noEmit
  gate2_name: typecheck
  gate3: npm test
  gate3_name: test
```

### debate

Structured adversarial debate between three actors. The advocate defends a position, the critic attacks it, and the judge decides whether the question is resolved or needs another round. The loop runs up to `max_rounds` iterations.

```mermaid
graph LR
    argue["argue\n(advocate)"] --> challenge["challenge\n(critic)"]
    challenge --> evaluate["evaluate\n(judge)"]
    evaluate -- unresolved --> argue
    evaluate -- resolved --> done([done])
```

**Parameters:** `topic`, `position`, `max_rounds`

```
Use replay with the debate template:
  topic: Should we migrate from REST to GraphQL for the users API?
  position: Yes — GraphQL eliminates overfetching and simplifies the mobile client.
  max_rounds: 3
```

### autoresearch

An autonomous optimization loop that demonstrates back-edges with `maxRuns` for iteration capping. The agent modifies code, the runtime benchmarks it, a deterministic gate keeps improvements and reverts regressions. Included as an example in [`examples/autoresearch/`](examples/autoresearch/) — see its README for setup.

```mermaid
graph LR
    experiment["experiment\n(worker)"] --> benchmark{benchmark}
    benchmark -- pass --> evaluate{evaluate}
    benchmark -- fail --> recover{recover}
    evaluate -- improved --> experiment
    evaluate -- no improvement --> experiment
    recover --> experiment
```

**Parameters:** `target`, `goal`, `benchmark`, `evaluate`, `recover`, `max_experiments`

## Custom templates

The five bundled templates work out of the box. To add your own or override a bundled one, place `.md` files in:

- **User scope:** `~/.pi/agent/pi-relay/plans/` — available in all projects
- **Project scope:** `<project>/.pi/pi-relay/plans/` — available only in that project

A custom template with the same `name:` as a bundled one shadows it. Project scope shadows user scope. Example:

```markdown
---
name: my-workflow
description: "What this does and when to use it."
parameters:
  - name: task
    description: What to implement.
    required: true
  - name: verify
    description: Shell command that must exit 0.
    required: true
---

task: "{{task}}"
entryStep: implement
artifacts: []
steps:
  - kind: action
    id: implement
    actor: worker
    instruction: "{{task}}"
    reads: []
    writes: []
    routes: { done: verify }
  - kind: verify_command
    id: verify
    command: "{{verify}}"
    onPass: done
    onFail: failed
  - kind: terminal
    id: done
    outcome: success
    summary: Done.
  - kind: terminal
    id: failed
    outcome: failure
    summary: Verification failed.
```

Verify commands run through pi's shell backend (respects `shellPath` in settings, defaults to `/bin/bash` on Unix, Git Bash on Windows). Integer and boolean parameters are coerced automatically.

## Actors

Actors define the roles that execute action steps. Five ship with the extension:

- **worker** — implements changes (read, edit, write, grep, find, ls, bash)
- **reviewer** — reviews against criteria, read-only (read, grep, find, ls, bash)
- **advocate** — argues a position in a debate (read, grep, find, ls)
- **critic** — challenges arguments in a debate (read, grep, find, ls)
- **judge** — evaluates debate rounds and delivers verdicts (read, grep, find, ls)

To add custom actors or override a bundled one, place `.md` files in:

- **User scope:** `~/.pi/agent/pi-relay/actors/` — available in all projects
- **Project scope:** `<project>/.pi/pi-relay/actors/` — available only in that project

Same shadowing rules as templates. Example:

```markdown
---
name: security-auditor
description: Scans code for security vulnerabilities
tools: read, grep, find, ls
---

You are a security auditor. Read the code carefully and report
any vulnerabilities, focusing on injection, auth bypass, and
data exposure.
```

Edits to actor system prompts take effect on the next execution. Adding or removing actors requires `/reload`. Use `/relay` to toggle actors on or off — disabling an actor automatically disables templates that use it.

## Plan review

When a plan can modify files or run commands, pi shows a review dialog before execution:

- **Run the plan** — execute as described
- **Refine** — provide feedback; the model revises and resubmits
- **Cancel** — abort without executing

Read-only plans skip the dialog.

## Development

```bash
git clone https://github.com/benaiad/pi-relay.git
cd pi-relay && npm install && pi install .
npm test
```

## License

MIT
