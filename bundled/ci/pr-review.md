---
name: pr-review
description: "AI code review for pull requests. Reviews the diff with line-level findings, posts a GitHub review with inline comments, fixes issues, pushes, and verifies. Two LLM calls — all GitHub interaction via scripts."
parameters:
  - name: pr_number
    description: Pull request number.
  - name: verify
    description: "Shell command that must exit 0 for verification to pass, e.g. 'npm test' or 'cargo test && cargo clippy'."
    default: "npm run check"
  - name: max_diff_lines
    description: Maximum diff lines included in the context artifact. Truncated beyond this.
    default: "10000"
  - name: base_branch
    description: "Base branch the PR targets. When empty, auto-derived from the PR via gh pr view. Set explicitly for local testing."
    default: ""
---

task: "Review PR #{{pr_number}}."
success_criteria: "Review posted. If findings exist, fixes applied and verified."
artifacts:
  - name: context
    description: "PR metadata, file change summary, and diff."

  - name: review_summary
    description: "One-paragraph review assessment with risk level."

  - name: review_findings
    description: "Structured findings with severity, location, and fix suggestions."
    fields: [severity, category, file, line, description, suggestion]
    list: true

  - name: fix_notes
    description: "Summary of changes made to address review findings."

steps:
  # ── gather context ────────────────────────────────────────────────
  - type: command
    name: prepare
    command: '"$RELAY_PLAN_DIR/scripts/prepare.sh" {{pr_number}} "{{base_branch}}" {{max_diff_lines}}'
    writes: [context]
    on_success: review
    on_failure: failed

  # ── LLM review ───────────────────────────────────────────────────
  - type: action
    name: review
    actor: pr-reviewer
    instruction: |
      Review the pull request in the context artifact.

      Assess every changed line against these criteria:
      - Correctness: logic errors, off-by-ones, race conditions, missing edge cases
      - Security: injection, auth bypass, data exposure, secret leakage
      - Error handling: swallowed errors, silent fallback defaults, missing validation
      - Type discipline: bare `any`, missing exhaustiveness, stringly-typed APIs
      - Breaking changes: public API modifications, config format changes
      - Testing: missing test coverage for changed behavior
      - Style: only deviations from the project's existing conventions

      Do NOT flag formatting, whitespace, or subjective preferences.

      Write a review_summary: one paragraph with your overall assessment
      and risk level (low/medium/high).

      Write review_findings: a list of findings. Each finding has:
      - severity: error (must fix), warning (should fix), info (consider)
      - category: correctness, security, error-handling, breaking-change,
        testing, style, performance
      - file: the affected file path (relative to the repo root)
      - line: the line number in the new version of the file, from the
        diff's @@ +N,M @@ headers. Empty string if the finding applies
        to the whole file rather than a specific line.
      - description: what's wrong
      - suggestion: concrete fix

      Route to request_changes if any finding has severity "error" or
      "warning". Route to approve only when all findings are "info" or
      there are no findings.
    reads: [context]
    writes: [review_summary, review_findings]
    routes:
      approve: post_approval
      request_changes: post_findings

  # ── post approval ────────────────────────────────────────────────
  - type: command
    name: post_approval
    command: '"$RELAY_PLAN_DIR/scripts/post-approval.sh" {{pr_number}}'
    reads: [review_summary]
    on_success: approved
    on_failure: failed

  # ── post findings with inline comments ───────────────────────────
  - type: command
    name: post_findings
    command: '"$RELAY_PLAN_DIR/scripts/post-findings.sh" {{pr_number}} "{{base_branch}}"'
    reads: [review_summary, review_findings]
    on_success: fix
    on_failure: failed

  # ── LLM fix ─────────────────────────────────────────────────────
  - type: action
    name: fix
    actor: worker
    instruction: |
      Read the review_findings artifact. Address every finding with
      severity "error". Address "warning" findings where the fix is
      straightforward. Do not address "info" findings.

      After applying fixes, verify your changes by running:
      {{verify}}

      If verification fails, read the output, adjust your fixes, and
      try again. If you cannot make it pass after a reasonable effort,
      document what you fixed and what remains in the fix_notes artifact.

      Write a summary of all changes to the fix_notes artifact.
    reads: [review_findings]
    writes: [fix_notes]
    routes: { done: push_fixes }

  # ── push fix commit ──────────────────────────────────────────────
  - type: command
    name: push_fixes
    command: '"$RELAY_PLAN_DIR/scripts/push-fixes.sh"'
    on_success: verify
    on_failure: failed

  # ── verification gate ────────────────────────────────────────────
  - type: command
    name: verify
    command: "{{verify}}"
    on_success: post_summary
    on_failure: post_failure

  # ── post success summary ─────────────────────────────────────────
  - type: command
    name: post_summary
    command: '"$RELAY_PLAN_DIR/scripts/post-summary.sh" {{pr_number}}'
    reads: [review_findings, fix_notes]
    on_success: fixed
    on_failure: fixed

  # ── post failure summary ─────────────────────────────────────────
  - type: command
    name: post_failure
    command: '"$RELAY_PLAN_DIR/scripts/post-failure.sh" {{pr_number}}'
    reads: [fix_notes]
    on_success: unfixed
    on_failure: unfixed

  # ── terminals ────────────────────────────────────────────────────
  - type: terminal
    name: approved
    outcome: success
    summary: "PR approved — no issues found."
  - type: terminal
    name: fixed
    outcome: success
    summary: "Issues found, fixed, and verified."
  - type: terminal
    name: unfixed
    outcome: failure
    summary: "Issues found and fixed, but verification failed."
  - type: terminal
    name: failed
    outcome: failure
    summary: "Plan execution failed."
