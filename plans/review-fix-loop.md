---
name: review-fix-loop
description: Implement a change, then review and fix until the reviewer approves.
parameters:
  - name: target
    description: File or module to modify.
    required: true
  - name: task
    description: What to implement or change.
    required: true
  - name: criteria
    description: Acceptance criteria the reviewer checks against.
    required: true
---

task: "{{task}} in {{target}}, reviewed against: {{criteria}}"
entryStep: implement
artifacts:
  - id: notes
    description: Implementation and fix notes written by the worker.
    shape: { kind: untyped_json }
    multiWriter: true
  - id: verdict
    description: Review verdict — approved or changes_requested with feedback.
    shape: { kind: untyped_json }
    multiWriter: true
steps:
  - kind: action
    id: implement
    actor: worker
    instruction: |
      {{task}}
      Target: {{target}}
      Write a summary of what you did to the notes artifact.
    reads: []
    writes: [notes]
    routes: [{ route: done, to: review }]
  - kind: action
    id: review
    actor: reviewer
    instruction: |
      Review the changes against these criteria:
      {{criteria}}

      Read the notes artifact for context on what was changed.
      If the changes meet the criteria, approve. Otherwise request specific fixes.
      Write your verdict to the verdict artifact with either
      {"approved": true} or {"approved": false, "feedback": "..."}.
    reads: [notes]
    writes: [verdict]
    routes:
      - { route: approved, to: success }
      - { route: changes_requested, to: fix }
  - kind: action
    id: fix
    actor: worker
    instruction: |
      Read the reviewer's verdict and apply the requested changes.
      Target: {{target}}
      Update the notes artifact with what you fixed.
    reads: [verdict]
    writes: [notes]
    routes: [{ route: done, to: review }]
    retry: { maxAttempts: 3 }
  - kind: terminal
    id: success
    outcome: success
    summary: "Changes approved by reviewer."
