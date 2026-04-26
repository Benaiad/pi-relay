---
name: bug-fix
description: "Diagnose a bug, then fix it, then verify. Use instead of verified-edit when you want the root cause documented before any code changes. Diagnosis writes a structured artifact that the fix step reads — no guesswork, no 'let me just try something'."
parameters:
  - name: bug
    description: The bug — symptoms, reproduction steps, or the failing test.
  - name: verify
    description: "Shell command that proves the bug is fixed, e.g. 'npm test' or 'pytest tests/test_auth.py'."
---

task: "Fix: {{bug}}"
success_criteria: "Verification passes and the root cause is documented."
artifacts:
  - name: diagnosis
    description: "Root cause analysis: what's wrong, where, and the minimal fix."
    fields: [root_cause, file, line, fix]
    list: true
  - name: fix_notes
    description: What was changed to fix the bug.

steps:
  - type: action
    name: diagnose
    actor: worker
    instruction: |
      Investigate this bug:
      {{bug}}

      Read the relevant code and reproduce the failure if possible.
      Identify the root cause — do NOT fix the code yet.

      If you find the bug, write a diagnosis artifact with each issue
      found, then route "found".

      If the reported behavior is not a bug (works as intended, cannot
      reproduce, or the premise is wrong), route "clean" without
      writing a diagnosis.
    writes: [diagnosis]
    routes:
      found: fix
      clean: not_a_bug
  - type: action
    name: fix
    actor: worker
    instruction: |
      Read the diagnosis artifact and apply the fix it describes.
      Make the smallest change that resolves the root cause.
      Do not refactor unrelated code.
      Write a fix_notes artifact summarizing what you changed.
    reads: [diagnosis]
    writes: [fix_notes]
    routes: { done: verify }
  - type: command
    name: verify
    command: "{{verify}}"
    on_success: done
    on_failure: failed
  - type: terminal
    name: done
    outcome: success
    summary: Bug fixed and verified.
  - type: terminal
    name: not_a_bug
    outcome: success
    summary: Investigation found no bug — the reported behavior is not a defect.
  - type: terminal
    name: failed
    outcome: failure
    summary: Verification failed after fix attempt.
