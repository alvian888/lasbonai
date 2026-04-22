#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

INTERVAL_SEC="${LINK_WATCH_INTERVAL_SEC:-300}"
MAX_CYCLES="${LINK_WATCH_MAX_CYCLES:-0}"
LOG_FILE="${LINK_WATCH_LOG_FILE:-$PROJECT_ROOT/data/logs/link-sentiment-watch.log}"
STATE_FILE="${LINK_WATCH_STATE_FILE:-$PROJECT_ROOT/data/link-watch-state.json}"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG_FILE"
}

send_telegram() {
  local message="$1"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    return 0
  fi

  curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${message}" \
    > /dev/null 2>&1 || true
}

read_last_alert_compared_at() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo ""
    return 0
  fi

  python3 - <<'PY' "$STATE_FILE"
import json, sys
path = sys.argv[1]
try:
    d = json.load(open(path))
    print(d.get("lastAlertComparedAt", ""))
except Exception:
    print("")
PY
}

write_last_alert_compared_at() {
  local compared_at="$1"
  python3 - <<'PY' "$STATE_FILE" "$compared_at"
import json, sys
path = sys.argv[1]
compared_at = sys.argv[2]
with open(path, "w", encoding="utf-8") as f:
    json.dump({"lastAlertComparedAt": compared_at}, f)
PY
}

extract_link_detection() {
  python3 - <<'PY' "$PROJECT_ROOT/data/telegram-sentiment-comparison.json"
import json, sys

path = sys.argv[1]
try:
    d = json.load(open(path))
except Exception:
    print("ERROR||")
    raise SystemExit(0)

compared_at = d.get("comparedAt", "")
channels = []
for ch in d.get("channels", []):
    name = ch.get("channel", "")
    syms = [str(m.get("symbol", "")).upper() for m in ch.get("mentionedTokens", [])]
    if "LINK" in syms:
        channels.append(name)

if channels:
    print("FOUND|" + compared_at + "|" + ",".join(channels))
else:
    print("NONE|" + compared_at + "|")
PY
}

log "Starting LINK watcher (interval=${INTERVAL_SEC}s maxCycles=${MAX_CYCLES})"

cycle=0
while true; do
  cycle=$((cycle + 1))

  if npm run sentiment:execute >> "$LOG_FILE" 2>&1; then
    detection="$(extract_link_detection)"
    status="${detection%%|*}"
    rest="${detection#*|}"
    compared_at="${rest%%|*}"
    channels="${rest##*|}"

    if [[ "$status" == "FOUND" ]]; then
      last_alert_compared_at="$(read_last_alert_compared_at)"
      if [[ "$compared_at" != "$last_alert_compared_at" ]]; then
        msg="LINK detected in sentiment feed. comparedAt=${compared_at}. channels=${channels}."
        log "$msg"
        send_telegram "$msg"
        write_last_alert_compared_at "$compared_at"
      else
        log "Cycle ${cycle}: LINK still detected (same comparedAt=${compared_at}), alert skipped"
      fi
    elif [[ "$status" == "NONE" ]]; then
      log "Cycle ${cycle}: no LINK detected (comparedAt=${compared_at})"
    else
      log "Cycle ${cycle}: failed to parse comparison output"
    fi
  else
    log "Cycle ${cycle}: sentiment:execute failed"
  fi

  if [[ "$MAX_CYCLES" != "0" && "$cycle" -ge "$MAX_CYCLES" ]]; then
    log "Reached max cycles (${MAX_CYCLES}), stopping"
    break
  fi

  sleep "$INTERVAL_SEC"
done
