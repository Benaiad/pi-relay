# AI Code Review — Implementation Plan

References: [PR_REVIEW.md](PR_REVIEW.md) (design doc).

## What already exists

The relay runtime handles everything this template needs. No runtime
changes required.

- **Template discovery:** `src/templates/discovery.ts` — scans
  `bundled/plans/` for `.md` files with YAML frontmatter. The CLI can
  also take an explicit file path (`relay bundled/ci/pr-review.md`),
  bypassing discovery.
- **Actor discovery:** `src/actors/discovery.ts` — scans
  `bundled/actors/` for `.md` files. The `pr-reviewer` actor goes here
  and is auto-discovered.
- **Plan schema:** `src/plan/draft.ts` — field names are `type`, `name`,
  `on_success`, `on_failure`, `max_runs`, `entry_step` (snake_case wire
  format). The compiler maps these to camelCase internally.
- **Artifact exchange:**
  - Action steps write artifacts via `turn_complete` tool call.
    Injected into the next action step's prompt via
    `src/actors/task-prompt.ts`.
  - Command steps read from `$RELAY_INPUT/<artifact_name>` and write to
    `$RELAY_OUTPUT/<artifact_name>`. Directories created only when the
    step has reads/writes. Cleaned up after execution.
  - Text artifacts: raw string. Record: JSON object. Record list: JSON
    array. The runtime validates shape on commit (all-or-nothing).
  - Artifacts written to `$RELAY_OUTPUT` are committed regardless of
    exit code.
- **Model resolution:** `--model` is the fallback for actors without
  `model:` in frontmatter. `--thinking` is the fallback for actors
  without `thinking:`. Both the reviewer and worker actors omit these
  fields, so both use the CLI flags.
- **Command timeout:** Default 600s (10 min), max 7200s (2h). Field
  name: `timeout`.

## Architecture decisions

| Decision | Justification |
|----------|--------------|
| Template lives in `bundled/ci/`, not `bundled/plans/` | CI templates are not auto-discovered by the extension. They are passed as explicit file paths to the CLI. Separating them avoids polluting the extension's template list. |
| Actor lives in `bundled/actors/` | Actors must be discoverable. The CLI's default discovery scans `bundled/actors/`. No `--actors-dir` needed. |
| No model/thinking in actor frontmatter | Both come from `--model` and `--thinking` CLI flags, sourced from repo secrets. Keeps the provider name out of VCS. |
| `base_branch` optional parameter, default `""` | When empty, the prepare step derives it from `gh pr view`. Allows local testing with `-e base_branch=main`. |
| `max_diff_lines` as parameter, default `"10000"` | Template parameters are strings. The prepare step uses it in `head -{{max_diff_lines}}`. Configurable without code changes. |
| `line` field in findings is a string | Can be numeric (`"42"`) or empty (`""`). The post_findings command validates against the diff. Empty lines fall back to file-level comments. |
| Stale dismissal is best-effort | Uses `\|\| true` to prevent dismissal failures from blocking the new review. |
| Self-verifying fix | The fix instruction includes `{{verify}}`. The worker runs it via bash tool calls. More tokens but fewer wasted CI round-trips. |
| `jq` for all JSON construction | Prevents shell quoting bugs in review payloads. All variable values pass through `jq --arg`. |

## Data flow

```
[GitHub Actions]
  │
  ├─ checkout PR head branch, fetch-depth=0
  ├─ git fetch origin (base branch fetched by prepare step)
  ├─ npm install -g pi-relay
  │
  └─ relay bundled/ci/pr-review.md
       -e pr_number=42
       -e verify="npm run check"
       --model "$RELAY_MODEL"
       --thinking "$RELAY_THINKING"
       │
       ├─ discover actors from bundled/actors/
       │  (finds: worker, reviewer, pr-reviewer, advocate, critic, judge)
       ├─ load template from bundled/ci/pr-review.md
       ├─ substitute parameters
       ├─ compile plan (validate actors, routes, artifacts)
       │
       └─ execute:
            prepare (cmd) ─────────────→ writes context to $RELAY_OUTPUT/context
               │
            review (action) ←───────── context injected into prompt
               │                       writes review_summary + review_findings
               │                         via turn_complete
               ├─ approve ──→ post_approval (cmd)
               │                 reads $RELAY_INPUT/review_summary
               │                 dismisses stale reviews
               │                 posts APPROVE review via gh api
               │                 → approved (terminal)
               │
               └─ request_changes ──→ post_findings (cmd)
                                       reads $RELAY_INPUT/review_summary
                                       reads $RELAY_INPUT/review_findings
                                       dismisses stale reviews
                                       validates lines against diff
                                       posts REQUEST_CHANGES review with
                                         inline comments via gh api
                                       → fix (action)
                                           reads review_findings (injected)
                                           applies fixes, runs {{verify}}
                                           writes fix_notes via turn_complete
                                           → push_fixes (cmd)
                                               git add, commit, push
                                               → verify (cmd)
                                                   runs {{verify}}
                                                   ├─ pass → post_summary (cmd)
                                                   │           reads fix_notes, review_findings
                                                   │           posts summary comment
                                                   │           → fixed (terminal)
                                                   └─ fail → post_failure (cmd)
                                                               reads fix_notes
                                                               posts failure comment
                                                               → unfixed (terminal)
```

## File change summary

All new files. No modifications to existing code.

```
New:
  bundled/actors/pr-reviewer.md              # Actor
  bundled/ci/pr-review.md                    # Plan template (topology only)
  bundled/ci/README.md                       # Setup guide
  bundled/ci/scripts/lib.sh                  # Shared functions
  bundled/ci/scripts/prepare.sh              # Gather PR context
  bundled/ci/scripts/post-approval.sh        # Post APPROVE review
  bundled/ci/scripts/post-findings.sh        # Post REQUEST_CHANGES with inline comments
  bundled/ci/scripts/push-fixes.sh           # Commit and push
  bundled/ci/scripts/post-summary.sh         # Post success comment
  bundled/ci/scripts/post-failure.sh         # Post failure comment
  .github/workflows/pr-review.yml            # GitHub Actions workflow
```

## Step 1: Actor — `bundled/actors/pr-reviewer.md`

A minimal actor file. No model, no thinking — both come from CLI flags.

```markdown
---
name: pr-reviewer
description: Reviews pull request diffs for correctness, security, and convention adherence. Read-only.
tools: read, grep, find, ls
---

You are a code reviewer executing one step of a Relay plan.

[system prompt body — see below]
```

**System prompt content:**

The system prompt must instruct the reviewer to:

1. Work primarily from the `context` artifact (injected into the
   prompt). Avoid tool calls unless the diff is truncated and specific
   files need inspection.
2. Output a `review_summary` (text): one paragraph with risk level.
3. Output `review_findings` (record list): each record has `severity`,
   `category`, `file`, `line`, `description`, `suggestion`. The `line`
   field is the line number in the new file (from the diff's `+` lines)
   or empty if not applicable.
4. Route to `approve` if no issues found (write an empty findings list).
5. Route to `request_changes` if any issues found.
6. Not flag formatting, whitespace, or subjective style.

**Verify:** The actor file parses correctly:

```bash
node -e "
  const {parseFrontmatter} = require('@mariozechner/pi-coding-agent');
  const fs = require('fs');
  const content = fs.readFileSync('bundled/actors/pr-reviewer.md', 'utf-8');
  const {frontmatter, body} = parseFrontmatter(content);
  console.log(JSON.stringify(frontmatter, null, 2));
  console.log('Body length:', body.length);
"
```

Expected: `name: "pr-reviewer"`, `description: "..."`, `tools: "read, grep, find, ls"`, no `model`, no `thinking`.

## Step 2: Template and scripts

The template is a pure topology definition. Each command step is a
one-liner that calls a script via `$RELAY_PLAN_DIR/scripts/<name>.sh`.
The scripts are standalone bash files with `set -euo pipefail` and
shared functions via `source "$(dirname "$0")/lib.sh"`.

### Template — `bundled/ci/pr-review.md`

Command steps reference scripts instead of embedding shell inline:

```yaml
- type: command
  name: prepare
  command: '"$RELAY_PLAN_DIR/scripts/prepare.sh" {{pr_number}} "{{base_branch}}" {{max_diff_lines}}'
  writes: [context]
  on_success: review
  on_failure: failed
```

The two action steps (review, fix) keep their instruction text inline
in the template — it's the LLM prompt, not executable code.

### Scripts — `bundled/ci/scripts/`

**`lib.sh`** — sourced, not executed. Three functions:
- `dismiss_stale_reviews(pr_number)` — lists reviews by
  github-actions[bot], dismisses each with `|| true`.
- `derive_base_branch(pr_number, override)` — returns the override if
  non-empty, otherwise calls `gh pr view --json baseRefName`.
- `run_url()` — constructs the GitHub Actions run URL from env vars.

**`prepare.sh`** — single `gh pr view --json title,body,baseRefName`
call (no redundant API calls). Writes to `$RELAY_OUTPUT/context`.
Truncates the diff at `$max_diff_lines`. Uses `trap` for temp file
cleanup.

**`post-approval.sh`** — dismisses stale reviews, posts APPROVE via
`jq -n | gh api --input -`.

**`post-findings.sh`** — the most complex script. Dismisses stale
reviews, parses the diff with POSIX awk to build valid `file:line`
pairs, then constructs the review payload in a single `jq -n` call
that validates each line candidate against the valid set. The entire
payload (body + comments) is piped to `gh api --input -`. No shell
variable round-trips through JSON — avoids the newline escaping
issues that inline shell had.

**`push-fixes.sh`** — configures git user, stages all changes, commits
and pushes. No-op if the working tree is clean.

**`post-summary.sh`** / **`post-failure.sh`** — read artifacts, format
markdown, post via `gh pr comment`. Both `on_success` and `on_failure`
route to the same terminal (posting is best-effort).

### Frontmatter

```yaml
---
name: pr-review
description: >
  AI code review for pull requests. Reviews the diff, posts a GitHub
  review with line-level inline comments, fixes findings, pushes, and
  verifies. Two LLM calls. All GitHub interaction via command steps.
parameters:
  - name: pr_number
    description: Pull request number.
  - name: verify
    description: Shell command that must exit 0 for verification to pass.
    default: "npm run check"
  - name: max_diff_lines
    description: Maximum diff lines included in the context artifact. Truncated beyond this.
    default: "10000"
  - name: base_branch
    description: >
      Base branch the PR targets. When empty, auto-derived from the PR
      via gh pr view. Set explicitly for local testing.
    default: ""
---
```

### Plan body — artifact declarations

```yaml
task: "Review PR #{{pr_number}}."
success_criteria: "Review posted. If findings, fixes applied and verified."

artifacts:
  - name: context
    description: "PR metadata, file change summary, and diff."

  - name: review_summary
    description: "One-paragraph review assessment with risk level."

  - name: review_findings
    description: "Structured findings with severity, location, and fix suggestions."
    fields: [severity, category, file, line, description, suggestion]
    list: true

  - name: fix_notes
    description: "Summary of changes made to address review findings."
```

### Plan body — steps

The step topology and artifact wiring is in the template. The command
logic is in the scripts. Each script's interface is documented in its
header comment. See the scripts directly for implementation details —
they are the source of truth, not this document.

### Verify step 2 (template compiles)

```bash
relay bundled/ci/pr-review.md -e pr_number=1 --dry-run --model fake/model
```

Dry-run validates the plan compiles: all routes resolve, all actors
exist, all artifact reads/writes are consistent. No LLM calls, no API
key needed. The `--model fake/model` satisfies the "must have a model"
requirement without a real provider.

Expected: plan summary printed with all steps, artifacts, and actors
listed. Exit 0.

## Step 3: Workflow — `.github/workflows/pr-review.yml`

```yaml
name: PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]

permissions:
  contents: write
  pull-requests: write

jobs:
  review:
    name: Relay PR Review
    runs-on: ubuntu-latest
    if: github.event.pull_request.head.repo.full_name == github.repository
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.ref }}
          fetch-depth: 0

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install pi-relay
        id: relay
        run: |
          npm install -g github:benaiad/pi-relay
          echo "plan_dir=$(npm root -g)/pi-relay/bundled/ci" >> "$GITHUB_OUTPUT"

      - name: Run PR review
        run: |
          relay bundled/ci/pr-review.md \
            -e pr_number="${{ github.event.pull_request.number }}" \
            --model "$RELAY_MODEL" \
            --thinking "${RELAY_THINKING:-off}"
        env:
          RELAY_MODEL: ${{ secrets.RELAY_MODEL }}
          RELAY_THINKING: ${{ secrets.RELAY_THINKING }}
          RELAY_PLAN_DIR: ${{ steps.relay.outputs.plan_dir }}
          GH_TOKEN: ${{ github.token }}
          # Add your provider's API key secret:
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

**Notes:**

- `ref: head.ref` checks out the PR branch (not the merge commit).
  Required for `git push` to push to the correct branch.
- `fetch-depth: 0` fetches full history. The base branch is fetched
  by the `prepare` step via `git fetch origin "$base_branch"`.
- `RELAY_PLAN_DIR` resolves to the installed package's `bundled/ci/`
  directory. Scripts reference it as `$RELAY_PLAN_DIR/scripts/<name>.sh`.
- `${RELAY_THINKING:-off}` defaults to `off` if the secret is not set.
- `GH_TOKEN: ${{ github.token }}` authenticates `gh` CLI and provides
  push credentials via GITHUB_TOKEN.
- The provider API key secret name depends on the provider. Users
  configure it (e.g., `ZAI_API_KEY`, `ANTHROPIC_API_KEY`). Documented
  in the README.

### Verify step 3

Push a branch, open a PR targeting main. Verify:
- Workflow triggers
- Check appears on the PR
- The prepare step succeeds (context artifact written)
- The review step produces findings or approves
- Review is posted to the PR with inline comments
- Fix step runs (if findings exist)
- Push step pushes to the PR branch
- Summary comment is posted

## Step 4: README — `bundled/ci/README.md`

Setup guide covering:

1. **What it does** — One paragraph: AI reviews PRs, posts GitHub
   reviews with inline comments, auto-fixes findings, pushes.

2. **Prerequisites** — Repository secrets: `RELAY_MODEL` (required),
   `RELAY_THINKING` (optional), provider API key (required, name
   depends on provider).

3. **Setup** — Copy `.github/workflows/pr-review.yml` into your repo.
   Configure secrets. Adjust the `verify` parameter.

4. **Customization** — Table of parameters (`verify`, `max_diff_lines`,
   `base_branch`). How to change the trigger (different base branches,
   different event types).

5. **Secrets reference** — Table: secret name, purpose, example value.
   Explain that the model name is a secret so the provider is not
   visible in the repo.

6. **How it works** — Brief topology diagram. Link to the design doc
   for details.

7. **Troubleshooting** — Common failures and fixes: missing secrets,
   push permission denied, rate limits.

### Verify step 4

Read the README. Does it answer: "How do I set this up in my repo?"
in under 5 minutes?

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `post_findings` jq/awk script has a bug | Medium | Test with representative diffs: empty diff, single file, multi-file, binary files, renamed files. The awk only processes `@@` hunk headers — binary files and renames don't have them. |
| LLM always outputs empty `line` field | Medium | File-level comments still work. The review is posted. Less precise but functional. Monitor and adjust the reviewer prompt. |
| Shell quoting breaks the review body | Low | All JSON goes through `jq --arg` / `--argjson`. No direct shell interpolation in JSON. The `gh pr comment --body` does use shell expansion, but `fix_notes` is plain text without shell-special characters (the LLM writes English prose). |
| `GITHUB_TOKEN` push triggers a loop | None (if using GITHUB_TOKEN) | GitHub's built-in protection. Documented: never use a PAT. |
| Large diff (>10000 lines) truncation loses context | Low | The reviewer has read/grep tools. The truncation note tells the reviewer the full line count and how to access the full diff. |
| Stale review dismissal fails | Low | `\|\| true` makes it best-effort. The new review is still posted. Worst case: two reviews coexist until branch protection dismisses the stale one. |
| `git diff -U0` awk parse fails on edge cases | Low | The awk only looks for `+N,M` in `@@` lines. This is stable across git versions. Renames (`diff --git a/old b/new`) are handled because the awk uses `$NF` (last field = `b/new`). |
