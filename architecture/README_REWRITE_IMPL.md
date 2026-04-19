# README Rewrite — Implementation Plan

Implements [README_REWRITE.md](./README_REWRITE.md).

## Current state

The README has 274 lines across 12 sections. The template gallery
(lines 39–170) is strong and stays mostly intact. The problems are
in the framing (lines 1–37) and missing concepts.

## Changes by section

### 1. Title block (lines 1–5) — rewrite

**Delete:**
- "Plan. Execute. Verify." (generic)
- "Finite state machine workflows for pi. Agents act, Relay verify."
  (jargon + grammar)

**Replace with:**
```markdown
# pi-relay

Multi-step workflows for [pi](https://pi.dev/) — actors do the
work, verification gates decide pass/fail.
```

One line that says what it does. No tagline poetry.

### 2. New section: what relay adds — insert after install

Insert a short paragraph between the install block and the "what
you get" section. Framed as what the extension gives the assistant:

> Without relay, the assistant handles everything in a single
> conversation turn. Relay lets it break complex work into a plan
> with multiple actors, verification gates, and structured routing.
> The assistant decides when a task needs relay — you just describe
> what you want.

3–4 sentences. Not a features list.

### 3. "Two tools are added" (lines 22–27) — rewrite as "What you get"

Expand to cover all three user-facing surfaces:

- **`relay` tool** — the assistant builds an ad-hoc plan
- **`replay` tool** — the assistant runs a saved template by name
- **`/relay` command** — interactive TUI to browse, enable, and
  disable actors and templates

The current text omits `/relay` as a management command and only
mentions it as "browse." It also duplicates the `/relay` mention
on line 37.

### 4. "How it works" (lines 29–36) — fix terminology

Line 34: "Check steps run shell commands and route on exit code"
→ "Verify steps run shell commands or check file existence and
route on the outcome — pass or fail, no interpretation."

Delete line 37 (duplicate `/relay` mention).

### 5. New section: core concepts — insert before templates

Brief descriptions of the four step kinds, routes, and artifacts.
No schema dumps — just enough for someone reading a template or a
relay plan to understand the vocabulary.

**Step kinds:**
- `action` — an actor (LLM agent) runs with a restricted tool set
  and emits a route on completion.
- `verify_command` — runs a shell command. Pass if exit 0.
- `verify_files_exist` — checks that all listed paths exist.
- `terminal` — ends the run with success or failure.

**Routes:** Action steps declare a map of route names to target
steps: `routes: { done: "verify", failure: "failed" }`. The actor
chooses which route to emit. Verify steps route via fixed
`onPass` / `onFail` fields.

**Artifacts:** Structured state passed between steps. Declared at
the plan level, read and written by action steps. The runtime
enforces that only declared writers commit values.

Each concept gets 1–2 sentences. The custom template example
(already in the README) serves as the full worked example — no
need to duplicate it here.

### 6. Included templates (lines 39–170) — minor fixes

- Opening paragraph (line 41): keep as-is.
- `autoresearch` paragraph (line 158): mention it demonstrates the
  back-edge loop pattern with `maxRuns` for iteration capping.
- No changes to mermaid diagrams or parameter lists.

### 7. Custom templates (lines 172–220) — keep

Already updated to the current schema (`verify_command`, map
routes). No changes needed.

### 8. Actors (lines 222–251) — minor addition

Add one sentence at the end: "Use `/relay` to toggle actors on or
off — disabling an actor automatically disables templates that
use it."

### 9. Plan review (lines 253–261) — keep

No changes.

### 10. Development (lines 263–269) — keep

No changes.

## Section order in the new README

```
# pi-relay                        (rewritten title + subtitle)
  Install block                   (unchanged)
  What relay adds                 (NEW — 1 paragraph)
  What you get                    (rewritten — 3 bullets)
## How it works                   (fixed terminology)
## Core concepts                  (NEW — step kinds, routes, artifacts)
## Included templates             (unchanged, minor autoresearch tweak)
## Custom templates               (unchanged)
## Actors                         (minor /relay addition)
## Plan review                    (unchanged)
## Development                    (unchanged)
## License                        (unchanged)
```

## Implementation

This is a single-file rewrite. Write the new README.md in one
pass, verify no broken links or stale references, commit.

### Step 1: Write the new README

Full rewrite of README.md following the section plan above. Carry
forward all mermaid diagrams, code blocks, and template examples
unchanged. Rewrite the framing sections (title, motivation, what
you get, how it works). Insert the core concepts section. Apply
the minor fixes to actors and autoresearch.

### Step 2: Verify

- Check all internal links (`examples/autoresearch/` etc.)
- Grep for stale terms: "check step", "CheckStep", "CheckSpec",
  "retry", "contextPolicy", "FSM", "finite state"
- Confirm the custom template example matches the current schema

### Step 3: Commit

```
docs: rewrite README for current schema and concepts

- Replace tagline and motivation
- Add "what relay adds" and "core concepts" sections
- Fix check → verify terminology throughout
- Document /relay command for actor/template management
- Remove duplicate /relay mention
```
