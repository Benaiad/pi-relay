---
name: reviewed-edit
description: Make a change, have it reviewed by a fresh-context reviewer, and iterate until approved. Then verify with a deterministic check.
parameters:
  - name: task
    description: What to implement. Include file paths and expected behavior.
    required: true
  - name: criteria
    description: What the reviewer checks against — quality bar, requirements, edge cases to cover.
    required: true
  - name: verify
    description: "Shell command that must exit 0 after approval, e.g. 'npm test && npm run lint'."
    required: true
---

task: "{{task}} (reviewed against: {{criteria}})"
successCriteria: "{{criteria}}"
entryStep: implement
artifacts:
  - id: notes
    description: Implementation and fix notes from the worker.
    shape: { kind: untyped_json }
    multiWriter: true
  - id: verdict
    description: "Review verdict: approved or changes_requested with specific feedback."
    shape: { kind: untyped_json }
    multiWriter: true
steps:
  - kind: action
    id: implement
    actor: worker
    instruction: |
      {{task}}
      Write a summary of your changes to the notes artifact.
    reads: []
    writes: [notes]
    routes: [{ route: done, to: review }]
  - kind: action
    id: review
    actor: reviewer
    instruction: |
      Review the implementation against these criteria:
      {{criteria}}

      Read the notes artifact and the actual files to understand what changed.
      Write a verdict artifact:
      - If acceptable: {"approved": true, "summary": "..."}
      - If not: {"approved": false, "issues": ["..."], "fixes": ["..."]}

      Be specific. Name files, functions, and line numbers.
    reads: [notes]
    writes: [verdict]
    routes:
      - { route: approved, to: verify }
      - { route: changes_requested, to: fix }
  - kind: action
    id: fix
    actor: worker
    instruction: |
      Read the verdict artifact and apply every requested change.
      Update the notes artifact with what you fixed.
    reads: [verdict]
    writes: [notes]
    routes: [{ route: done, to: review }]
    retry: { maxAttempts: 3 }
  - kind: check
    id: verify
    check: { kind: command_exits_zero, command: "{{verify}}" }
    onPass: done
    onFail: failed
  - kind: terminal
    id: done
    outcome: success
    summary: "Change approved by reviewer and verified."
  - kind: terminal
    id: failed
    outcome: failure
    summary: "Verification failed after review approval."
