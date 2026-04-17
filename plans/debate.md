---
name: debate
description: "Structured adversarial debate between an advocate and a critic, moderated by a judge. Use for architecture decisions, design reviews, technology choices, or any question where stress-testing a position produces better outcomes than a single perspective."
parameters:
  - name: topic
    description: "The question being debated, e.g. 'Should we migrate from REST to GraphQL for the users API?'"
    required: true
  - name: position
    description: "The initial position the advocate will defend, e.g. 'Yes, migrate to GraphQL because...'"
    required: true
  - name: max_rounds
    description: "Maximum debate rounds before the judge must decide. Each round is: advocate → critic → judge."
    required: true
---

task: "Debate: {{topic}}"
successCriteria: "The judge declares the question resolved with a justified verdict, or max rounds are reached."
entryStep: argue
artifacts:
  - id: debate_log
    description: "Full debate history — arguments, critiques, and verdicts from all rounds."
    shape: { kind: untyped_json }
    accumulate: true
steps:
  - kind: action
    id: argue
    actor: advocate
    instruction: |
      The topic: {{topic}}
      The position you are defending: {{position}}

      Read the debate log for prior rounds. If this is round 1, present
      your opening argument. If this is a later round, respond to the
      critic's latest objections and the judge's guidance on what to
      focus on.

      Write your argument to the debate_log artifact as:
      { "role": "advocate", "argument": "..." }
    reads: [debate_log]
    writes: [debate_log]
    routes: [{ route: done, to: challenge }]
    maxRuns: "{{max_rounds}}"
  - kind: action
    id: challenge
    actor: critic
    instruction: |
      The topic: {{topic}}
      The position being defended: {{position}}

      Read the debate log. Challenge the advocate's latest argument.
      Find weaknesses, hidden assumptions, and failure modes.

      Write your critique to the debate_log artifact as:
      { "role": "critic", "critique": "..." }
    reads: [debate_log]
    writes: [debate_log]
    routes: [{ route: done, to: evaluate }]
    maxRuns: "{{max_rounds}}"
  - kind: action
    id: evaluate
    actor: judge
    instruction: |
      The topic: {{topic}}

      Read the full debate log. Evaluate the latest round of arguments.
      Decide: is the question resolved, or does it need another round?

      Write your verdict to the debate_log artifact as:
      - If resolved: { "role": "judge", "verdict": "resolved", "conclusion": "...", "prevailing_side": "advocate" or "critic" }
      - If unresolved: { "role": "judge", "verdict": "unresolved", "focus": "what the next round should address" }
    reads: [debate_log]
    writes: [debate_log]
    routes:
      - { route: resolved, to: done }
      - { route: unresolved, to: argue }
    maxRuns: "{{max_rounds}}"
  - kind: terminal
    id: done
    outcome: success
    summary: "Debate concluded with a verdict."
