# README Restructure

## What this is

A restructuring of the pi-relay README to fix the narrative split
introduced when CLI sections were added. The current README interleaves
two audiences (extension users and CLI users) in a way that makes both
experiences worse. The fix is structural, not cosmetic — reorder
sections, extract reference material, and lead with the concept instead
of the install.

## What it's not

- Not a rewrite of the content. The existing prose, YAML examples,
  mermaid diagrams, and template catalog are good. The problem is
  sequencing and weight, not substance.
- Not a branding exercise. Logo, one-liner, and project identity stay
  as-is.
- Not a documentation site. The goal is a single README that works,
  with one extracted reference file for CLI details.

## Problems with the current README

### 1. The reader encounters the extension/CLI fork twice

The install section splits into "Pi extension (interactive)" and
"CLI (headless / CI)." Then the next two major sections are "CLI" and
"Extension" — the same fork again. The reader has to re-orient twice.

### 2. CLI reference material dominates the middle

The CLI section (lines 45-120) is a 75-line deep dive into options,
parameter defaults, working directory configuration, and dry-run
behavior. This is reference documentation sitting in the middle of a
narrative document. By the time the reader reaches "Extension" on
line 122, they've lost the thread.

### 3. The concept comes too late

The topology table — the single most compelling thing in the README —
is buried on line 128, after 127 lines of install instructions and CLI
flags. A reader who skims the first screen sees `npm install` and
`cargo fmt`, not "break complex tasks into steps with actors, commands,
and loops."

### 4. "How it works" and "Core concepts" overlap

"How it works" says "action steps run isolated agent sessions." Then
"Core concepts > Step types" re-explains action steps in more detail.
The reader gets the same information twice at different levels of
specificity, in separate sections.

### 5. Template catalog is valuable but long

Seven templates with mermaid diagrams, parameter lists, and usage
examples make the README scroll-heavy. The first two (verified-edit,
reviewed-edit) cover 80% of use cases. The rest are important for
discoverability but shouldn't have equal visual weight.

### 6. Fragile template count in prose

Line 207: "Five templates ship with the extension, plus one example
and one CI template." This sentence rots every time a template is
added or removed. Hardcoded counts in prose are a maintenance trap.

### 7. Plan review is stranded

"Plan review" is its own section (lines 444-451) but it's actually
step 3 of the execution flow — the user reviews the plan, then the
scheduler runs it. Keeping it as a standalone section repeats the
fragmentation the restructure is trying to fix. It belongs inside
"How it works."

### 8. Shell backend note is misplaced

Line 409: "Commands run through pi's shell backend (respects
`shellPath` in settings...)" is an important operational detail about
command step execution, currently wedged into the "Custom templates"
section. It belongs with the command step type documentation, not
template authoring instructions.

## Design

### The reader's journey

A README is not a reference manual. It's a guided path from "what is
this?" to "I'm using it." Every section exists to move the reader to
the next emotional and cognitive state. If a section doesn't advance
that journey, it's in the wrong place or shouldn't exist.

Here is the journey, step by step.

---

**Beat 1: Recognition — "I've hit this wall."**

The reader is a pi user. They're productive with single-turn tasks.
But they've hit the ceiling: complex work that requires multiple
steps, verification between steps, iteration when things fail. They
manage this workflow manually — running tests, pasting results back,
asking for fixes, checking again. They may not have words for the
problem, but they feel it.

The opening (right after the logo and one-liner) names this pain in
their language. Not "relay is a workflow engine" — that's the tool's
self-description, not the reader's experience. Instead: "Without relay,
pi handles everything in a single turn. For simple tasks, that works.
For complex work — refactoring with verification, multi-step fixes,
iterative review — you end up managing the workflow yourself."

This is the *problem statement as mirror*. The reader should nod
before they learn what relay is. Two or three sentences. No features,
no architecture, no install commands. Just the pain.

**Why this works:** People don't search for tools. They search for
solutions to problems they already have. If the first thing the reader
sees is a description of relay's features, they have to do the mental
work of mapping features to their problem. If the first thing they see
is their problem described back to them, the tool has already earned
their attention.

---

**Beat 2: Promise — "There's a better way."**

Immediately after naming the pain, one sentence that reframes it:
"Relay lets you define the workflow once — steps, actors, verification
gates, routing — and execute it reliably."

This is the *thesis statement*. It doesn't explain how. It promises
that a solution exists and gives the reader just enough shape to
imagine it. The words "steps," "actors," "verification gates," and
"routing" are deliberately chosen — they're concrete enough to suggest
a model without requiring explanation yet.

**Why this works:** The promise creates a gap between "I have this
problem" and "apparently there's a solution" that pulls the reader
forward. They don't need to understand the model yet. They just need
to believe it's worth reading the next 30 seconds.

---

**Beat 3: Proof — "Show me."**

This is where the current design doc was wrong. It placed the topology
table here — a grid of abstract arrows between undefined terms. That's
information, not proof. The reader doesn't know what "act → verify"
means yet. Arrows between words they haven't learned are wallpaper.

Instead: **one concrete example.** The verified-edit template. The
simplest useful case. Show the mermaid diagram (three nodes — implement,
verify, done/failed) and a single invocation:

```
Use relay with the verified-edit template:
  task: Add input validation to the signup handler
  verify: npm test
```

That's it. The reader sees: there's a worker that does the task, a
verification step that runs tests, and the outcome is pass or fail.
The diagram is small enough to absorb in one glance. The invocation
is one line. The entire concept of relay — actors doing work, commands
checking results, routing based on outcomes — is demonstrated without
being explained.

**Why this works:** Concrete before abstract. The reader needs to
*see one working instance* before they can appreciate the general
model. A single example does more cognitive work than any amount of
explanation. It also sets the baseline: "at minimum, relay does this."
Everything after is expansion.

---

**Beat 4: Expansion — "It does ALL of these?"**

Now the topology table. The reader has seen verified-edit. They
understand what a topology is — a shape of steps connected by routes.
Now each row in the table is a variation on something they already
grasp:

| Topology | What it models |
|----------|---------------|
| act → verify | Gated commit |
| diagnose → fix → verify | Root cause analysis |
| act → review → fix ↺ | Iterative QA |
| act → gate₁ → gate₂ → gate₃ | Sequential checks |
| argue → challenge → judge ↺ | Structured debate |
| propose → benchmark → evaluate ↺ | Optimization loop |
| review → post → fix → verify | AI code review (CI) |

**This is the "click" moment.** The reader goes from "oh, it can do
a gated commit" to "oh, it's a general workflow engine and all of these
are just different topologies." Each row after the first is a
revelation, not information. The ↺ loops especially — the reader
realizes this isn't just a linear pipeline, it handles iteration.

Strip the template name column from the table. The names (verified-edit,
bug-fix, etc.) are forward references that add noise. The topology and
what-it-models columns are self-explanatory. Template names appear
later in the templates section where they have context.

**Why this works:** The table is a *payoff*, not an *opener*. It
rewards the reader for understanding the verified-edit example by
showing them the full landscape. This is the narrative technique of
*the door that opens onto a larger world* — you show one room, then
reveal it's part of a mansion. If you show the mansion first, every
room looks the same.

---

**Beat 5: Trust — "I'm in control."**

After the expansion, the reader is excited but may have a concern:
"This runs AI agents that modify my code. How do I stay in control?"

This is where plan review belongs — not as a standalone section buried
at line 444, but as a brief reassurance right after the topology table.
Two sentences: when a plan can modify files or run commands, pi shows
a review dialog. You choose run, refine, or cancel. Read-only plans
skip the dialog.

**Why this works:** Objection handling. Every persuasive narrative
anticipates the reader's resistance and addresses it before it
solidifies. The reader was just shown a powerful tool. The natural
next thought is "but what if it does something I don't want?" Answer
it immediately, then move on.

---

**Beat 6: On-ramp — "Let me try it."**

Now the reader wants to use relay. NOW install instructions matter.
Not before. The current README puts install at line 17 — before the
reader knows what they're installing or why. That's an FAQ structure
(people who already know come to copy the command), not a narrative
structure (people who are learning decide to install).

Two parallel getting-started sections:

**Extension (interactive):** `pi install` one-liner, manual/symlink
alternative, the three tools/commands list (relay tool, replay tool,
/relay command), and one replay example. The tools list belongs here
because it's extension-specific interface — not in the concept
section.

**CLI (headless / CI):** `npm install -g` one-liner, one `relay`
command, and the GitHub Actions snippet. Link to `docs/cli.md` for
the full options reference. That's 15 lines, not 75.

**Why this works:** The reader has been *convinced* and now needs to
be *enabled*. Install instructions serve a convinced reader. They
frustrate an unconvinced one. The current README tries to enable
before it convinces, which is why the CLI section feels like it
dominates — the reader hasn't decided to care yet, and they're
already reading about `--thinking` flags.

---

**Beat 7: Understanding — "Now I see how it works."**

The reader has installed relay, maybe run their first plan. Now they
want to understand the model. This is where "How it works" belongs —
after the reader has experience, not before.

Merge the current "How it works," "Core concepts," and the shell
backend note into a single section:

- **Steps and routing** — the four step types (action, command,
  files_exist, terminal), how routes connect them, how action steps
  choose routes vs. command steps using on_success/on_failure.
- **Command execution** — shell backend details (respects `shellPath`,
  defaults to `/bin/bash` on Unix, Git Bash on Windows). Absorbed from
  the orphaned note in "Custom templates."
- **Artifacts** — structured state between steps. Keep the command step
  example with `$RELAY_INPUT` / `$RELAY_OUTPUT`.
- **Loops** — back-edges and `max_runs`. Keep brief.

One explanation of each concept, at one level of detail. No overlap
between sections.

**Why this works:** The reader is now in *learning mode*, not
*evaluating mode*. They've decided to use relay and want to understand
it deeply. This is the right moment for the step type taxonomy,
artifact contracts, and routing semantics. Earlier, this information
would have been noise. Now it's knowledge.

---

**Beat 8: Depth — "What else can it do?"**

The full template catalog. Verified-edit appeared in Beat 3 as the
concrete example, so it gets a brief reprise here (parameters, full
usage). Reviewed-edit gets full treatment — it's the second most
common template and introduces the review loop concept.

The remaining templates (bug-fix, multi-gate, debate, autoresearch,
pr-review) go in `<details>` blocks. The reader already knows they
exist from the topology table in Beat 4. They click to expand the
ones that match their needs.

Drop the hardcoded count intro ("Five templates ship with the
extension..."). Replace with: "Relay ships with templates for common
workflow topologies." The topology table already enumerates them.

**Why this works:** Progressive disclosure. The reader who needs
verified-edit and reviewed-edit (80% of users) gets them without
scrolling past five other templates. The reader who needs debate or
autoresearch already knows they exist and can find them.

---

**Beat 9: Ownership — "I can build my own."**

Custom templates and actors. This is reference material for power
users. Keep as-is, except remove the shell backend note from custom
templates (it moved to Beat 7).

The reader who reaches this section is no longer learning about relay
— they're extending it. The tone shifts from narrative to reference.
That's correct. The journey is complete; now they need precision.

---

**Beat 10: Contribution — "I can help build this."**

Development section. Unchanged.

---

### The emotional arc

```
Recognition → Promise → Proof → Expansion → Trust
    ↓            ↓         ↓         ↓          ↓
"I have      "There's   "Oh,     "It does   "I'm in
 this         a way"    simple"   ALL of     control"
 problem"                         these?!"

    → On-ramp → Understanding → Depth → Ownership
         ↓           ↓            ↓          ↓
      "Let me     "Now I       "What     "I can
       try it"     get it"      else?"    build
                                          my own"
```

Each beat earns the right to the next one. The reader can stop at any
point and have gotten value: after Beat 3, they understand the concept.
After Beat 6, they can use it. After Beat 7, they understand it deeply.
After Beat 9, they can extend it.

### Narrative techniques used

**Problem-first framing.** The tool doesn't introduce itself — it
describes the reader's problem. This is the "mirror opening": the
reader sees themselves before they see the product.

**Concrete before abstract.** One example before any taxonomy. The
verified-edit diagram + invocation does more work than a paragraph of
explanation.

**The expanding world.** Show one room, then reveal the mansion. The
topology table hits harder after the reader has seen one topology in
action.

**Objection handling in sequence.** The "but what if it breaks things?"
concern is addressed immediately after the expansion, before it can
become resistance.

**Convince before enabling.** Install instructions come after the
reader has decided they want to use the tool, not before.

**Progressive disclosure.** Each section reveals exactly as much depth
as the reader is ready for. Details blocks for the long tail.

**Tone shift at the boundary.** The first six beats are narrative
(guiding). The last four are reference (serving). The README doesn't
try to maintain a single voice — it matches the reader's mode.

### Guiding principles

**One fork, not two.** Present the extension/CLI split exactly once,
as two parallel getting-started sections. No repeated forking.

**README is narrative, not reference.** Keep quickstart examples
prominent. Push exhaustive option lists and edge-case configuration
into subsections below the quickstart, so they don't interrupt the
narrative flow but remain in one document.

**No table of contents.** The restructured README has ~10 sections and
will be shorter than the current one. GitHub's built-in outline
(hamburger icon on rendered markdown) provides jump links. A manual
TOC rots when sections are renamed.

### Proposed structure

```
1.  Logo + one-liner
2.  The problem (2-3 sentences naming the pain)
3.  The promise (1 sentence thesis)
4.  One example (verified-edit diagram + invocation)
5.  Topology table (the expansion — the "click")
6.  Plan review (2 sentences — trust/reassurance)
7.  Getting started: extension (install + tools list + replay example)
8.  Getting started: CLI (install + one command + GH Actions snippet)
9.  How it works (merged: concepts + shell execution)
10. Templates (verified-edit + reviewed-edit expanded; rest collapsed)
11. Custom templates
12. Actors
13. Development
14. License
```

Sections 2-6 fit on one screen. A reader who scrolls once has the
complete concept, the proof, the landscape, and the safety guarantee.
They haven't installed anything yet, but they know exactly what relay
is and whether they want it.

### Section-by-section plan

#### 1. Logo + one-liner (unchanged)

Keep the existing logo block and one-liner.

#### 2-3. The problem and the promise (new)

Two to three sentences naming the pain (managing multi-step workflows
manually), followed by one sentence thesis (relay lets you define the
workflow once and execute it reliably). This replaces "Two ways to use
it" and the current Extension preamble.

Write fresh. The current preamble ("Without relay, the assistant
handles everything in a single conversation turn...") has the right
idea but is too focused on the mechanism. Rewrite to center the
reader's experience: what they're doing manually, why it breaks down,
what relay replaces.

#### 4. One example (new position)

Move the verified-edit mermaid diagram and a single invocation up from
the templates section. This is the first concrete thing the reader
sees. Keep it minimal — the diagram, one usage example, nothing else.
No parameter tables, no options.

#### 5. Topology table (moved, edited)

Move from the current Extension section. **Strip the template name
column** — the names are forward references that add noise here. Keep
topology and what-it-models columns only. Template names appear later
in the templates section.

The three tools/commands list (relay tool, replay tool, /relay command)
does **not** appear here. These are extension-specific interface
details. They move to "Getting started: extension" (section 7).

#### 6. Plan review (moved, compressed)

Absorb the current standalone "Plan review" section (lines 444-451)
into two sentences here. Positioned as trust-building right after the
expansion. "When a plan can modify files or run commands, you review it
first: run, refine, or cancel."

#### 7. Getting started: extension

Combine the current install block with the tools/commands list and one
replay example. Keep `pi install` one-liner and manual/symlink
alternative.

#### 8. Getting started: CLI

Keep the one-liner install, one `relay` invocation, and GitHub Actions
snippet as the quickstart. Follow with the full CLI reference as
subsections (### Options, ### Parameter defaults, ### Working directory,
### Dry run). The quickstart is the on-ramp; the subsections are
reference for returning users. Everything stays in one file.

#### 9. How it works (merged)

Combine "How it works," "Core concepts," and the shell backend note.
Structure:

- **Steps and routing** — four step types, route semantics.
- **Command execution** — shell backend details. Absorbed from the
  orphaned note in "Custom templates" (line 409).
- **Artifacts** — structured state between steps. Keep the
  `$RELAY_INPUT` / `$RELAY_OUTPUT` example.
- **Loops** — back-edges and `max_runs`.

One explanation per concept. No overlap.

#### 10. Templates

Drop the hardcoded count intro. Replace with count-free sentence.

**Expanded:** verified-edit (brief reprise — full parameters and usage,
since the diagram already appeared in section 4) and reviewed-edit
(full treatment).

**Collapsed (`<details>`):** bug-fix, multi-gate, debate, autoresearch,
pr-review. Same content as today, reader clicks to expand.

#### 11. Custom templates (minor edit)

Remove the shell backend note (moved to section 9). Keep scoping
rules, shadowing, YAML example.

#### 12. Actors (unchanged)

Keep as-is.

#### 13. Development (unchanged)

Keep as-is.

#### 14. License (unchanged)

Keep as-is.

## What changes, what doesn't

| Current section | Action |
|---------|--------|
| Logo + one-liner | Keep |
| "Two ways to use it" | Replace with problem/promise (sections 2-3) |
| Install: extension | Move to "Getting started: extension" (section 7) |
| Install: CLI | Move to "Getting started: CLI" (section 8) |
| CLI (full section) | Quickstart leads; reference follows as subsections under "Getting started: CLI" |
| Extension (preamble) | Rewrite as problem/promise (sections 2-3) |
| Extension (topology table) | Move to section 5; strip template name column |
| Extension (tools/commands list) | Move to "Getting started: extension" (section 7) |
| How it works | Merge into section 9 |
| Core concepts | Merge into section 9 |
| Plan review | Compress to 2 sentences in section 6 |
| Shell backend note (line 409) | Move to section 9 under command execution |
| Template count intro (line 207) | Replace with count-free sentence |
| Templates: verified-edit | Diagram + invocation in section 4; full details in section 10 |
| Templates: reviewed-edit | Keep expanded in section 10 |
| Templates: bug-fix, multi-gate, debate | Collapse into `<details>` in section 10 |
| Templates: autoresearch, pr-review | Collapse into `<details>` in section 10 |
| Custom templates | Remove shell backend note; otherwise keep |
| Actors | Keep |
| Development | Keep |
| License | Keep |

## Risks

**Collapsed templates reduce discoverability.** Someone scanning the
README might not click to expand and miss that debate or autoresearch
exist. Mitigation: the topology table in section 5 lists all topologies
by name, so the reader knows they exist even if the details are
collapsed.

**GitHub doesn't render `<details>` in all contexts.** Details/summary
tags work on GitHub.com but may not render in npm README views or other
mirrors. Mitigation: the content is still present in the source — it
just won't collapse. Acceptable degradation.

**Verified-edit appears twice.** The diagram shows in section 4 (as the
proof example) and again in section 10 (as a template with full
parameters). This is intentional — the two contexts serve different
purposes — but the section 10 version should be brief and reference
back rather than fully repeat the diagram.

## Out of scope

- Screenshots or terminal recordings. Worth doing eventually but
  orthogonal to this restructure.
- Man page or `--help` improvements. Separate concern.
- Splitting the README into a docs site. The single-file README is the
  right format for this project's size.
- Rewriting the one-liner or logo. The identity is fine; the problem
  is the narrative structure below it.
