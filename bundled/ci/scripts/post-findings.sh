#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# Dismiss stale reviews, then post a REQUEST_CHANGES review with
# line-level inline comments. Lines are validated against the diff;
# invalid lines fall back to file-level comments.
# Args: pr_number [base_branch]

pr_number="$1"
base_branch_override="${2:-}"

dismiss_stale_reviews "$pr_number"

base_branch=$(derive_base_branch "$pr_number" "$base_branch_override")

# ── Build set of valid file:line pairs from the diff ───────────────
# Only changed lines (no context). POSIX awk — works with mawk, gawk,
# and BSD awk.
valid_lines_file=$(mktemp)
trap 'rm -f "$valid_lines_file"' EXIT

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
' | sort > "$valid_lines_file"

changed_files=$(git diff --name-only "origin/${base_branch}...HEAD")

# ── Read artifacts ─────────────────────────────────────────────────
findings=$(cat "$RELAY_INPUT/review_findings")
summary=$(cat "$RELAY_INPUT/review_summary")

# ── Format the review body ─────────────────────────────────────────
errors=$(echo "$findings" | jq '[.[] | select(.severity == "error")] | length')
warnings=$(echo "$findings" | jq '[.[] | select(.severity == "warning")] | length')
infos=$(echo "$findings" | jq '[.[] | select(.severity == "info")] | length')
total=$(echo "$findings" | jq 'length')

body_findings=$(echo "$findings" | jq -r '
	.[] | "### [\(.severity | ascii_upcase)] \(.category)\n**File:** `\(.file)`\(if .line != "" then ":" + .line else "" end)\n\n\(.description)\n\n**Suggestion:** \(.suggestion)\n\n---"')

url=$(run_url)

review_body="${summary}

**${total} finding(s):** ${errors} error, ${warnings} warning, ${infos} info

${body_findings}

*Reviewed by [pi-relay](https://github.com/benaiad/pi-relay) · [View full run](${url})*"

# ── Build the payload with validated inline comments ───────────────
# Each finding becomes a line-level comment if file:line is in the
# diff, a file-level comment if the line is invalid or empty, or is
# excluded from inline comments if the file isn't in the diff (those
# findings are still in the review body).
if [ -s "$valid_lines_file" ]; then
	valid_json=$(jq -R . < "$valid_lines_file" | jq -s .)
else
	valid_json='[]'
fi

jq -n \
	--arg body "$review_body" \
	--arg event "REQUEST_CHANGES" \
	--argjson findings "$findings" \
	--arg changed "$changed_files" \
	--argjson valid "$valid_json" '
	($changed | split("\n") | map(select(length > 0))) as $files |
	{
		body: $body,
		event: $event,
		comments: [
			$findings[] | . as $f |
			("**[\($f.severity | ascii_upcase)] \($f.category)**\n\n\($f.description)\n\n**Suggestion:** \($f.suggestion)") as $comment_body |
			if ($files | index($f.file)) == null then
				empty
			elif ($f.line | length) == 0 then
				empty
			elif ($f.line | test("^[0-9]+$")) then
				(($f.file + ":" + $f.line) as $key |
					if ($valid | index($key)) then
						{path: $f.file, line: ($f.line | tonumber), side: "RIGHT", body: $comment_body}
					else
						empty
					end)
			else
				empty
			end
		]
	}' | \
	gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}/reviews" --input -
