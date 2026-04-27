#!/usr/bin/env bash
set -euo pipefail

# Commit and push fix changes. No-op if the working tree is clean.

git config user.name "pi-relay[bot]"
git config user.email "pi-relay[bot]@users.noreply.github.com"

git checkout -- package-lock.json 2>/dev/null || true
git add -A
git reset HEAD -- package-lock.json 2>/dev/null || true

if git diff --cached --quiet; then
	echo "No changes to push."
else
	git commit -m "fix: address AI review findings"
	git push
fi
