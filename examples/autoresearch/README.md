# Autoresearch with Relay

An autonomous optimization loop: the agent modifies `optimize.js`,
the runtime benchmarks it and compares to the previous best. If
faster, keep. If not, revert. Repeat.

The key insight: the **evaluation is deterministic**. The agent
proposes changes; `benchmark.js` measures time; `evaluate.js`
compares to the best and decides keep/revert. The agent cannot lie
about whether the metric improved.

## Files

- `optimize.js` — the function the agent modifies (starts as naive trial division)
- `benchmark.js` — runs `findPrimes(50000)` three times, takes best time, verifies correctness (DO NOT MODIFY)
- `evaluate.js` — compares `result.json` to `best.json`, keeps or reverts (DO NOT MODIFY)

## Running

From this directory, ask pi to use relay:

```
Optimize the findPrimes function in optimize.js for speed. Use the relay
tool with this structure:

- experiment (action, worker, maxRuns: 15): read optimize.js and best.json,
  try a faster algorithm, edit optimize.js
- benchmark (check): node benchmark.js
- evaluate (check): node evaluate.js
- recover (action, worker): restore optimize.js from optimize.best.js
- route: experiment → benchmark → evaluate
  - evaluate pass → experiment (loop)
  - evaluate fail → experiment (loop, evaluate already reverted)
  - benchmark fail → recover → experiment
```

The agent will iterate, trying progressively better algorithms
(e.g., trial division → sqrt optimization → sieve of Eratosthenes).
Each iteration takes a few seconds. The `maxRuns` cap stops the loop
after 15 experiments.
