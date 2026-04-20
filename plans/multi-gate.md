---
name: multi-gate
description: "Implement a change then run three sequential verification gates (e.g., lint → typecheck → tests). Use instead of verified-edit when you need to know exactly which gate failed — each reports independently. A compound 'lint && tsc && test' command hides which step broke."
parameters:
  - name: task
    description: What to implement. Include file paths and expected behavior.
    required: true
  - name: gate1
    description: "First verification gate, e.g. 'npm run lint' or 'cargo fmt --check'."
    required: true
  - name: gate1_name
    description: "Human-readable name for gate 1, e.g. 'lint' or 'format'."
    required: true
  - name: gate2
    description: "Second verification gate, e.g. 'npx tsc --noEmit' or 'cargo clippy -- -D warnings'."
    required: true
  - name: gate2_name
    description: "Human-readable name for gate 2, e.g. 'typecheck' or 'clippy'."
    required: true
  - name: gate3
    description: "Third verification gate, e.g. 'npm test' or 'cargo test'."
    required: true
  - name: gate3_name
    description: "Human-readable name for gate 3, e.g. 'test' or 'test suite'."
    required: true
---

task: "{{task}}"
successCriteria: "All three gates pass: {{gate1_name}}, {{gate2_name}}, {{gate3_name}}."
artifacts:
  - id: change_notes
    description: What was changed — files touched and a one-line description per file.

steps:
  - kind: action
    id: implement
    actor: worker
    instruction: |
      {{task}}
      Write a summary of your changes to the change_notes artifact.
    writes: [change_notes]
    routes: { done: gate1 }
  - kind: verify_command
    id: gate1
    command: "{{gate1}}"
    onPass: gate2
    onFail: gate1_failed
  - kind: verify_command
    id: gate2
    command: "{{gate2}}"
    onPass: gate3
    onFail: gate2_failed
  - kind: verify_command
    id: gate3
    command: "{{gate3}}"
    onPass: done
    onFail: gate3_failed
  - kind: terminal
    id: done
    outcome: success
    summary: "All gates passed: {{gate1_name}}, {{gate2_name}}, {{gate3_name}}."
  - kind: terminal
    id: gate1_failed
    outcome: failure
    summary: "Failed at {{gate1_name}}."
  - kind: terminal
    id: gate2_failed
    outcome: failure
    summary: "Failed at {{gate2_name}} ({{gate1_name}} passed)."
  - kind: terminal
    id: gate3_failed
    outcome: failure
    summary: "Failed at {{gate3_name}} ({{gate1_name}} and {{gate2_name}} passed)."
