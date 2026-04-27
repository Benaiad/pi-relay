# AI Code Review for Pull Requests

A relay plan template that reviews pull requests, posts GitHub reviews
with line-level inline comments, auto-fixes findings, and pushes verified
commits. Two LLM calls — all GitHub interaction is handled by bash
scripts (zero tokens on mechanical work).

## What it does

```
prepare → review (LLM) → post findings → fix (LLM) → push → verify → post summary
                       ↘ approve → post approval
```

1. **Gathers context** — PR title, description, file summary, and diff.
2. **Reviews** — One LLM call produces structured findings with severity,
   category, file, line, description, and suggestion.
3. **Dismisses stale reviews** — Previous AI reviews are dismissed before
   posting a new one.
4. **Posts a GitHub review** — APPROVE if clean, REQUEST_CHANGES if
   issues found. Each finding with a valid line number becomes a
   line-level inline comment on the diff. Findings with invalid or
   missing lines are included in the review body only.
5. **Fixes** — A worker LLM addresses error and warning findings. It
   self-verifies by running the project's verification command.
6. **Pushes** — Commits and pushes using `GITHUB_TOKEN` (no loop — pushes
   via `GITHUB_TOKEN` do not trigger new workflow runs).
7. **Verifies** — Runs the verification command after push.
8. **Posts a summary** — A PR comment reporting what was found and fixed.
   Dismisses the REQUEST_CHANGES review so it no longer blocks merge.

## File structure

```
bundled/ci/
  pr-review.md              Plan template — topology and artifact contracts
  README.md                 This file
  scripts/
    lib.sh                  Shared functions (dismiss reviews, derive base branch)
    prepare.sh              Gather PR context into the context artifact
    post-approval.sh        Dismiss stale reviews, post APPROVE review
    post-findings.sh        Dismiss stale reviews, post REQUEST_CHANGES with inline comments
    push-fixes.sh           Commit and push fix changes
    post-summary.sh         Post success comment, dismiss stale reviews
    post-failure.sh         Post failure comment
```

The template is a pure topology definition — each command step is a
one-liner that calls a script. The scripts are independently testable,
syntax-highlighted, and lintable.

## Setup

### 1. Copy the workflow

Copy `.github/workflows/pr-review.yml` into your repository:

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
          git clone --depth=1 https://github.com/benaiad/pi-relay.git /tmp/pi-relay
          cd /tmp/pi-relay && npm ci && npm run build
          echo "root=/tmp/pi-relay" >> "$GITHUB_OUTPUT"

      - name: Run PR review
        run: |
          node ${{ steps.relay.outputs.root }}/dist/cli/main.js \
            bundled/ci/pr-review.md \
            -e pr_number="${{ github.event.pull_request.number }}" \
            --model "$RELAY_MODEL" \
            --thinking "${RELAY_THINKING:-off}"
        env:
          RELAY_MODEL: ${{ secrets.RELAY_MODEL }}
          RELAY_THINKING: ${{ secrets.RELAY_THINKING }}
          RELAY_PLAN_DIR: ${{ steps.relay.outputs.root }}/bundled/ci
          GH_TOKEN: ${{ github.token }}
          # Add your provider's API key secret below. Name depends on provider:
          #   zai → ZAI_API_KEY, anthropic → ANTHROPIC_API_KEY, openai → OPENAI_API_KEY
          ZAI_API_KEY: ${{ secrets.ZAI_API_KEY }}
```

### 2. Configure secrets

Go to **Settings > Secrets and variables > Actions** in your repository
and add these secrets:

| Secret | Required | Example | Purpose |
|--------|----------|---------|---------|
| `RELAY_MODEL` | Yes | `zai/glm-5.1` | Model for the LLM. Format: `provider/model-name`. |
| `RELAY_THINKING` | No | `medium` | Thinking level: `off`, `low`, `medium`, `high`. Defaults to `off`. |
| Provider API key | Yes | (varies) | API key for your model provider. Name depends on provider — see below. |

**Provider API key names:**

| Provider | Secret name |
|----------|-------------|
| zai | `ZAI_API_KEY` |
| anthropic | `ANTHROPIC_API_KEY` |
| openai | `OPENAI_API_KEY` |
| google | `GOOGLE_API_KEY` |
| deepseek | `DEEPSEEK_API_KEY` |

Add the provider API key secret, then replace `ZAI_API_KEY` in the
workflow's `env` block with your provider's key name:

```yaml
        env:
          RELAY_MODEL: ${{ secrets.RELAY_MODEL }}
          RELAY_THINKING: ${{ secrets.RELAY_THINKING }}
          RELAY_PLAN_DIR: ${{ steps.relay.outputs.root }}/bundled/ci
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}   # your provider
          GH_TOKEN: ${{ github.token }}
```

The model name and provider are stored as secrets so they are not visible
in the workflow file, logs, or the repository.

### 3. Customize the verification command

The default verification command is `npm run check`. To change it, add
the `-e verify=` parameter:

```yaml
          node ${{ steps.relay.outputs.root }}/dist/cli/main.js \
            bundled/ci/pr-review.md \
            -e pr_number="${{ github.event.pull_request.number }}" \
            -e verify="cargo test && cargo clippy -- -D warnings" \
            --model "$RELAY_MODEL" \
            --thinking "${RELAY_THINKING:-off}"
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `pr_number` | (required) | Pull request number. Passed from the workflow. |
| `verify` | `npm run check` | Shell command that must exit 0. Used for verification after fixes and by the worker for self-testing. |
| `max_diff_lines` | `10000` | Maximum diff lines in the context artifact. Larger values give the reviewer more context but use more tokens. |
| `base_branch` | (auto-derived) | Base branch the PR targets. Derived from the PR via `gh pr view` when empty. Set explicitly for local testing. |

## Environment variables

The scripts expect these environment variables at runtime:

| Variable | Set by | Purpose |
|----------|--------|---------|
| `RELAY_PLAN_DIR` | Workflow | Path to `bundled/ci/`. Scripts resolve siblings via `$RELAY_PLAN_DIR/scripts/`. |
| `RELAY_INPUT` | Relay runtime | Directory containing artifact files for reading. |
| `RELAY_OUTPUT` | Relay runtime | Directory for writing artifact files. |
| `GITHUB_REPOSITORY` | GitHub Actions | `owner/repo` — used in API calls. |
| `GITHUB_SERVER_URL` | GitHub Actions | Base URL — used in "View full run" links. |
| `GITHUB_RUN_ID` | GitHub Actions | Run ID — used in "View full run" links. |
| `GH_TOKEN` | Workflow | Authentication for `gh` CLI. |

## Triggers

The workflow triggers on:

- **`opened`** — First review when the PR is created.
- **`synchronize`** — Re-review on every new push to the PR branch.
- **`reopened`** — Re-review when a closed PR is reopened.

Only PRs targeting `main` are reviewed. To review PRs targeting other
branches, change the `branches` filter:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main, develop]
```

Fork PRs are skipped (they lack access to secrets).

## How it works

The plan has 13 steps but only 2 LLM calls. Everything else is a script.

**Approve path** (1 LLM call):
```
prepare → review → post_approval → approved
```

**Fix path** (2 LLM calls):
```
prepare → review → post_findings → fix → push_fixes → verify → post_summary → fixed
```

### Line-level inline comments

The reviewer outputs a `line` field for each finding. The `post-findings`
script validates line numbers against the actual diff:

1. Parses `git diff -U0` with POSIX awk to extract valid `file:line`
   pairs (changed lines only).
2. For each finding: if `file:line` is valid, it becomes a line-level
   inline comment. If the line is invalid, empty, or the file isn't in
   the diff, the finding is skipped as an inline comment — it remains
   visible in the review body.

The review always posts successfully regardless of line accuracy.

### Stale review dismissal

Stale reviews are dismissed at two points:

1. **Before posting a new review** — `post-approval.sh` and
   `post-findings.sh` dismiss all previous reviews by
   `github-actions[bot]` before posting. This prevents stale findings
   from coexisting with the fresh review.
2. **After successful fix + verify** — `post-summary.sh` dismisses the
   REQUEST_CHANGES review it posted earlier, since the findings have
   been addressed. This unblocks merge.

Dismissal failures are silently ignored (`|| true`).

### Loop prevention

Fix commits are pushed using `GITHUB_TOKEN`. GitHub's built-in
protection prevents `GITHUB_TOKEN`-triggered events from starting new
workflow runs. No infinite loops.

**Never use a personal access token (PAT) for the push step.** PATs
bypass this protection.

## Local testing

Run the plan locally against an existing PR:

```bash
RELAY_PLAN_DIR=./bundled/ci \
  node dist/cli/main.js \
  bundled/ci/pr-review.md \
  -e pr_number=42 \
  -e base_branch=main \
  --model zai/glm-5.1 \
  --thinking medium
```

Dry-run (no LLM calls, no API key needed):

```bash
node dist/cli/main.js \
  bundled/ci/pr-review.md \
  -e pr_number=1 \
  --model fake/model \
  --dry-run
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `$RELAY_PLAN_DIR/scripts/prepare.sh: not found` | `RELAY_PLAN_DIR` not set | Add it to the workflow env (see setup step 1) |
| `Model not found` error | `RELAY_MODEL` secret missing or misspelled | Check Settings > Secrets |
| `No API key` error | Provider API key secret not set | Add the provider-specific secret |
| `git push` fails | Missing `contents: write` permission | Add the permission to the workflow |
| Review not posted | Missing `pull-requests: write` permission | Add the permission to the workflow |
| `gh api` 403 error | `GH_TOKEN` not set in env | Add `GH_TOKEN: ${{ github.token }}` to the env block |
