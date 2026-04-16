---
name: autoresearch
description: "Autonomous optimization loop. The agent modifies a file, a benchmark measures the result, an evaluation gate keeps or reverts. Repeats up to 50 times. Use when you want iterative, overnight optimization with deterministic evaluation — the agent proposes changes, scripts decide outcomes."
parameters:
  - name: target
    description: "File the agent modifies, e.g. 'optimize.js' or 'src/model.py'."
    required: true
  - name: goal
    description: "What to optimize: 'execution speed', 'memory usage', 'accuracy', etc."
    required: true
  - name: benchmark
    description: "Shell command that benchmarks the target. Must exit 0 on success, 1 on crash. Should write metrics to a file the evaluate command can read."
    required: true
  - name: evaluate
    description: "Shell command that compares the benchmark result to the previous best. Exit 0 if improved (and checkpoint the change), exit 1 if not (and revert the target file)."
    required: true
  - name: recover
    description: "Shell command to restore the target file after a crash, e.g. 'cp optimize.best.js optimize.js'."
    required: true
  - name: max_experiments
    description: "Maximum number of experiments to run, e.g. '50' for overnight or '10' for a quick test."
    required: true
---

task: "Optimize {{target}} for {{goal}}"
successCriteria: "The optimization loop runs until maxRuns is reached. Improvements are kept, non-improvements are reverted by the evaluate script."
entryStep: experiment
artifacts: []
steps:
  - kind: action
    id: experiment
    actor: worker
    instruction: |
      You are an autonomous researcher optimizing {{target}} for {{goal}}.

      Read {{target}} to understand the current implementation.
      Check if there are previous results (look for results files in the
      working directory) to understand what has already been tried.

      Propose and apply ONE optimization to {{target}}. Be creative but
      disciplined — try one idea at a time. Consider:
      - Algorithmic improvements
      - Data structure changes
      - Memory access patterns
      - Eliminating redundant work
      - Mathematical shortcuts

      Do NOT modify any other files. The benchmark and evaluation scripts
      are fixed.
    reads: []
    writes: []
    routes: [{ route: done, to: benchmark }]
    maxRuns: "{{max_experiments}}"
  - kind: check
    id: benchmark
    check: { kind: command_exits_zero, command: "{{benchmark}}" }
    onPass: evaluate
    onFail: recover
  - kind: check
    id: evaluate
    check: { kind: command_exits_zero, command: "{{evaluate}}" }
    onPass: experiment
    onFail: experiment
  - kind: check
    id: recover
    check: { kind: command_exits_zero, command: "{{recover}}" }
    onPass: experiment
    onFail: failed
  - kind: terminal
    id: failed
    outcome: failure
    summary: "Recovery failed after a crash — manual intervention needed."
