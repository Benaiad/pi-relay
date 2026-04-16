---
name: verified-edit
description: Make a change and verify it with a shell command. The check is deterministic — the model cannot lie about the result.
parameters:
  - name: task
    description: What to change. Be specific — include file paths, function names, and expected behavior.
    required: true
  - name: verify
    description: "Shell command that must exit 0 for the change to be accepted, e.g. 'npm test' or 'cargo test && cargo clippy'."
    required: true
---

task: "{{task}}"
entryStep: implement
artifacts:
  - id: change_notes
    description: Summary of what was changed — files touched and a one-line description per file.
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
    routes: [{ route: done, to: verify }]
    retry: { maxAttempts: 2 }
  - kind: check
    id: verify
    check: { kind: command_exits_zero, command: "{{verify}}" }
    onPass: done
    onFail: failed
  - kind: terminal
    id: done
    outcome: success
    summary: "Change applied and verified."
  - kind: terminal
    id: failed
    outcome: failure
    summary: "Verification failed after change."
