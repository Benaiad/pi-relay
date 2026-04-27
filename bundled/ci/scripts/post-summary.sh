#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# Post a summary comment after successful fix + verification.
# Args: pr_number

pr_number="$1"

fix_notes=$(cat "$RELAY_INPUT/fix_notes")
findings=$(cat "$RELAY_INPUT/review_findings")
total=$(echo "$findings" | jq 'length')
url=$(run_url)

body="## AI Review: Fixes Applied

Reviewed and found **${total}** issue(s). All addressed.

### Changes Made
${fix_notes}

Verification passed.

---
*[View full run](${url})*"

gh pr comment "$pr_number" --body "$body"

dismiss_stale_reviews "$pr_number"
