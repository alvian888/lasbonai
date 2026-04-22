#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-allow}"
STATUS_FILE="data/anodos-session-status.json"

if [[ "$ACTION" != "allow" && "$ACTION" != "block" ]]; then
  echo "Usage: $0 [allow|block]"
  exit 1
fi

if [[ "$ACTION" == "allow" ]]; then
  REACHABLE=true
  BLOCKED=false
  XRPL_HINT=true
  PREVIEW="MANUAL_OVERRIDE: operator verified logged-in interactive session"
else
  REACHABLE=false
  BLOCKED=true
  XRPL_HINT=false
  PREVIEW="MANUAL_OVERRIDE: operator marked as blocked"
fi

mkdir -p "$(dirname "$STATUS_FILE")"
cat > "$STATUS_FILE" <<JSON
{
  "source": "manual-operator-override",
  "reachable": $REACHABLE,
  "blocked": $BLOCKED,
  "hasXrplHint": $XRPL_HINT,
  "preview": "$PREVIEW",
  "updatedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "[xrpl-session-override] wrote $STATUS_FILE"
cat "$STATUS_FILE"
