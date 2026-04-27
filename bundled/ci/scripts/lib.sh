# Shared functions for pi-relay CI scripts.
# Sourced by sibling scripts — not executed directly.

dismiss_stale_reviews() {
	local pr_number="$1"
	gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}/reviews" \
		--jq '[.[] | select(.user.login == "github-actions[bot]") |
		       select(.state == "CHANGES_REQUESTED" or .state == "APPROVED") |
		       .id] | .[]' | \
	while read -r review_id; do
		gh api -X PUT \
			"repos/${GITHUB_REPOSITORY}/pulls/${pr_number}/reviews/${review_id}/dismissals" \
			-f message="Superseded by new review." 2>/dev/null || true
	done
}

derive_base_branch() {
	local pr_number="$1"
	local override="${2:-}"
	if [ -n "$override" ]; then
		echo "$override"
	else
		gh pr view "$pr_number" --json baseRefName --jq '.baseRefName'
	fi
}

run_url() {
	echo "${GITHUB_SERVER_URL:-https://github.com}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}"
}
