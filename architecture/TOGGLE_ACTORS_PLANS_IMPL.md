# Toggle Actors and Plans — Implementation

Implements the design in `TOGGLE_ACTORS_PLANS.md`.

## What already exists

- `src/actors/discovery.ts` — scans bundled, user, and project dirs
  for actor `.md` files. Returns `ActorDiscovery` with all found
  actors. No filtering concept.
- `src/templates/discovery.ts` — same pattern for plan templates.
  Returns `TemplateDiscovery`.
- `src/index.ts` — extension entry. Calls `discoverActors` and
  `discoverPlanTemplates` at load time to build tool descriptions.
  Calls them again per-execution to pick up edits. Registers the
  `/relay` command as a read-only markdown viewer using
  `ctx.ui.custom` with `Container`, `DynamicBorder`, `Markdown`.
- `src/replay.ts` — registers the `replay` tool. Rediscovers
  actors and templates per-execution.
- Pi exports `SettingsList`, `getSettingsListTheme` from
  `@mariozechner/pi-coding-agent`. `SettingsList` takes items with
  `values: string[]` and cycles through them on Space/Enter. Pi's
  own `/settings` screen uses this component for boolean toggles
  with `values: ["true", "false"]`.

## Architecture decisions

**Config lives beside the user-scope discovery directory.** The
config file is `~/.pi/agent/pi-relay/config.json`, alongside the
user's custom actors and plans in `~/.pi/agent/pi-relay/actors/`
and `~/.pi/agent/pi-relay/plans/`. This keeps all pi-relay user
data in one place. The path is derived from `getAgentDir()` — no
hardcoded home directory.

**Filtering is a separate step, not embedded in discovery.**
Discovery returns everything. A pure function filters by config.
This keeps discovery testable without config, and makes the filter
logic independently testable.

**Config is loaded once per entry point, not per-discovery.** The
extension load, each tool execution, and the `/relay` command each
load config once and pass the filtered results through. Discovery
itself never reads the config file.

**`SettingsList` replaces `Markdown` in `/relay`.** The current
command renders a markdown overview via `ctx.ui.custom`. The new
implementation replaces the `Markdown` component with a
`SettingsList`. The `DynamicBorder` + title pattern stays the same.

## Data flow

```
config.json ──→ loadRelayConfig() ──→ RelayConfig
                                          │
discoverActors() ──→ ActorDiscovery ──────┤
                                          ├──→ filterActors() ──→ enabled actors
discoverPlanTemplates() ──→ TemplateDisc ─┤
                                          └──→ filterPlans()  ──→ enabled plans
```

At extension load: enabled actors/plans build tool descriptions.
At execution: enabled actors are passed to the compiler.
At `/relay`: all actors/plans shown with current enabled/disabled
state; toggles write back to config.json.

## File changes

### New: `src/config.ts`

Config module. Reads and writes `~/.pi/agent/pi-relay/config.json`.

Types:
```ts
interface RelayConfig {
  readonly disabledActors: ReadonlySet<string>;
  readonly disabledPlans: ReadonlySet<string>;
}
```

Functions:
- `loadRelayConfig(): RelayConfig` — reads the config file from
  `getAgentDir()/pi-relay/config.json`. Returns empty sets if the
  file doesn't exist or is malformed. Logs a warning on parse error.
- `saveRelayConfig(config: RelayConfig): void` — writes the config
  file. Creates the directory if needed. Converts sets to sorted
  arrays for stable JSON output.
- `filterActors(actors: readonly ActorConfig[], config: RelayConfig): readonly ActorConfig[]`
  — returns actors whose names are not in `disabledActors`.
- `filterPlans(templates: readonly PlanTemplate[], config: RelayConfig): readonly PlanTemplate[]`
  — returns templates whose names are not in `disabledPlans`.

The file uses named fs imports (`readFileSync`, `writeFileSync`,
`existsSync`, `mkdirSync`) and named path imports (`join`,
`dirname`) matching the codebase convention.

### Modified: `src/index.ts`

1. Import `loadRelayConfig`, `filterActors`, `filterPlans`,
   `saveRelayConfig` from `./config.js`.
2. At extension load: load config, filter discovery results before
   building tool descriptions and passing to `registerReplayTool`.
3. In `relay` tool execute: load config, filter actors before
   passing to `executePlan`.
4. Replace `/relay` command handler: swap `Markdown` for
   `SettingsList`. Build `SettingItem[]` from all discovered
   actors and templates with `values: ["enabled", "disabled"]`
   and `currentValue` derived from config. On `onChange`: update
   config in memory and call `saveRelayConfig`. On `onCancel`:
   call `done(undefined)`.
5. Remove `formatRelayOverview` — no longer needed.
6. Remove `Markdown` and `getMarkdownTheme` imports if no longer
   used elsewhere.

### Modified: `src/replay.ts`

1. Import `loadRelayConfig`, `filterActors`, `filterPlans`.
2. In `replay` tool execute: load config, filter actors before
   passing to `executePlan`, filter templates before searching
   for the requested template name.

### New: `test/config.test.ts`

Tests for `loadRelayConfig`, `saveRelayConfig`, `filterActors`,
`filterPlans`:

- Empty/missing file returns empty sets.
- Malformed JSON returns empty sets (no throw).
- Round-trip: save then load preserves values.
- `filterActors` excludes disabled names.
- `filterPlans` excludes disabled names.
- Stale names in config (no matching actor) are harmless.
- Config with only `disabledActors` (no `disabledPlans` key)
  works.

## Step-by-step plan

Each step produces a compiling, testable increment.

### Step 1: `src/config.ts` + tests

Create the config module with all four functions. Write tests.
Verify: `vitest run test/config.test.ts`, `biome check src/config.ts`.

### Step 2: Wire config into `src/index.ts` and `src/replay.ts`

Load config at each entry point. Filter discovery results before
use. The `/relay` command still renders the old markdown view —
UI change comes next. Verify: full test suite passes, tool
descriptions exclude disabled items.

### Step 3: Replace `/relay` command with `SettingsList`

Swap the markdown viewer for an interactive `SettingsList`. Each
actor and template is a `SettingItem` with
`values: ["enabled", "disabled"]`. Separator between actors and
plans via a disabled/non-interactive item or by using description
text. `onChange` persists to config. Remove `formatRelayOverview`
and unused imports. Verify: `biome check`, test suite, manual TUI
test.

## Risks

**`SettingsList` separator.** The component may not support visual
separators between groups (actors vs plans). Mitigation: use a
naming convention like `── Plans ──` as a non-toggleable item, or
prefix labels with section (`actor: worker`, `plan: verified-edit`).
Verify by reading the `SettingsList` render code before building.

**Config file race.** If two pi sessions toggle simultaneously, the
last writer wins. Acceptable for user-scope config — same behavior
as pi's own `settings.json`. No locking needed.
