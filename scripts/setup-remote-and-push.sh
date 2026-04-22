#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/setup-remote-and-push.sh <remote-url> [branch]
# Example:
#   ./scripts/setup-remote-and-push.sh git@github.com:owner/repo.git

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <remote-url> [branch]"
  exit 1
fi

REMOTE_URL="$1"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD)}"

if git remote get-url origin >/dev/null 2>&1; then
  echo "[git-setup] origin exists -> updating URL"
  git remote set-url origin "$REMOTE_URL"
else
  echo "[git-setup] origin missing -> adding remote"
  git remote add origin "$REMOTE_URL"
fi

echo "[git-setup] validating remote"
git remote -v

echo "[git-setup] pushing branch '$BRANCH'"
git push -u origin "$BRANCH"

echo "[git-setup] done"
