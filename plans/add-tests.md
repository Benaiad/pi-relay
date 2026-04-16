---
name: add-tests
description: Write tests for existing code and verify they pass. Forces the model to produce tests that actually run.
parameters:
  - name: target
    description: "File or module to test, e.g. 'src/auth/session.ts' or 'the user registration flow'."
    required: true
  - name: focus
    description: "What to test — edge cases, error paths, specific functions, or 'comprehensive coverage'."
    required: true
  - name: verify
    description: "Shell command that runs the tests, e.g. 'npm test' or 'pytest tests/'."
    required: true
---

task: "Write tests for {{target}}, focusing on: {{focus}}"
successCriteria: "Tests exist, cover the specified focus areas, and pass."
entryStep: write_tests
artifacts:
  - id: test_plan
    description: "What tests were written: file paths, test names, and what each test verifies."
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: write_tests
    actor: worker
    instruction: |
      Read {{target}} and understand its behavior.
      Write tests focusing on: {{focus}}

      Follow the project's existing test conventions — same framework,
      same file locations, same naming patterns.

      Write a test_plan artifact listing each test you added:
      - file: where the test lives
      - tests: array of {name, verifies} describing each test
    reads: []
    writes: [test_plan]
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
    summary: "Tests written and passing."
  - kind: terminal
    id: failed
    outcome: failure
    summary: "Tests failed to pass."
