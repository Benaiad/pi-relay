#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

# Post a comment after fix + failed verification.
# Args: pr_number

pr_number="$1"

fix_notes=$(cat "$RELAY_INPUT/fix_notes")
url=$(run_url)

body="## AI Review: Verification Failed

Fixes were applied but verification did not pass. Manual intervention needed.

### Changes Attempted
${fix_notes}

---
*[View full run](${url})*"

gh pr comment "$pr_number" --body "$body"
