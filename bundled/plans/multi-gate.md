---
name: multi-gate
description: "Implement a change then run three sequential verification gates (e.g., lint → typecheck → tests). Use instead of verified-edit when you need to know exactly which gate failed — each reports independently. A compound 'lint && tsc && test' command hides which step broke."
parameters:
  - name: task
    description: What to implement. Include file paths and expected behavior.
  - name: gate1
    description: "First verification gate, e.g. 'npm run lint' or 'cargo fmt --check'."
  - name: gate1_name
    description: "Human-readable name for gate 1, e.g. 'lint' or 'format'."
  - name: gate2
    description: "Second verification gate, e.g. 'npx tsc --noEmit' or 'cargo clippy -- -D warnings'."
  - name: gate2_name
    description: "Human-readable name for gate 2, e.g. 'typecheck' or 'clippy'."
  - name: gate3
    description: "Third verification gate, e.g. 'npm test' or 'cargo test'."
  - name: gate3_name
    description: "Human-readable name for gate 3, e.g. 'test' or 'test suite'."
---

task: "{{task}}"
success_criteria: "All three gates pass: {{gate1_name}}, {{gate2_name}}, {{gate3_name}}."
artifacts:
  - name: change_notes
    description: What was changed — files touched and a one-line description per file.

steps:
  - type: action
    name: implement
    actor: worker
    instruction: |
      {{task}}
      Write a summary of your changes to the change_notes artifact.
    writes: [change_notes]
    routes: { done: gate1 }
  - type: command
    name: gate1
    command: "{{gate1}}"
    on_success: gate2
    on_failure: gate1_failed
  - type: command
    name: gate2
    command: "{{gate2}}"
    on_success: gate3
    on_failure: gate2_failed
  - type: command
    name: gate3
    command: "{{gate3}}"
    on_success: done
    on_failure: gate3_failed
  - type: terminal
    name: done
    outcome: success
    summary: "All gates passed: {{gate1_name}}, {{gate2_name}}, {{gate3_name}}."
  - type: terminal
    name: gate1_failed
    outcome: failure
    summary: "Failed at {{gate1_name}}."
  - type: terminal
    name: gate2_failed
    outcome: failure
    summary: "Failed at {{gate2_name}} ({{gate1_name}} passed)."
  - type: terminal
    name: gate3_failed
    outcome: failure
    summary: "Failed at {{gate3_name}} ({{gate1_name}} and {{gate2_name}} passed)."
