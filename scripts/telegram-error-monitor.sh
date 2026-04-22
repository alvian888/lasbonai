#!/bin/bash
#
# Real-time Telegram Error Monitor: watches Telegram for error messages and bot alerts
# Integrates with bot's telegram.ts to catch and respond to trading errors
# Usage: bash scripts/telegram-error-monitor.sh [--polling-interval 10]
#

set -e

LOCK_FILE="/tmp/okx-telegram-error-monitor.lock"

if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO: telegram-error-monitor already running, exiting"
    exit 0
  fi
fi

POLLING_INTERVAL_SECS=10  # Check for new messages every N seconds
TARGET_CHAT="@OKXONE_BOT"
ERROR_KEYWORDS=("error" "failed" "exception" "critical" "stuck" "timeout" "insufficient" "slippage" "reverted")
LAST_MESSAGE_ID=0
LOG_FILE="data/logs/telegram-errors.log"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --polling-interval)
      if [[ -n "${2:-}" ]]; then
        POLLING_INTERVAL_SECS="$2"
        shift 2
      else
        echo "Missing value for --polling-interval"
        exit 1
      fi
      ;;
    *)
      shift
      ;;
  esac
done

# Ensure log file exists
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] INFO: $1"
  echo -e "${BLUE}${msg}${NC}"
}

log_error() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $1"
  echo -e "${RED}${msg}${NC}"
}

log_success() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] ✓ $1"
  echo -e "${GREEN}${msg}${NC}"
}

# Check if message contains error keywords
is_error_message() {
  local text="$1"
  for keyword in "${ERROR_KEYWORDS[@]}"; do
    if echo "$text" | grep -qi "$keyword"; then
      return 0
    fi
  done
  return 1
}

# Fetch latest messages from Telegram (requires TELEGRAM_BOT_TOKEN)
fetch_telegram_updates() {
  local bot_token="${TELEGRAM_BOT_TOKEN}"
  local chat_id="${TELEGRAM_CHAT_ID}"
  
  if [[ -z "$bot_token" ]] || [[ -z "$chat_id" ]]; then
    log_error "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set"
    return 1
  fi
  
  # Use npm script to fetch updates
  npm run telegram:updates 2>/dev/null || true
}

# Parse and monitor production.log for new errors in real-time
monitor_production_log() {
  local log_file="data/logs/production.log"
  local last_size=0

  if [[ -f "$log_file" ]]; then
    last_size=$(stat -f%z "$log_file" 2>/dev/null || stat -c%s "$log_file" 2>/dev/null || echo 0)
  fi
  
  while true; do
    if [[ ! -f "$log_file" ]]; then
      sleep "$POLLING_INTERVAL_SECS"
      continue
    fi
    
    local current_size=$(stat -f%z "$log_file" 2>/dev/null || stat -c%s "$log_file" 2>/dev/null || echo 0)
    
    if [[ $current_size -gt $last_size ]]; then
      # New log entries - check for errors
      local tail_size=$((current_size - last_size))
      local new_entries=$(tail -c "$tail_size" "$log_file" 2>/dev/null || tail -"$tail_size" "$log_file")
      
      if is_error_message "$new_entries"; then
        log_error "Error detected in production log:"
        echo "$new_entries" | tail -5 | while read -r line; do
          echo "  → $line"
        done
        
        # Extract error message for telegram
        local error_msg
        error_msg=$(echo "$new_entries" | grep -Ei "error|fail" | tail -1 || true)
        if [[ -n "$error_msg" ]]; then
          send_error_alert "$error_msg"
        fi
      fi
      
      last_size=$current_size
    fi
    
    sleep "$POLLING_INTERVAL_SECS"
  done
}

send_error_alert() {
  local error_msg="$1"
  local short_msg=$(echo "$error_msg" | cut -c1-200)
  
  if [[ -n "${TELEGRAM_BOT_TOKEN}" ]] && [[ -n "${TELEGRAM_CHAT_ID}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=⚠️ Trading Bot Error Detected:\\n\\n${short_msg}" \
      > /dev/null 2>&1 || true
  fi
  
  log_error "Alert sent for: $short_msg"
}

main() {
  log_info "Starting Telegram Error Monitor"
  log_info "Polling interval: ${POLLING_INTERVAL_SECS}s"
  log_info "Log file: ${LOG_FILE}"
  log_info "Watching for error keywords: ${ERROR_KEYWORDS[*]}"
  
  monitor_production_log
}

trap 'log_info "Monitor stopped"; exit 0' SIGTERM SIGINT

main
