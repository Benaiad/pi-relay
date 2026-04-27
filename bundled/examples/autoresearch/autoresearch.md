---
name: autoresearch
description: "Autonomous optimization loop. The agent modifies a file, a benchmark measures the result, an evaluation gate keeps or reverts. Repeats up to 50 times. Use when you want iterative, overnight optimization with deterministic evaluation — the agent proposes changes, scripts decide outcomes."
parameters:
  - name: target
    description: "File the agent modifies, e.g. 'optimize.js' or 'src/model.py'."
  - name: goal
    description: "What to optimize: 'execution speed', 'memory usage', 'accuracy', etc."
  - name: benchmark
    description: "Shell command that benchmarks the target. Must exit 0 on success, 1 on crash. Should write metrics to a file the evaluate command can read."
  - name: evaluate
    description: "Shell command that compares the benchmark result to the previous best. Exit 0 if improved (and checkpoint the change), exit 1 if not (and revert the target file)."
  - name: recover
    description: "Shell command to restore the target file after a crash, e.g. 'cp optimize.best.js optimize.js'."
  - name: max_experiments
    description: "Maximum number of experiments to run, e.g. '50' for overnight or '10' for a quick test."
---

task: "Optimize {{target}} for {{goal}}"
success_criteria: "The optimization loop runs until max_runs is reached. Improvements are kept, non-improvements are reverted by the evaluate script."
entry_step: experiment
artifacts:
  - name: experiment_log
    description: "Accumulated log of what each experiment tried and why. Each entry is appended automatically — the actor writes one entry per iteration."
steps:
  - type: action
    name: experiment
    actor: worker
    instruction: |
      You are an autonomous researcher optimizing {{target}} for {{goal}}.

      Read {{target}} to understand the current implementation.

      Read the experiment_log artifact to see what has been tried before.
      Do NOT repeat approaches that have already been tried. If an approach
      was tried and discarded, try something structurally different.

      Propose and apply ONE optimization to {{target}}. Be creative but
      disciplined — try one idea at a time. Consider:
      - Algorithmic improvements
      - Data structure changes
      - Memory access patterns
      - Eliminating redundant work
      - Mathematical shortcuts

      Do NOT modify any other files. The benchmark and evaluation scripts
      are fixed.

      Write an entry to experiment_log describing what you tried and why:
      { "approach": "what you changed", "rationale": "why this should help" }
    reads: [experiment_log]
    writes: [experiment_log]
    routes: { done: benchmark }
    max_runs: "{{max_experiments}}"
  - type: command
    name: benchmark
    command: "{{benchmark}}"
    on_success: evaluate
    on_failure: recover
  - type: command
    name: evaluate
    command: "{{evaluate}}"
    on_success: experiment
    on_failure: experiment
  - type: command
    name: recover
    command: "{{recover}}"
    on_success: experiment
    on_failure: failed
  - type: terminal
    name: failed
    outcome: failure
    summary: "Recovery failed after a crash — manual intervention needed."
