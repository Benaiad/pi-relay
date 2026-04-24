---
name: reviewed-edit
description: "Implement, then review in two passes — spec compliance first, code quality second — then verify. Use for quality-critical changes where you don't trust a single pass. Reviewers run in fresh contexts with no memory of the implementation reasoning. Fix loop iterates until both approve."
parameters:
  - name: task
    description: What to implement. Include file paths and expected behavior.
    required: true
  - name: criteria
    description: Acceptance criteria the spec reviewer checks against.
    required: true
  - name: verify
    description: "Shell command that must exit 0 after approval, e.g. 'npm test && npm run lint'."
    required: true
---

task: "{{task}}"
success_criteria: "{{criteria}}"
artifacts:
  - name: notes
    description: Implementation and fix notes from the worker.

  - name: spec_verdict
    description: "Spec compliance verdict: does the implementation match the requirements?"
    fields: [compliant, gaps]
  - name: quality_verdict
    description: "Code quality verdict: is the implementation well-written?"
    fields: [approved, issues, fixes]

steps:
  - type: action
    name: implement
    actor: worker
    instruction: |
      {{task}}
      Write a summary of your changes to the notes artifact.
    writes: [notes]
    routes: { done: spec_review }
  - type: action
    name: spec_review
    actor: reviewer
    instruction: |
      Review the implementation for spec compliance only.
      The requirements are:
      {{criteria}}

      Read the notes artifact and the actual changed files.
      Check: does the implementation satisfy every requirement?
      Ignore code quality — that's a separate review.

      Write a spec_verdict artifact:
      - If compliant: {"compliant": true}
      - If not: {"compliant": false, "gaps": ["requirement X is missing", ...]}
    reads: [notes]
    writes: [spec_verdict]
    routes:
      approved: quality_review
      changes_requested: fix
  - type: action
    name: quality_review
    actor: reviewer
    instruction: |
      Review the implementation for code quality only.
      Spec compliance has already been verified — focus on:
      - Correctness and edge cases
      - Error handling
      - Naming and readability
      - Unnecessary complexity

      Read the notes artifact and the actual changed files.

      Write a quality_verdict artifact:
      - If acceptable: {"approved": true}
      - If not: {"approved": false, "issues": ["..."], "fixes": ["..."]}

      Be specific. Name files, functions, and line numbers.
    reads: [notes]
    writes: [quality_verdict]
    routes:
      approved: verify
      changes_requested: fix
  - type: action
    name: fix
    actor: worker
    instruction: |
      Read the spec_verdict and quality_verdict artifacts.
      Apply every requested change.
      Update the notes artifact with what you fixed.
    reads: [spec_verdict, quality_verdict]
    writes: [notes]
    routes: { done: spec_review }
  - type: command
    name: verify
    command: "{{verify}}"
    on_success: done
    on_failure: failed
  - type: terminal
    name: done
    outcome: success
    summary: "Implemented, reviewed (spec + quality), and verified."
  - type: terminal
    name: failed
    outcome: failure
    summary: Verification failed after review approval.
