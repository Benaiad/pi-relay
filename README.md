# pi-relay

**Plan. Execute. Verify.**

Finite state machine workflows for [pi](https://pi.dev/). Agents act, Relay verify.

```bash
pi install https://github.com/benaiad/pi-relay
```

Two tools are added to pi:

- **`relay`** — the model builds a plan from scratch: steps, actors, artifacts, verification gates.
- **`replay`** — the model runs a saved plan template by name with arguments.

Type `/relay` to browse installed actors and templates.

## How it works

1. The model calls `relay` (ad-hoc plan) or `replay` (saved template) based on the task.
2. The plan is compiled — actor references, route targets, and artifact contracts are validated.
3. You review the plan and choose: **Run**, **Refine**, or **Cancel**.
4. The scheduler executes steps sequentially. Action steps spawn isolated agent subprocesses. Check steps run shell commands and route on exit code — pass or fail, no interpretation.
5. The run report shows what happened: per-step outcomes, tool calls, and actor transcripts. Press `Ctrl+O` to expand the full step-by-step detail.

Use `/relay` to browse installed actors and templates.

## Templates

Four templates ship with the extension:

- **verified-edit**(task, verify) — implement then verify. One step, one gate.
- **bug-fix**(bug, verify) — diagnose → fix → verify. Diagnosis artifact forces structured thinking before code changes.
- **reviewed-edit**(task, criteria, verify) — implement → spec review → quality review → fix loop → verify. Reviewers run in fresh contexts.
- **multi-gate**(task, gate1–3, gate1–3_name) — implement → three sequential gates with per-gate failure reporting.

Templates live in `~/.pi/agent/relay/plans/` (user scope) or `<project>/.pi/relay/plans/` (project scope). Write your own:

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
    routes: [{ route: done, to: verify }]
  - kind: check
    id: verify
    check: { kind: command_exits_zero, command: "{{verify}}" }
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

Check commands run through the platform shell (`/bin/sh` on Unix, `cmd.exe` on Windows). Integer and boolean parameters are coerced automatically.

## Actors

Actors define the roles that execute plan steps. Two ship with the extension:

- **worker** — implements changes (read, edit, write, grep, find, ls, bash)
- **reviewer** — reviews against criteria, read-only (read, grep, find, ls, bash)

Actors live in `~/.pi/agent/relay/actors/` (user scope) or `<project>/.pi/relay/actors/` (project scope). Write your own:

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

Edits to actor system prompts take effect on the next execution. Adding or removing actors requires `/reload`.

## Autoresearch

An autonomous optimization loop is included as an example. The agent modifies code, the runtime benchmarks it, a deterministic gate keeps improvements and reverts regressions. See [`examples/autoresearch/`](examples/autoresearch/).

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
