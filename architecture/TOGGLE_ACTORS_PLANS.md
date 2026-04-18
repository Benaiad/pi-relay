# Toggle Actors and Plans

## Problem

Users cannot disable bundled actors or plan templates without
deleting files from the installed package or creating empty shadow
overrides. The `/relay` command is read-only — it lists what's
available but offers no way to configure it.

A user who never uses the debate workflow still sees `advocate`,
`critic`, `judge`, and `debate` in every tool description, wasting
model context and creating noise.

## User experience

`/relay` becomes an interactive settings screen. Each actor and plan
template appears as a toggleable row. Arrow keys navigate, space or
enter cycles between `enabled` and `disabled`. Esc closes and
persists.

```
Relay

▸ worker (bundled)              enabled
  reviewer (bundled)            enabled
  critic (bundled)              disabled
  advocate (bundled)            disabled
  judge (bundled)               disabled
  ─────────────────
  verified-edit (bundled)       enabled
  bug-fix (bundled)             enabled
  reviewed-edit (bundled)       enabled
  multi-gate (bundled)          enabled
  debate (bundled)              disabled
  autoresearch (user)           enabled

  ↑↓ navigate · Space toggle · Esc close
```

Changes take effect on the next tool invocation. Tool descriptions
are rebuilt on `/reload` as before — but now they exclude disabled
items. A disabled actor that appears in a plan template causes a
compile error at execution time, which is the correct behavior: the
user chose to disable it.

## Data model

A config file at `~/.pi/agent/pi-relay/config.json`:

```json
{
  "disabledActors": ["critic", "advocate", "judge"],
  "disabledPlans": ["debate"]
}
```

Deny-list, not allow-list. Everything is enabled by default. The
file is created on first toggle. If the file doesn't exist or is
empty, nothing is disabled.

Why deny-list: new bundled actors and plans added in future releases
are automatically available. An allow-list would silently hide new
additions until the user discovers and enables them.

## How it works

1. **Discovery unchanged.** `discoverActors` and
   `discoverPlanTemplates` continue to scan all three tiers and
   return everything. No filtering at the discovery level.

2. **Config loading.** A new module `src/config.ts` reads and writes
   `~/.pi/agent/pi-relay/config.json`. Exports:
   - `loadRelayConfig(agentDir): RelayConfig`
   - `saveRelayConfig(agentDir, config): void`
   - `isActorEnabled(config, name): boolean`
   - `isPlanEnabled(config, name): boolean`

3. **Filtering at use sites.** The extension entry point and tool
   execute handlers filter discovery results through the config
   before building tool descriptions or passing to the compiler.
   Discovery returns all; config decides what's active.

4. **`/relay` command.** Renders a `SettingsList` from pi-tui.
   Each actor and plan template becomes a `SettingItem` with
   `values: ["enabled", "disabled"]`. The `onChange` callback
   updates the in-memory config and writes it to disk.

5. **Tool descriptions.** Built from filtered actor/template lists.
   Disabled items don't appear in what the model sees.

## Scope

**In scope:**
- User-scope config at `~/.pi/agent/pi-relay/config.json`
- Interactive toggle UI in `/relay`
- Filtering in tool descriptions and execution

**Out of scope:**
- Project-scope config (`<cwd>/.pi/pi-relay/config.json`). Can be
  added later with the same deny-list pattern.
- Per-step enable/disable. This is about which actors and plans
  exist, not about plan structure.
- Disabling individual steps within a plan template.

## Error paths

- Config file doesn't exist: everything enabled. No error.
- Config file is malformed JSON: log a warning, treat as empty.
  Don't crash extension load.
- Config file lists a name that doesn't match any actor/plan:
  ignored silently. Stale entries are harmless.
- All actors disabled: relay tool description says "no actors
  installed" with the path hint. Model cannot build plans.
- All plans disabled: replay tool description says "no plans
  installed." Model cannot replay.
- Disabled actor referenced by an enabled plan: compile error at
  execution time. Correct behavior — the user made a choice.
- File write fails (permissions, disk full): log warning, don't
  crash. The toggle visually reverts on next open.

## What this does NOT cover

- Migration from old config formats. There is no old format.
- Syncing config across machines. Out of scope.
- Enabling/disabling actors per-project. Future work.
