# README Rewrite

## Problem

The current README has three issues:

1. **Stale terminology.** References to "check steps" after the
   refactoring to `verify_command` / `verify_files_exist`. Line 34
   says "Check steps run shell commands." Line 5 says "Agents act,
   Relay verify" which is also grammatically broken.

2. **No motivation.** The README jumps from tagline to install
   without explaining when or why to use relay. A reader who
   already has pi doesn't know why they'd want a workflow engine
   on top of it. The model's own summary nailed the pitch: "For
   tasks that require multiple actors, verification gates, or
   workflows where partial success is unacceptable."

3. **Missing core concepts.** The README shows templates (replay)
   but never explains how ad-hoc relay plans work. The four step
   kinds, routes as a map, and artifacts are not described. Someone
   who wants to write a custom template or understand what the
   model is doing has no reference.

## Design

Rewrite the README with these sections in order:

### 1. Title and tagline

Keep `pi-relay` as the title. Replace the tagline with something
that says what it does, not just what it sounds like:

> Multi-step workflows for pi — actors do the work, verification
> gates decide pass/fail.

Drop "Finite state machine workflows" — accurate but alienating.
Drop "Plan. Execute. Verify." — too generic.

### 2. What relay adds

A short paragraph before installation explaining what the extension
gives the assistant that it doesn't have out of the box.

Without relay, the assistant does everything in a single
conversation turn — edits files, runs commands, reads output. This
works for simple tasks. Relay lets the assistant break complex work
into a plan: multiple actors with different roles and tool sets,
deterministic verification gates (tests, linters, file checks),
and structured routing between steps. The assistant decides when a
task needs relay — the user just describes what they want.

This should be 3–4 sentences, framed as what the extension enables,
not as instructions for the user.

### 3. Installation

Keep as-is. `pi install` + manual alternative.

### 4. What you get

Explain the three user-facing surfaces:

- **`relay` tool** — the model builds and executes an ad-hoc plan
- **`replay` tool** — the model runs a saved template by name
- **`/relay` command** — interactive TUI to enable/disable actors
  and templates

One sentence each. This replaces the current "Two tools are added"
section and adds the `/relay` command which is currently not
mentioned until line 27.

### 5. How it works

Keep the existing numbered flow but fix terminology:

1. Model calls `relay` or `replay`
2. Plan compiled — validated
3. User reviews: Run / Refine / Cancel
4. Scheduler executes steps. Action steps spawn agent subprocesses.
   Verify steps run shell commands or check file existence — pass
   or fail, no interpretation.
5. Run report. `Ctrl+O` to expand.

### 6. Core concepts

New section. Brief descriptions of the building blocks, with
one example each:

**Step kinds:**
- `action` — LLM-backed. An actor runs with a restricted tool set
  and emits a route on completion.
- `verify_command` — deterministic. Runs a shell command, passes
  if exit 0.
- `verify_files_exist` — deterministic. Passes if all listed paths
  exist.
- `terminal` — ends the run with success or failure.

**Routes:** Each action step declares a map of route names to
target steps. The actor chooses which route to take. Verify steps
have fixed `onPass` / `onFail` routing.

**Artifacts:** Typed state passed between steps. A step declares
what it reads and writes. The runtime enforces the contracts.

**Back-edges:** Routes can point to earlier steps, creating loops.
The `maxRuns` field caps iterations to prevent runaway loops.

Show a minimal complete plan (the custom template example already
in the README works, but annotate it briefly).

### 7. Included templates

Keep the existing template gallery with mermaid diagrams. It's the
strongest part of the current README. Update the `autoresearch`
paragraph to mention it's an example of the loop/back-edge pattern.

### 8. Custom templates

Keep as-is. The example template is already updated to the new
schema.

### 9. Actors

Keep as-is. Add one sentence about the `/relay` command for
toggling actors.

### 10. Plan review

Keep as-is.

### 11. Development

Keep as-is.

### What to remove

- "Finite state machine workflows" from the tagline
- "Plan. Execute. Verify." — generic
- All references to "check steps"
- The duplicate "Use `/relay` to browse" on line 37 (already on
  line 27)
- "Agents act, Relay verify" — grammatically broken and unclear

### Tone

Match pi's README: direct, no hype, no emoji. Explain what the
thing does and how to use it. The template gallery speaks for
itself — the diagrams show the power without needing to sell it.

## What this does NOT cover

- **Architecture docs.** The README is user-facing, not developer-
  facing. Architecture lives in `architecture/*.md`.
- **API reference.** The TypeBox schema IS the API reference. The
  README should point to the schema descriptions, not duplicate
  them.
- **Changelog.** The refactoring changes (verify steps, routes map,
  removed retry/contextPolicy) are not called out as changes —
  the README describes the current state, not the history.
