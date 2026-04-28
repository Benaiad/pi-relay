# README Restructure: Implementation Plan

Reference: `architecture/README_RESTRUCTURE.md`

## What already exists

- **README.md** (465 lines): Logo, one-liner, install (extension +
  CLI), CLI reference (options, defaults, cwd, dry-run), extension
  preamble, topology table, how it works, core concepts, seven
  template entries, custom templates, actors, plan review, development,
  license.
- **No other documentation files** besides architecture docs and the
  autoresearch/pr-review sub-READMEs.
- Everything stays in one file. No extraction to `docs/`.

## Approach

Each step produces a valid README that reads correctly on its own.
No step leaves the document in a broken intermediate state. This means
content gets moved before it gets deleted — if something is relocating
from line 400 to line 20, step N copies it to the new location and
step N+1 removes the old location.

Prose that needs to be written fresh (the problem/promise opening) is
drafted in its own step so it can be reviewed independently from the
structural moves.

## Steps

### Step 1: Write the opening (beats 1-3)

Write the new problem/promise/proof opening and insert it after the
logo block, before the current "Two ways to use it" line. This is new
prose — the only section that requires writing rather than moving.

**After the logo and one-liner (line 10), insert:**

1. **The problem** (2-3 sentences). Name the pain of managing complex
   workflows manually with pi. Center on the reader's experience:
   running tests, pasting failures back, asking for fixes, re-checking.
   Do not describe relay's features yet.

2. **The promise** (1 sentence). "Relay lets you define the workflow
   once — steps, actors, verification gates, routing — and execute it
   reliably."

3. **One example.** The verified-edit mermaid diagram (copied from
   line 213-218) and a single invocation example (adapted from
   line 225-227). Minimal — diagram + invocation, no parameter table,
   no options.

Do not remove or modify any existing sections yet. The opening is
additive.

**Verify:** Read the README from the top. The new opening should feel
complete on its own — problem, promise, proof in one screen.

### Step 2: Add topology table and plan review after the example

Insert two new sections after the example from step 1:

1. **Topology table.** Copied from lines 128-137, but with the
   "Template" column stripped. Keep only "Topology" and "What it
   models." Add a one-line intro: "The same topology engine handles
   all of these:" (or similar — no hardcoded count).

2. **Plan review.** Two sentences absorbed from lines 445-450:
   "When a plan can modify files or run commands, you review it before
   execution — run, refine, or cancel. Read-only plans skip the review."

These are additive — the old topology table and plan review section
still exist lower in the document.

**Verify:** Read sections 2-6 (problem through plan review). They
should fit on one screen and tell the complete story: pain → promise →
proof → expansion → trust.

### Step 3: Write the getting-started sections

Insert two new sections after the plan review blurb:

**Getting started: extension (## heading)**
- `pi install` one-liner (from line 22-23)
- Manual/symlink alternative (from lines 25-33)
- The three tools/commands list: relay tool, replay tool, /relay
  command (from lines 140-143)
- One replay usage example (from lines 225-227 of verified-edit)

**Getting started: CLI (## heading)**

Quickstart first, then reference subsections. Everything in one file.

Quickstart:
- `npm install -g` one-liner (from lines 39-40)
- Peer deps note (from line 42)
- One `relay` invocation (from lines 49-50)
- "Designed for CI" note + GitHub Actions snippet (from lines 52-59)

Reference subsections (### headings under the CLI ##):
- **### Options** — the usage block and flag descriptions (from
  lines 62-76). This is the `relay <template.md> [-e key=value]...`
  block plus the model/thinking fallback explanation.
- **### Parameter defaults** — default declarations in template YAML,
  required vs. optional (from lines 78-93).
- **### Working directory** — `cwd` field in plans, `-e cwd=` usage
  (from lines 95-112).
- **### Dry run** — `--dry-run` flag, no API key needed (from
  lines 114-120).

The quickstart is the on-ramp for the narrative reader. The subsections
are reference for returning users who scan headers. Same content as
today, just repositioned below the quickstart instead of dominating
the middle of the document.

These are additive.

**Verify:** Follow the getting-started instructions from scratch.
Extension install path works. CLI install path works. CLI subsection
headers appear in GitHub's outline menu for scanners.

### Step 4: Write the merged "How it works" section

Insert a new "How it works" section after the getting-started sections.
This merges content from three current sections into one:

**Steps and routing** (from lines 155-173 of "Core concepts > Step
types" and lines 165-173 of "Core concepts > Routes"):
- Four step types: action, command, files_exist, terminal
- Route semantics: action steps declare route maps, command/files_exist
  use on_success/on_failure
- One explanation, one level of detail

**Command execution** (from line 409 of "Custom templates"):
- Shell backend: respects `shellPath`, defaults to `/bin/bash` on Unix,
  Git Bash on Windows
- Integer and boolean parameter coercion

**Artifacts** (from lines 176-199 of "Core concepts > Artifacts"):
- Structured state between steps
- Keep the `$RELAY_INPUT` / `$RELAY_OUTPUT` bash example
- Format, fields, list, validation, accumulation

**Loops** (from lines 201-203 of "Core concepts > Back-edges and
loops"):
- Routes can point to earlier steps
- `max_runs` caps iterations
- Failure reason flows into re-run prompt

This is additive — the old sections still exist.

**Verify:** Read the merged section. Each concept appears exactly once.
No overlap with any other section.

### Step 5: Restructure the templates section

Replace the current templates intro and reorganize:

1. **Replace the intro.** Change "Five templates ship with the
   extension, plus one example and one CI template" to a count-free
   sentence: "Relay ships with templates for common workflow
   topologies."

2. **verified-edit.** Brief reprise — skip the mermaid diagram (it
   already appeared in the opening), keep parameters and usage example.
   Reference the diagram above ("The simplest topology, shown above.")
   and jump straight to parameters.

3. **reviewed-edit.** Full treatment — keep mermaid diagram, parameters,
   usage example. This is the first template the reader sees in full
   detail with a review loop.

4. **Wrap remaining templates in `<details>` blocks:**

   ```markdown
   <details>
   <summary><strong>bug-fix</strong> — diagnosis before code changes</summary>

   [existing bug-fix content: mermaid + parameters + usage]

   </details>
   ```

   Apply to: bug-fix, multi-gate, debate, autoresearch, pr-review.

This step modifies the existing templates section in-place.

**Verify:** Render on GitHub. Expanded templates (verified-edit,
reviewed-edit) display normally. Collapsed templates show summary line,
expand on click. Mermaid diagrams render inside `<details>` blocks.

### Step 6: Remove old sections

Now that all content has been moved to its new location, remove the
old sections that are now duplicated:

1. **Remove "Two ways to use it"** (lines 10-15) — replaced by
   problem/promise.
2. **Remove "## Install" and both sub-sections** (lines 17-42) —
   replaced by getting-started sections.
3. **Remove "## CLI" and all sub-sections** (lines 44-120) — moved
   to getting-started: CLI (quickstart + reference subsections).
4. **Remove "## Extension"** (lines 122-143) — preamble became the
   opening, topology table moved to section 5, tools list moved to
   getting-started.
5. **Remove "## How it works"** (lines 144-151) — merged into new
   section.
6. **Remove "## Core concepts" and all sub-sections** (lines 153-203)
   — merged into new section.
7. **Remove "## Plan review"** (lines 444-451) — compressed into
   trust blurb after topology table.
8. **Remove shell backend note from "Custom templates"** (line 409) —
   moved to "How it works."
9. **Remove "## Included templates" intro paragraph** (lines 206-208)
   — replaced by count-free sentence.

**Verify:** Read the entire README top to bottom. No duplicated
content. No dangling references. No orphaned headers. Every internal
link resolves. Every mermaid diagram renders.

### Step 7: Polish and verify

Final pass:

1. **Check section headers** — consistent levels (`##` for major
   sections, `###` for sub-sections within getting-started and how-it-
   works).
2. **Check vertical rhythm** — appropriate blank lines between
   sections. No triple-blank-line gaps from removed content.
3. **Check the verified-edit dual appearance** — the opening has the
   diagram + invocation; the templates section has a brief note
   referencing it plus the parameters table. No full duplication.
4. **Check all links** — `examples/autoresearch/`, `bundled/ci/`,
   `bundled/ci/README.md` all resolve.
5. **Check `<details>` rendering** — view on GitHub, confirm expand/
   collapse works, mermaid renders inside.
6. **Read as a first-time visitor** — start from the logo. Does the
   emotional arc land? Problem → promise → proof → expansion → trust →
   on-ramp → understanding → depth → ownership. If any beat feels
   missing or misplaced, adjust.
7. **Read as a returning user** — scan for the install command, the
   CLI usage, the template parameters. Can a returning user find what
   they need by scanning headers? GitHub's outline menu should show
   a logical hierarchy.

**Verify:** Full read-through. No broken rendering. Narrative arc
is intact.

## Dependency graph

```
Step 1 (opening)           ← independent
Step 2 (topology + trust)  ← depends on 1 (inserted after opening)
Step 3 (getting started)   ← depends on 2 (inserted after trust)
Step 4 (how it works)      ← depends on 3 (inserted after getting started)
Step 5 (templates)         ← independent (modifies existing section in-place)
Step 6 (remove old)        ← depends on 1, 2, 3, 4, 5 (all new content in place)
Step 7 (polish)            ← depends on 6
```

Steps 1 and 5 are independent and can be done in any order.
Steps 2-4 are sequential (each inserts after the previous).
Step 6 is the gate — nothing gets removed until everything is in
its new home. Step 7 is the final pass.

## Content inventory

Every piece of current content and where it goes:

| Current content | Current lines | New location |
|----------------|---------------|--------------|
| Logo + one-liner | 1-10 | Section 1 (unchanged) |
| "Two ways to use it" | 10-15 | Deleted (replaced by opening) |
| `pi install` one-liner | 22-23 | Getting started: extension |
| Manual/symlink install | 25-33 | Getting started: extension |
| `npm install -g` CLI | 39-40 | Getting started: CLI (quickstart) |
| Peer deps note | 42 | Getting started: CLI (quickstart) |
| CLI intro + example | 46-50 | Getting started: CLI (quickstart) |
| "Designed for CI" + GH Actions | 52-59 | Getting started: CLI (quickstart) |
| CLI options block | 62-76 | Getting started: CLI → ### Options |
| Parameter defaults | 78-93 | Getting started: CLI → ### Parameter defaults |
| Working directory | 95-112 | Getting started: CLI → ### Working directory |
| Dry run | 114-120 | Getting started: CLI → ### Dry run |
| Extension preamble | 124-127 | Rewritten as opening (beats 1-2) |
| Topology table | 128-137 | After opening (template name column stripped) |
| Tools/commands list | 140-143 | Getting started: extension |
| How it works (numbered list) | 144-151 | Merged into "How it works" |
| Step types | 155-162 | Merged into "How it works" |
| Routes | 164-173 | Merged into "How it works" |
| Artifacts | 175-199 | Merged into "How it works" |
| Back-edges and loops | 201-203 | Merged into "How it works" |
| "Included templates" intro | 206-208 | Replaced with count-free sentence |
| verified-edit (diagram) | 213-218 | Opening (beat 3) + brief reference in templates |
| verified-edit (params + usage) | 220-227 | Templates section |
| reviewed-edit (full) | 229-271 | Templates section (expanded) |
| bug-fix (full) | 273-297 | Templates section (collapsed) |
| multi-gate (full) | 299-331 | Templates section (collapsed) |
| debate (full) | 333-360 | Templates section (collapsed) |
| autoresearch (full) | 362-377 | Templates section (collapsed) |
| pr-review (full) | 379-407 | Templates section (collapsed) |
| Custom templates | 409-441 | Keep (remove shell backend note) |
| Shell backend note | 409 | "How it works" under command execution |
| Actors | 443-472 | Keep (unchanged) |
| Plan review | 474-482 | Compressed to 2 sentences after topology table |
| Development | 484-491 | Keep (unchanged) |
| License | 493-495 | Keep (unchanged) |

## Risks

1. **Mermaid inside `<details>` blocks.** GitHub renders mermaid in
   details blocks, but this should be verified on the first collapsed
   template before wrapping all five.

2. **Line number drift.** Steps 1-4 are additive insertions that shift
   line numbers. Step 6 references "old sections" by content, not by
   line number. Each step should identify content by header text or
   unique strings, not by line offsets.

3. **Opening prose quality.** Step 1 is the only step that requires
   writing new prose. If the problem/promise text doesn't land, the
   entire narrative arc fails. This step deserves the most review
   attention.

4. **Verified-edit appearing twice.** The diagram is in the opening
   (beat 3) and referenced in the templates section (beat 8). The
   templates section should NOT repeat the diagram — instead, use a
   one-line reference ("The simplest topology, shown above") and jump
   to parameters. If it repeats, the reader feels the README is
   padded.

5. **CLI reference length under getting-started.** The four CLI
   subsections (Options, Parameter defaults, Working directory, Dry
   run) add ~60 lines under "Getting started: CLI." This is acceptable
   because they come after the quickstart — the narrative reader has
   already moved on, and the reference reader finds them via headers.
   But if the section feels too heavy during the polish step, consider
   wrapping the four subsections in a single `<details>` block:
   `<summary>CLI reference</summary>`.
