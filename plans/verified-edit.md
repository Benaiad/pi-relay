---
name: verified-edit
description: "Implement a change then verify with a shell command. Use for any task where you need a guarantee the change didn't break things — the check is deterministic, not the model's judgment. Simplest template: one action step, one gate."
parameters:
  - name: task
    description: What to change. Include file paths, function names, and expected behavior.
    required: true
  - name: verify
    description: "Shell command that must exit 0, e.g. 'npm test' or 'cargo test && cargo clippy'."
    required: true
---

task: "{{task}}"
entryStep: implement
artifacts:
  - id: change_notes
    description: What was changed — files touched and a one-line description per file.
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: implement
    actor: worker
    instruction: |
      {{task}}
      Write a summary of your changes to the change_notes artifact.
    reads: []
    writes: [change_notes]
    routes: { done: verify }
  - kind: verify_command
    id: verify
    command: "{{verify}}"
    onPass: done
    onFail: failed
  - kind: terminal
    id: done
    outcome: success
    summary: Change applied and verified.
  - kind: terminal
    id: failed
    outcome: failure
    summary: Verification failed after change.
