# README Patterns Section — Implementation Plan

## What this adds

Two additions to the README, both between the current intro paragraph
and the "How it works" section:

1. A one-sentence framing of what relay encodes.
2. A "Workflow patterns" table mapping topologies to real processes.

## Why

The README explains mechanics (step kinds, routes, artifacts) and
ships five templates. A user who reads it understands HOW relay works
but has to infer WHEN to reach for it. The pattern table bridges that
gap — it helps users pattern-match their task to a topology without
reading every template description.

The framing sentence primes the reader: relay encodes process, not
domain knowledge. This sets expectations correctly before diving into
concepts and templates.

## What the user sees

After the intro paragraph ("Without relay, the assistant handles
everything in a single conversation turn...") and before "Three
things are added to pi:", insert:

```markdown
Relay encodes *process* — how steps connect, where verification
happens, when to loop — not domain knowledge. The same template works
across projects because the workflow topology is independent of what's
being built.

**Workflow patterns**

| Topology | What it models | Template |
|----------|---------------|----------|
| act → verify | Gated commit | verified-edit |
| diagnose → fix → verify | Root cause analysis | bug-fix |
| act → review → fix ↺ | Iterative QA | reviewed-edit |
| act → gate₁ → gate₂ → gate₃ | Sequential checks | multi-gate |
| argue → challenge → judge ↺ | Structured debate | debate |
| propose → benchmark → evaluate ↺ | Optimization loop | autoresearch |
```

The ↺ glyph marks topologies with back-edges (loops). The Template
column links each pattern to an existing bundled template, making
the table double as a navigation aid for the template gallery below.

## Placement

The order becomes:

1. Title + tagline
2. Install
3. Intro paragraph (existing)
4. **Framing sentence (new)**
5. **Pattern table (new)**
6. Three tools list (existing)
7. How it works
8. Core concepts
9. ...everything else unchanged

The framing + table sit between "here's what relay does for you"
(the intro) and "here's what it adds to pi" (the tools list). This
is the natural place for "here's when you'd want it."

## What NOT to add

- No "meta-programming paradigm" framing. Accurate but intimidating
  for users who want to run tests after code changes.
- No "Turing completeness" or "limitless" claims. The patterns table
  communicates breadth concretely.
- No "five primitives" enumeration. The core concepts section already
  covers this; duplicating it higher up adds noise.
- No philosophy section. One sentence of framing is enough. The
  templates speak for themselves.

## Implementation

Single commit. Edit `README.md`:

1. After the paragraph ending "you just describe what you want."
   and before "Three things are added to pi:", insert a blank line,
   the framing sentence, a blank line, the pattern table, and a
   blank line.

2. Verify the markdown renders correctly (table alignment, ↺ glyph,
   italic on *process*).

**Commit:** `docs: add workflow patterns table and framing sentence to README`
