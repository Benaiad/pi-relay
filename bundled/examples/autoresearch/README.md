# Autoresearch with Relay

An autonomous optimization loop: the agent modifies `optimize.js`,
the runtime benchmarks it and compares to the previous best. If
faster, keep. If not, revert. Repeat.

The evaluation is deterministic. The agent proposes changes;
`benchmark.js` measures time; `evaluate.js` compares to the best
and decides keep/revert. The agent cannot lie about whether the
metric improved.

## Files

- `optimize.js` — the function the agent modifies (starts as naive trial division)
- `benchmark.js` — runs `findPrimes(50000)` three times, takes best time, verifies correctness (DO NOT MODIFY)
- `evaluate.js` — compares `result.json` to `best.json`, keeps or reverts (DO NOT MODIFY)

## Installing the plan template

The autoresearch template doesn't ship with the default plans. Add it
to make it available via the `replay` tool:

```bash
# Global (available in all projects)
cp autoresearch.md ~/.pi/agent/pi-relay/plans/

# Or project-local (available only in the current project)
mkdir -p .pi/pi-relay/plans
cp autoresearch.md .pi/pi-relay/plans/
```

Then `/reload` in pi.

## Running

Ask pi to use the `autoresearch` replay template:

```
Use replay with the autoresearch template:
  target: optimize.js
  goal: execution speed
  benchmark: node benchmark.js
  evaluate: node evaluate.js
  recover: cp optimize.best.js optimize.js
  max_experiments: 10
```

The agent iterates, trying progressively better algorithms (e.g.,
trial division → sqrt optimization → sieve of Eratosthenes). Each
iteration takes a few seconds. The loop runs up to 50 experiments
(the template's `max_runs` cap).

## How it works

```
experiment (action) → benchmark (check) → evaluate (check) → experiment
                          ↓ fail                                 ↑
                      recover (check) ──────────────────────────→┘
```

1. **experiment** — the agent reads `optimize.js` and any previous
   results, proposes one optimization, edits the file.
2. **benchmark** — `node benchmark.js` runs the function, measures
   time, verifies correctness. Exits 0 on success, 1 on crash.
3. **evaluate** — `node evaluate.js` compares the benchmark result
   to the previous best. If faster: checkpoints the file and exits 0.
   If not: reverts to the checkpoint and exits 1. Either way, the
   loop continues.
4. **recover** — if benchmark crashed, restores `optimize.js` from
   the last checkpoint.

Generated files (gitignored):
- `result.json` — latest benchmark output
- `best.json` — best result so far
- `optimize.best.js` — checkpoint of the best version
- `results.tsv` — experiment log

## Adapting for your own project

Write your own `benchmark` and `evaluate` scripts following the same
contract:

- **benchmark**: run the target, measure a metric, write results to
  a file. Exit 0 if the run completed, 1 if it crashed.
- **evaluate**: read the benchmark results, compare to the previous
  best. Exit 0 if improved (and save a checkpoint), exit 1 if not
  (and revert the target file).

Then call the `autoresearch` replay template with your scripts. The
loop structure, crash recovery, and iteration caps are handled by
the template.
