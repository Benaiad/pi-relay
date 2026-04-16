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
successCriteria: "{{criteria}}"
entryStep: implement
artifacts:
  - id: notes
    description: Implementation and fix notes from the worker.
    shape: { kind: untyped_json }
  - id: spec_verdict
    description: "Spec compliance verdict: does the implementation match the requirements?"
    shape: { kind: untyped_json }
  - id: quality_verdict
    description: "Code quality verdict: is the implementation well-written?"
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: implement
    actor: worker
    instruction: |
      {{task}}
      Write a summary of your changes to the notes artifact.
    reads: []
    writes: [notes]
    routes: [{ route: done, to: spec_review }]
  - kind: action
    id: spec_review
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
      - { route: approved, to: quality_review }
      - { route: changes_requested, to: fix }
  - kind: action
    id: quality_review
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
      - { route: approved, to: verify }
      - { route: changes_requested, to: fix }
  - kind: action
    id: fix
    actor: worker
    instruction: |
      Read the spec_verdict and quality_verdict artifacts.
      Apply every requested change.
      Update the notes artifact with what you fixed.
    reads: [spec_verdict, quality_verdict]
    writes: [notes]
    routes: [{ route: done, to: spec_review }]
    retry: { maxAttempts: 3 }
  - kind: check
    id: verify
    check: { kind: command_exits_zero, command: "{{verify}}" }
    onPass: done
    onFail: failed
  - kind: terminal
    id: done
    outcome: success
    summary: "Implemented, reviewed (spec + quality), and verified."
  - kind: terminal
    id: failed
    outcome: failure
    summary: Verification failed after review approval.
