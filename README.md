# pi-relay

Graph-based planning and execution for the [pi coding agent](https://github.com/badlogic/pi-mono).

The pi assistant decides whether a task is simple enough for direct tool
calls or complex enough to delegate to Relay. When it delegates, it produces
a structured plan as the arguments of a single `relay` tool call. Relay
compiles the plan into a validated executable program, runs it as a DAG of
typed action, check, and terminal steps, and returns a structured run report.

> Status: v0.1 in development. See `architecture/RELAY_PI.md` for the design
> and `architecture/RELAY_PI_IMPL.md` for the implementation plan.

## Why

Pi today handles single-step and short multi-step tasks well. It struggles
with workflows that need:

- **Deterministic verification gates.** Tests must pass before commit, and
  the runtime — not the model's interpretation of test output — decides.
- **Typed artifacts between steps.** A planner's output reaches the
  implementer in a known shape, not a paraphrased transcript.
- **Audit and replay.** A run is a structured event log keyed by step,
  route, artifact, and retry attempt.

Relay is a specialist tool. Most pi sessions will not invoke it. The model
should call `relay` only for tasks with at least one of: multiple actors,
verification gates, parallel work that needs joining, or workflows where
partial success is unacceptable.

## Install (development)

```bash
git clone https://github.com/badlogic/pi-relay.git ~/repos/pi-relay
cd ~/repos/pi-relay
npm install

# Symlink as a pi extension
mkdir -p ~/.pi/agent/extensions/relay
ln -sf "$(pwd)/src/index.ts" ~/.pi/agent/extensions/relay/index.ts
ln -sf "$(pwd)/src" ~/.pi/agent/extensions/relay/src

# Drop a sample actor file into pi's actor directory
mkdir -p ~/.pi/agent/relay-actors
ln -sf "$(pwd)/actors/worker.md" ~/.pi/agent/relay-actors/worker.md
```

Then launch pi as usual. The model will see the `relay` tool in its tool list.

## Limitations (v0.1)

- Sequential execution only. Parallelism and `Join` steps land in v0.2.
- Only `FreshPerRun` context policy. Per-step and per-actor caching land
  in v0.2.
- Untyped JSON artifacts only. Named TypeBox shapes land in v0.2.
- TUI rendering only. The pi-mono web UI does not expose extension renderer
  hooks; web users see a generic tool result.

## Development

```bash
npm run check    # tsc --noEmit + biome
npm run test     # vitest
npm run format   # biome format --write
```

## License

MIT
