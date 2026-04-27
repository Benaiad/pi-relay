#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# Dismiss stale reviews, then post an APPROVE review.
# Args: pr_number

pr_number="$1"

dismiss_stale_reviews "$pr_number"

summary=$(cat "$RELAY_INPUT/review_summary")

jq -n --arg body "$summary" --arg event "APPROVE" \
	'{body: $body, event: $event}' | \
	gh api "repos/${GITHUB_REPOSITORY}/pulls/${pr_number}/reviews" --input -
