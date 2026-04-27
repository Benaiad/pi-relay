#!/usr/bin/env bash
set -euo pipefail

# Gather PR context into the `context` artifact.
# Args: pr_number [base_branch] [max_diff_lines]

pr_number="$1"
base_branch_override="${2:-}"
max_diff_lines="${3:-10000}"

# Single API call for all PR metadata.
pr_json=$(gh pr view "$pr_number" --json title,body,baseRefName)
title=$(echo "$pr_json" | jq -r '.title')
description=$(echo "$pr_json" | jq -r '.body // "No description."')

if [ -n "$base_branch_override" ]; then
	base_branch="$base_branch_override"
else
	base_branch=$(echo "$pr_json" | jq -r '.baseRefName')
fi

git fetch origin "$base_branch" 2>/dev/null || true

diff_file=$(mktemp)
trap 'rm -f "$diff_file"' EXIT

git diff "origin/${base_branch}...HEAD" > "$diff_file"
diff_lines=$(wc -l < "$diff_file" | tr -d ' ')

# Everything below goes to the context artifact.
exec > "$RELAY_OUTPUT/context"

echo "# PR #${pr_number}: ${title}"
echo ""
echo "${description}"
echo ""
echo "## Changed Files"
git diff --stat "origin/${base_branch}...HEAD"
echo ""
echo "## Diff"

if [ "$diff_lines" -gt "$max_diff_lines" ]; then
	head -"$max_diff_lines" "$diff_file"
	echo ""
	echo "[truncated — ${diff_lines} total lines. Run: git diff origin/${base_branch}...HEAD]"
else
	cat "$diff_file"
fi
