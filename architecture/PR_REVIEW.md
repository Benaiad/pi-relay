# AI Code Review for Pull Requests

## What this is

A relay plan template that replaces human code review on pull requests.
A reviewer LLM reads the diff, produces structured findings with line
numbers, and the runtime posts them as a real GitHub review — with
line-level inline comments, severity badges, and an approve/request-changes
verdict. A worker LLM then fixes the findings, self-verifies, and pushes.

Two LLM calls. Everything else — gathering context, posting reviews,
dismissing stale reviews, pushing fixes, posting summaries — is bash
scripts called from command steps. Zero tokens on mechanical work.

```
relay bundled/ci/pr-review.md \
  -e pr_number=42 \
  --model "$RELAY_MODEL" \
  --thinking "$RELAY_THINKING"
```

## What it's not

- Not a linter. Formatting and style rules are for automated tools. This
  reviews for correctness, security, error handling, and breaking changes.
- Not a test generator. It reviews existing code, not write new tests
  (though it may add test coverage as part of a fix).
- Not a replacement for branch protection. It posts a GitHub review that
  integrates with branch protection rules. It does not configure them.
- Not incremental. Every run reviews the full diff against the base
  branch. It does not track what was reviewed on previous commits.

## User experience

What the human sees, in order:

### 1. PR check appears

The moment a PR is opened or a new commit is pushed, a GitHub Actions
check named "Relay PR Review" appears in the PR's Checks tab. Status:
in progress.

### 2. Stale review dismissed

If a previous AI review exists on the PR (from an earlier commit), it is
dismissed with the message "Superseded by new review." The PR timeline
shows the dismissal. This prevents stale findings from blocking merge
alongside the fresh review.

### 3. GitHub review posted

The bot posts a GitHub review. It appears in the PR timeline exactly like
a human review.

**If clean:**

The PR shows a green "Approved" badge. The review body contains the
summary.

**If issues found:**

The PR shows a red "Changes requested" badge. The review body contains
the summary, a finding count breakdown (N error, N warning, N info), and
each finding formatted as a section.

Each finding is also posted as a **line-level inline comment** on the
affected line in the diff. Humans see findings in the "Files changed"
tab, pinned to the exact line — just like a human reviewer's comments.
They can reply, start threads, and resolve them.

When the reviewer cannot identify an exact line (or the line falls
outside a changed hunk), the comment falls back to a **file-level**
comment at the top of the file's diff.

### 4. Fix commit pushed

A commit by `pi-relay[bot]` appears in the PR history:

```
fix: address AI review findings
```

The worker addresses all `error` findings and straightforward `warning`
findings. It self-verifies by running the project's verification command
before committing. If it cannot make verification pass, it commits what
it has and documents the remaining issues.

### 5. Summary comment

After fix + verify, a PR comment reports the outcome:

> **AI Review: Fixes Applied**
>
> Reviewed and found **3** issue(s). All error and warning findings
> addressed.
>
> **Changes Made:**
> Replaced string-interpolated SQL query in auth.ts with parameterized
> query. Added unit test for email+special chars case.
>
> Verification passed.

Or if verification failed:

> **AI Review: Verification Failed**
>
> Fixes were applied but verification did not pass. Manual intervention
> needed.
>
> **Changes Attempted:**
> [description of what was changed]

### 6. Check completes

The GitHub Actions check turns green (approved or fixed) or red
(verification failed or infrastructure error).

### What humans do next

- **Approved:** Merge when ready. The AI found nothing.
- **Fixed:** Review the AI's commit. Findings are inline comments — resolve
  them as you review. Merge when satisfied.
- **Verification failed:** The AI tried but broke something. Check the
  CI logs. Fix manually.

## Architecture

### Data flow

1. A push to the PR branch triggers the GitHub Actions workflow.
2. The workflow invokes `relay bundled/ci/pr-review.md` with the PR
   number. The model and thinking level come from repository secrets
   via CLI flags.
3. The **prepare** command step derives the base branch from the PR
   via `gh pr view`, fetches it, gathers PR metadata and the diff, and
   writes the `context` artifact. The diff is truncated at
   `max_diff_lines` (default 10000).
4. The **review** action step receives the context artifact injected
   directly into its prompt — zero tool calls to get the diff. The
   reviewer reads the context, optionally inspects source files via
   `read`/`grep`, and emits structured findings (with line numbers) and
   a summary. It routes to `approve` or `request_changes`.
5. On the **approve** path: dismiss stale reviews, post APPROVE review,
   terminate.
6. On the **request_changes** path: dismiss stale reviews, post
   REQUEST_CHANGES review with line-level inline comments, then hand off
   to the fix path.
7. The **fix** action step reads the findings artifact (injected into its
   prompt), applies fixes, self-verifies by running the verify command,
   and emits fix notes.
8. The **push_fixes** command step commits and pushes using `GITHUB_TOKEN`.
9. The **verify** command step runs the project's verification command.
10. A final command step posts a summary comment reporting the outcome.

### Topology

```
prepare (cmd) --> review (action) --approve--------> post_approval (cmd) --> approved
                                  \
                                   request_changes
                                        \
                                    post_findings (cmd) --> fix (action) --> push_fixes (cmd) --> verify (cmd) --pass--> post_summary (cmd) --> fixed
                                                                                                              \
                                                                                                           fail
                                                                                                                \
                                                                                                            post_failure (cmd) --> unfixed
```

Every command step failure routes to a `failed` terminal (omitted for
clarity). Four terminal states:

| Terminal | Outcome | Meaning |
|----------|---------|---------|
| `approved` | success | Clean review, no findings |
| `fixed` | success | Findings addressed, verification passed |
| `unfixed` | failure | Findings addressed, verification failed |
| `failed` | failure | Infrastructure error (API, git, network) |

### Artifact contracts

#### `context` (text)

**Written by:** `prepare` (command)
**Read by:** `review` (action — injected into prompt)

```
# PR #42: Fix authentication handler

[PR description from GitHub]

## Changed Files
 src/auth.ts    | 25 +++++++++++++++----------
 src/config.ts  |  3 ++-
 2 files changed, 16 insertions(+), 12 deletions(-)

## Diff
[diff truncated at max_diff_lines]
```

Ordering is deliberate: intent first (title + description), scope second
(file summary), code last (diff). The reviewer reads top-down, spending
tokens on context before code. If the diff is truncated, the reviewer has
`read`/`grep` to inspect files beyond the truncation point.

**Truncation:** The `max_diff_lines` parameter (default 10000) controls
the cutoff. At ~4 tokens/line, 10000 lines is ~40000 tokens. The
truncation note tells the reviewer how many total lines exist and how to
access the full diff.

#### `review_summary` (text)

**Written by:** `review` (action)
**Read by:** `post_approval` (command), `post_findings` (command)

One paragraph: overall assessment with risk level. Posted as the review
body header. Consumed as-is by the command step — no parsing.

Example: "Risk: Medium. The PR modifies authentication logic with
string-interpolated SQL queries and no test coverage for the new
validation path."

#### `review_findings` (record_list)

**Written by:** `review` (action)
**Read by:** `post_findings` (command), `fix` (action — injected into prompt)

```yaml
fields: [severity, category, file, line, description, suggestion]
list: true
```

Each finding:

```json
{
  "severity": "error",
  "category": "security",
  "file": "src/auth.ts",
  "line": "42",
  "description": "SQL injection via string interpolation in query builder.",
  "suggestion": "Use parameterized queries with $1 placeholders."
}
```

| Field | Values | Purpose |
|-------|--------|---------|
| severity | `error`, `warning`, `info` | `error` = must fix. `warning` = should fix. `info` = consider. |
| category | `correctness`, `security`, `error-handling`, `breaking-change`, `testing`, `style`, `performance` | Grouping in review body. |
| file | Relative path | Target file for the inline comment. |
| line | Numeric string or `""` | Line number in the new file. Empty when the finding is file-level (e.g., "missing error handling throughout"). |
| description | Free text | What's wrong. |
| suggestion | Free text | How to fix it. Concrete. |

**Line number semantics:** The `line` field is a string. When non-empty
and numeric, the `post_findings` command step validates it against the
diff (see "Line-level inline comments" below). When empty or invalid, the
finding falls back to a file-level comment. This makes the schema
forgiving — the LLM's best-effort line numbers are validated
mechanically, not trusted blindly.

The runtime validates every finding has all six fields before committing.
Missing fields cause the step to fail.

On the approve path, the reviewer writes an empty list `[]`.

#### `fix_notes` (text)

**Written by:** `fix` (action)
**Read by:** `post_summary` (command), `post_failure` (command)

Free-text summary of what the worker changed. Posted in the summary
comment.

### Actors

#### `pr-reviewer`

```yaml
name: pr-reviewer
description: Reviews pull request diffs. Read-only.
tools: read, grep, find, ls
```

No `model:` or `thinking:` in the actor file. Both come from the CLI
flags `--model` and `--thinking`, which are populated from repository
secrets. This keeps the provider and model name out of version-controlled
files.

Read-only tools. No `bash`, no `edit`, no `write`. The reviewer inspects
code but cannot modify it — this prevents "fixing as it reviews" which
would conflate two responsibilities and burn tokens on code changes that
aren't persisted.

The reviewer has `read`/`grep`/`find`/`ls` as fallback for when the
truncated diff is insufficient. The instruction guides it to work
primarily from the injected `context` artifact.

#### `worker` (bundled)

The standard bundled worker actor. Used for the fix step. Has `bash`
access for running the verification command during self-verification.
Gets its model and thinking level from the CLI flags (same as the
reviewer).

### Line-level inline comments

The critical design problem: GitHub's review API rejects the **entire
review** if any comment in the `comments` array has an invalid line
position. The LLM will sometimes output line numbers that don't
correspond to changed lines in the diff. The command step must validate
every line before sending.

**Validation strategy:**

The `post-findings.sh` script:

1. Parses the diff with `git diff -U0` (zero context lines) to extract
   the set of valid `file:line` pairs — only lines that were added or
   modified in the PR. Uses POSIX awk (works with mawk, gawk, BSD awk).

   ```bash
   git diff -U0 "origin/${base_branch}...HEAD" | awk '
     /^diff --git/ { file = $NF; sub(/^b\//, "", file) }
     /^@@/ {
       s = $0; sub(/.*\+/, "", s); sub(/ .*/, "", s)
       n = split(s, p, ",")
       start = p[1] + 0
       count = (n > 1) ? (p[2] + 0) : 1
       if (count == 0) next
       for (i = 0; i < count; i++) print file ":" (start + i)
     }
   '
   ```

2. For each finding, checks whether `file:line` appears in the valid set.

3. **Valid line:** Inline comment with `path`, `line`, `side: "RIGHT"`.
4. **Invalid line, empty line, or non-numeric:** File-level comment with
   `path`, `subject_type: "file"`.
5. **File not in diff:** Finding folded into review body text (no inline
   comment).

**Fallback cascade:** line-level > file-level > body text. The review
always succeeds. The worst case is that some findings appear in the body
instead of as inline comments — still visible, just less convenient.

**Why `-U0`:** Zero context lines means only changed lines appear. This
is conservative — GitHub actually allows commenting on context lines too
(3 lines around changes). But limiting to changed lines means the
validation is never wrong. A finding on a changed line always produces a
valid inline comment.

### Stale review dismissal

Before posting a new review, the command step dismisses all previous
reviews by `github-actions[bot]` on the PR:

```bash
gh api "repos/${GITHUB_REPOSITORY}/pulls/{{pr_number}}/reviews" \
  --jq '[.[] | select(.user.login == "github-actions[bot]") |
         select(.state == "CHANGES_REQUESTED" or .state == "APPROVED") |
         .id] | .[]' | \
while read -r review_id; do
  gh api -X PUT \
    "repos/${GITHUB_REPOSITORY}/pulls/{{pr_number}}/reviews/${review_id}/dismissals" \
    -f message="Superseded by new review." 2>/dev/null || true
done
```

This runs at the start of both `post_approval` and `post_findings`.
The `|| true` ensures dismissal failures don't block the new review —
the old review might already be dismissed, or dismissal might be
disabled in branch protection.

### Self-verifying fixes

The fix step's instruction includes the verify command:

```
After applying fixes, verify your changes by running: {{verify}}
If it fails, read the output, adjust your fixes, and re-run.
If you cannot make it pass after a reasonable effort, write what
you managed to fix and what remains in the fix_notes artifact.
```

The worker has `bash` access and can run the verify command as part of
its tool-call loop. This catches most fix failures before the formal
push+verify cycle, reducing wasted CI round-trips.

The formal `verify` command step after `push_fixes` is still the real
gate. The worker's self-verification runs in a dirty working tree; the
formal verification runs after commit in the CI environment. Both are
needed.

**Token tradeoff:** Self-verification adds tool calls (edit, bash, read
error, edit again). On a fix that needs two iterations, this might add
~3000 tokens. The payoff is fewer failed push+verify cycles, which would
each cost a full CI run.

## GitHub integration

### Trigger strategy

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]
```

- **`opened`:** First review when the PR is created.
- **`synchronize`:** Re-review on every push (every new commit on the
  PR branch).
- **`reopened`:** Re-review when a closed PR is reopened.
- **`branches: [main]`:** Only runs for PRs targeting `main`. PRs
  targeting other branches are not reviewed.

**Same-repo only:**

```yaml
if: github.event.pull_request.head.repo.full_name == github.repository
```

Fork PRs are skipped. They lack access to secrets and `GITHUB_TOKEN`
has restricted permissions on forks.

### Loop prevention

When the fix step pushes a commit using `GITHUB_TOKEN`, GitHub's
built-in protection prevents it from triggering a new workflow run:
"Events triggered by the GITHUB_TOKEN will not create a new workflow
run."

Sequence: AI pushes fix -> no `synchronize` event -> no loop. Human
pushes next commit -> new review triggered.

**Never use a PAT for the push step.** PAT-triggered events bypass this
protection and would cause an infinite loop.

### Permissions

```yaml
permissions:
  contents: write       # Push fix commits
  pull-requests: write  # Post reviews, comments, dismiss reviews
```

### Secrets

| Secret | Purpose | Required |
|--------|---------|----------|
| `RELAY_MODEL` | Model for the LLM (e.g., `zai/glm-5.1`). Passed to `--model`. | Yes |
| `RELAY_THINKING` | Thinking level (e.g., `medium`). Passed to `--thinking`. | No (defaults to `off`) |
| Provider API key | Authentication for the model provider (e.g., `ZAI_API_KEY`). Name depends on the provider. | Yes |

The model name and provider are stored as secrets so they are not
visible in workflow files, PR logs, or the repository. People using
the template cannot see which AI provider or model is being used.

`GITHUB_TOKEN` is not a secret — it is automatically provided.

### Base branch derivation

The base branch is not a required parameter. The `prepare` command step
derives it from the PR:

```bash
base_branch=$(gh pr view {{pr_number}} --json baseRefName --jq '.baseRefName')
git fetch origin "$base_branch" 2>/dev/null || true
```

The workflow's `branches: [main]` filter ensures the review only runs
for PRs targeting main, but the template itself works for any base
branch. An optional `base_branch` parameter (default `""`) allows
override for local testing.

## Reliability

### What can fail

| Component | Failure mode | Handling |
|-----------|-------------|----------|
| `gh pr view` | Network, rate limit, auth | `prepare` fails, check turns red |
| `git fetch` / `git diff` | Missing ref, network | `prepare` fails; the step fetches the base branch explicitly |
| LLM API | Timeout, auth, 500 | `review` or `fix` fails, check turns red |
| LLM output | Missing fields | Artifact validation rejects, step fails |
| LLM output | Wrong line numbers | Validated against diff; falls back to file-level comment |
| `gh api` (post review) | Auth, rate limit, invalid comment | `post_*` fails, check turns red |
| `git push` | Permission denied, protected branch | `push_fixes` fails, check turns red |
| Review dismissal | Already dismissed, not found | Silently ignored (`|| true`) |
| Self-verification (fix) | Verify command fails | Worker adjusts or documents remaining issues |

Every infrastructure failure produces a red check. No silent failures.

### Artifact validation

The runtime validates every artifact write before committing. For
`review_findings`, every record must have all six fields as strings. If
the LLM omits a field, the commit is rejected, the step fails, and the
plan fails. Malformed findings never reach the posting step.

This means the `post_findings` command step can trust that
`$RELAY_INPUT/review_findings` contains valid JSON with the expected
shape.

### JSON safety in shell

The `post_findings` command step constructs a complex JSON payload.
Shell variable expansion in JSON is fragile (unescaped quotes, newlines,
special characters).

Mitigation: all JSON payloads are constructed with `jq`. Variable values
pass through `jq --arg` which handles escaping. The result is piped to
`gh api --input -`. No shell string interpolation in JSON.

```bash
jq -n --arg body "$body" --arg event "REQUEST_CHANGES" \
  --argjson comments "$comments_json" \
  '{body: $body, event: $event, comments: $comments}' | \
  gh api "repos/${GITHUB_REPOSITORY}/pulls/{{pr_number}}/reviews" --input -
```

### Line validation reliability

The line validation uses `git diff -U0` (zero context lines), which
only reports changed lines. GitHub allows commenting on context lines
too (within 3 lines of a change), but restricting to changed lines
means validation is conservative — never a false positive.

The fallback cascade (line > file > body) guarantees the review is
always posted. In the worst case where all line numbers are invalid,
every finding becomes a file-level comment. The review still contains
all information.

## Token budget

| Step | Type | Tokens (approx) | Tool calls |
|------|------|-----------------|------------|
| prepare | command | 0 | 0 |
| review | action | ~3000 in, ~800 out | 0-3 (read/grep) |
| post_approval / post_findings | command | 0 | 0 |
| fix | action | ~2000 in, ~500 out | 5-20 (read + edit + bash verify) |
| push_fixes | command | 0 | 0 |
| verify | command | 0 | 0 |
| post_summary / post_failure | command | 0 | 0 |

**Approve path:** ~4000 tokens. One LLM call.
**Fix path:** ~7000 tokens + tool calls. Two LLM calls. The
self-verification loop in the fix step may add ~3000 tokens if the
worker iterates.

The `context` artifact (assembled free by a command step) is injected
into the reviewer's prompt. The reviewer reads the entire PR in one
prompt injection instead of spending tokens on tool-call round-trips.

The diff truncation at `max_diff_lines` (default 10000) caps the worst
case at ~40000 input tokens for the review step. This is configurable
without changing code.

## Parameters

| Parameter | Required | Default | Source in workflow |
|-----------|----------|---------|-------------------|
| `pr_number` | Yes | — | `${{ github.event.pull_request.number }}` |
| `verify` | No | `"npm run check"` | Hardcoded in workflow or from repo var |
| `max_diff_lines` | No | `"10000"` | Hardcoded in workflow or from repo var |
| `base_branch` | No | `""` (auto-derived) | Omitted; derived from PR |

`--model` and `--thinking` are CLI flags, not template parameters. They
come from repository secrets `RELAY_MODEL` and `RELAY_THINKING`.

## Implementation plan

### File structure

```
bundled/actors/pr-reviewer.md          Reviewer actor (no model/thinking)
bundled/ci/
  pr-review.md                         Plan template — topology and artifact contracts
  README.md                            Setup guide: secrets, permissions, customization
  scripts/
    lib.sh                             Shared functions (dismiss reviews, derive base branch)
    prepare.sh                         Gather PR context into the context artifact
    post-approval.sh                   Dismiss stale reviews, post APPROVE review
    post-findings.sh                   Dismiss stale reviews, post REQUEST_CHANGES with inline comments
    push-fixes.sh                      Commit and push fix changes
    post-summary.sh                    Post success comment
    post-failure.sh                    Post failure comment
.github/workflows/pr-review.yml       GitHub Actions workflow
```

The template is a pure topology definition — each command step is a
one-liner that calls a script. The scripts are independently testable,
syntax-highlighted, and lintable.

### `RELAY_PLAN_DIR`

Command steps reference scripts via `$RELAY_PLAN_DIR/scripts/<name>.sh`.
This environment variable is set by the workflow:

```yaml
- name: Install pi-relay
  id: relay
  run: |
    npm install -g github:benaiad/pi-relay
    echo "plan_dir=$(npm root -g)/pi-relay/bundled/ci" >> "$GITHUB_OUTPUT"

- name: Run PR review
  env:
    RELAY_PLAN_DIR: ${{ steps.relay.outputs.plan_dir }}
```

The relay runtime propagates `process.env` to command step subprocesses
via `buildShellEnv()` (scheduler.ts:762). No runtime changes needed —
`RELAY_PLAN_DIR` is just an env var the workflow provides.

For local development: `RELAY_PLAN_DIR=./bundled/ci relay ...`.

### No runtime changes

The plan template uses existing relay machinery. No changes to the
compiler, scheduler, artifact system, or actor engine.

## Decisions made

| Decision | Rationale |
|----------|-----------|
| Auto-fix included | Single template. The fix path runs unconditionally on findings. |
| Line-level comments | Better UX. Validated against diff hunks; falls back to file-level. |
| Stale review dismissal | Prevents stale findings from blocking merge alongside fresh review. |
| Diff truncation 10000, parameterized | Covers large PRs. Configurable via `-e max_diff_lines=N`. |
| Base branch auto-derived | One fewer parameter. Derived from PR via `gh pr view`. Optional override for local use. |
| Model/thinking from CLI flags | Keeps provider name out of version-controlled files. Stored as repo secrets. |
| Self-verifying fix | Worker runs verify command before committing. Catches failures early, fewer wasted CI cycles. |
| `branches: [main]` trigger filter | Only reviews PRs targeting main. Other base branches are excluded. |

## Future work

### Code suggestions

GitHub supports suggestion syntax in review comments:

````markdown
```suggestion
const user = await db.query('SELECT * FROM users WHERE id = $1', [id]);
```
````

The reviewer could output replacement code, and the command step wraps
it in suggestion syntax. Humans click "Apply suggestion" to accept.
Requires the reviewer to produce syntactically valid replacement code.

### Custom review criteria

A `.pi/pi-relay/review-criteria.md` in the project root. The reviewer
reads it for project-specific standards, security requirements, and
performance budgets. Injected alongside the context artifact.

### Job summary

Write to `$GITHUB_STEP_SUMMARY` after the relay run. Provides a rich
summary in the Actions run page without navigating to the PR.

### Incremental review

On `synchronize` events, review only new commits instead of the full
diff. Track the previously-reviewed SHA. Saves tokens on PRs with many
push cycles.
