---
name: refactor-module
description: Rename a symbol across a module, verified by the test suite.
parameters:
  - name: module
    description: Path to the module directory or file.
    required: true
  - name: old_name
    description: Current symbol name to rename.
    required: true
  - name: new_name
    description: New symbol name.
    required: true
  - name: test_command
    description: Test command to verify the rename. Defaults to 'npm test' if omitted.
    required: false
---

task: "Rename `{{old_name}}` to `{{new_name}}` in `{{module}}`"
entryStep: rename
artifacts:
  - id: rename_notes
    description: Summary of what was changed during the rename.
    shape: { kind: untyped_json }
steps:
  - kind: action
    id: rename
    actor: worker
    instruction: |
      Rename every occurrence of `{{old_name}}` to `{{new_name}}` throughout `{{module}}`.
      Update imports, exports, type references, and string literals that reference the symbol.
      Do not touch files outside `{{module}}`.
      Write a summary of what you changed to the rename_notes artifact.
    reads: []
    writes: [rename_notes]
    routes: [{ route: done, to: verify }]
  - kind: check
    id: verify
    check: { kind: command_exits_zero, command: npm, args: [test] }
    onPass: success
    onFail: failed
  - kind: terminal
    id: success
    outcome: success
    summary: "Rename verified — test suite passed."
  - kind: terminal
    id: failed
    outcome: failure
    summary: "Tests failed after rename."
