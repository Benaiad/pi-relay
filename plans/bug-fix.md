---
name: bug-fix
description: Structured diagnosis then fix. Diagnosis and fix run in separate contexts — the fix is informed by structured findings, not guesswork.
parameters:
  - name: bug
    description: The bug — symptoms, reproduction steps, or the failing test.
    required: true
  - name: verify
    description: "Shell command that proves the bug is fixed, e.g. 'npm test' or 'pytest tests/test_auth.py'."
    required: true
---

task: "Fix: {{bug}}"
successCriteria: "Verification passes and the root cause is documented."
entryStep: diagnose
artifacts:
  - id: diagnosis
    description: "Root cause analysis: what's wrong, where, and the minimal fix."
    shape: { kind: untyped_json }
  - id: fix_notes
    description: What was changed to fix the bug.
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: diagnose
    actor: worker
    instruction: |
      Investigate this bug:
      {{bug}}

      Read the relevant code and reproduce the failure if possible.
      Identify the root cause — do NOT fix the code yet.

      Write a diagnosis artifact:
      - root_cause: one sentence
      - file: the file containing the bug
      - line: approximate line number if identifiable
      - fix: the minimal change that resolves it
    reads: []
    writes: [diagnosis]
    routes: [{ route: done, to: fix }]
  - kind: action
    id: fix
    actor: worker
    instruction: |
      Read the diagnosis artifact and apply the fix it describes.
      Make the smallest change that resolves the root cause.
      Do not refactor unrelated code.
      Write a fix_notes artifact summarizing what you changed.
    reads: [diagnosis]
    writes: [fix_notes]
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
    summary: Bug fixed and verified.
  - kind: terminal
    id: failed
    outcome: failure
    summary: Verification failed after fix attempt.
