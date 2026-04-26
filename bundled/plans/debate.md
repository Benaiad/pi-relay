---
name: debate
description: "Structured adversarial debate between an advocate and a critic, moderated by a judge. Use for architecture decisions, design reviews, technology choices, or any question where stress-testing a position produces better outcomes than a single perspective."
parameters:
  - name: topic
    description: "The question being debated, e.g. 'Should we migrate from REST to GraphQL for the users API?'"
  - name: position
    description: "The initial position the advocate will defend, e.g. 'Yes, migrate to GraphQL because...'"
  - name: max_rounds
    description: "Maximum debate rounds before the judge must decide. Each round is: advocate → critic → judge."
---

task: "Debate: {{topic}}"
success_criteria: "The judge declares the question resolved with a justified verdict, or max rounds are reached."
artifacts:
  - name: debate_log
    description: "Full debate history — arguments, critiques, and verdicts from all rounds."
    fields: [role, claims]
    list: true

steps:
  - type: action
    name: argue
    actor: advocate
    instruction: |
      The topic: {{topic}}
      The position you are defending: {{position}}

      Read the debate log for prior rounds. If this is round 1, present
      your opening argument. If this is a later round, respond to the
      critic's latest objections and the judge's guidance on what to
      focus on.

      Write a SHORT structured summary to the debate_log artifact.
      Keep it under 200 words — key claims only, not the full argument.
      The full argument goes in your narration text (before the
      completion tag), not in the artifact.
      Format: { "role": "advocate", "claims": ["claim 1", "claim 2"] }
    reads: [debate_log]
    writes: [debate_log]
    routes: { done: challenge }
    max_runs: "{{max_rounds}}"
  - type: action
    name: challenge
    actor: critic
    instruction: |
      The topic: {{topic}}
      The position being defended: {{position}}

      Read the debate log. Challenge the advocate's latest argument.
      Find weaknesses, hidden assumptions, and failure modes.

      Write a SHORT structured summary to the debate_log artifact.
      Keep it under 200 words — key objections only, not the full
      critique. The full critique goes in your narration text.
      Format: { "role": "critic", "objections": ["objection 1", "objection 2"] }
    reads: [debate_log]
    writes: [debate_log]
    routes: { done: evaluate }
    max_runs: "{{max_rounds}}"
  - type: action
    name: evaluate
    actor: judge
    instruction: |
      The topic: {{topic}}

      Read the full debate log. Evaluate the latest round of arguments.
      Decide: is the question resolved, or does it need another round?

      Write a SHORT verdict to the debate_log artifact.
      Keep it under 100 words. The full reasoning goes in your
      narration text.
      - If resolved: { "role": "judge", "verdict": "resolved", "conclusion": "one sentence", "prevailing_side": "advocate" or "critic" }
      - If unresolved: { "role": "judge", "verdict": "unresolved", "focus": "what to address next" }
    reads: [debate_log]
    writes: [debate_log]
    routes:
      resolved: done
      unresolved: argue
    max_runs: "{{max_rounds}}"
  - type: terminal
    name: done
    outcome: success
    summary: "Debate concluded with a verdict."
