#!/bin/bash
#
# Advanced Bot Monitor: 10-minute stuck detection, auto-recovery, real-time error detection
# Usage: bash scripts/advanced-monitor.sh [--check-interval 30] [--telegram-monitor]
#

set -e

LOCK_FILE="/tmp/okx-advanced-monitor.lock"

if command -v flock >/dev/null 2>&1; then
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO: advanced-monitor already running, exiting"
    exit 0
  fi
fi

BOT_PORT=${BOT_PORT:-8787}
BOT_URL="http://localhost:${BOT_PORT}"
HEALTH_ENDPOINT="${BOT_URL}/health/deep"
STUCK_TIMEOUT_SECS=600  # 10 minutes
CHECK_INTERVAL_SECS=${CHECK_INTERVAL_SECS:-30}
MAX_CONSECUTIVE_STUCK=2
STUCK_COUNT=0
LAST_CYCLE_END=0
LAST_CHECK_TIME=0
ENABLE_TELEGRAM_MONITOR=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --check-interval) CHECK_INTERVAL_SECS="$2"; shift 2;;
    --telegram-monitor) ENABLE_TELEGRAM_MONITOR=true; shift;;
    *) shift;;
  esac
done

# Color output
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
  echo -e "${BLUE}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} INFO: $1"
}

log_warn() {
  echo -e "${YELLOW}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} WARN: $1"
}

log_error() {
  echo -e "${RED}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} ERROR: $1"
}

log_success() {
  echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} SUCCESS: $1"
}

check_bot_health() {
  if ! curl -s "${HEALTH_ENDPOINT}" > /dev/null 2>&1; then
    return 1
  fi
  return 0
}

get_scheduler_snapshot() {
  local payload
  payload=$(curl -s "${HEALTH_ENDPOINT}" 2>/dev/null || true)

  if [[ -z "${payload}" ]]; then
    echo "0 0 false"
    return 0
  fi

  if command -v jq >/dev/null 2>&1; then
    local last_finished last_started running
    last_finished=$(echo "${payload}" | jq -r '.scheduler.lastCycleFinishedAt // 0' 2>/dev/null || echo "0")
    last_started=$(echo "${payload}" | jq -r '.scheduler.lastCycleStartedAt // 0' 2>/dev/null || echo "0")
    running=$(echo "${payload}" | jq -r '.scheduler.running // false' 2>/dev/null || echo "false")
    echo "${last_finished} ${last_started} ${running}"
    return 0
  fi

  # Fallback parser without jq
  local last_finished last_started running
  last_finished=$(echo "${payload}" | grep -o '"lastCycleFinishedAt":[0-9]*' | head -1 | cut -d: -f2)
  last_started=$(echo "${payload}" | grep -o '"lastCycleStartedAt":[0-9]*' | head -1 | cut -d: -f2)
  running=$(echo "${payload}" | grep -o '"running":\(true\|false\)' | head -1 | cut -d: -f2)

  echo "${last_finished:-0} ${last_started:-0} ${running:-false}"
}

send_telegram_alert() {
  local message="$1"
  local severity="${2:-HIGH}"
  
  if [[ -n "${TELEGRAM_BOT_TOKEN}" ]] && [[ -n "${TELEGRAM_CHAT_ID}" ]]; then
    curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      -d "chat_id=${TELEGRAM_CHAT_ID}" \
      -d "text=🚨 [${severity}] Bot Monitor Alert: ${message}" \
      > /dev/null 2>&1 || true
  fi
}

recover_bot() {
  log_error "Bot appears stuck! Initiating recovery..."
  send_telegram_alert "Bot stuck for ${STUCK_TIMEOUT_SECS}s. Killing and restarting..." "CRITICAL"
  
  # Kill existing processes
  pkill -f "tsx src/server" 2>/dev/null || true
  sleep 2
  
  # Clear port
  fuser -k ${BOT_PORT}/tcp 2>/dev/null || true
  sleep 2
  
  # Restart bot
  log_info "Restarting bot..."
  cd "$(dirname "$0")/.."
  nohup npm run dev > data/logs/production.log 2>&1 &
  BOT_PID=$!
  
  sleep 5
  
  if check_bot_health; then
    log_success "Bot recovered successfully (PID: $BOT_PID)"
    send_telegram_alert "Bot recovered successfully after restart" "INFO"
    STUCK_COUNT=0
    return 0
  else
    log_error "Bot recovery failed after restart"
    send_telegram_alert "Bot recovery FAILED after restart attempt" "CRITICAL"
    return 1
  fi
}

monitor_cycle() {
  local snapshot
  snapshot=$(get_scheduler_snapshot)
  local current_cycle_end current_cycle_started scheduler_running
  current_cycle_end=$(echo "${snapshot}" | awk '{print $1}')
  current_cycle_started=$(echo "${snapshot}" | awk '{print $2}')
  scheduler_running=$(echo "${snapshot}" | awk '{print $3}')

  local current_time_ms
  current_time_ms=$(( $(date +%s) * 1000 ))
  local stuck_threshold_ms
  stuck_threshold_ms=$(( STUCK_TIMEOUT_SECS * 1000 ))

  # Warm-up guard: do not treat a fresh start with no completed cycle as stuck.
  if [[ "${current_cycle_end}" -le 0 ]]; then
    if [[ "${scheduler_running}" != "true" ]]; then
      log_warn "Scheduler is not running yet (startup/warm-up)"
      return 0
    fi

    if [[ "${current_cycle_started}" -gt 0 ]]; then
      local time_since_start_ms
      time_since_start_ms=$(( current_time_ms - current_cycle_started ))
      if [[ ${time_since_start_ms} -gt ${stuck_threshold_ms} ]]; then
        log_warn "Bot appears stuck: first cycle running for $((time_since_start_ms / 1000))s"
        ((STUCK_COUNT++))
        if [[ ${STUCK_COUNT} -ge ${MAX_CONSECUTIVE_STUCK} ]]; then
          recover_bot
        fi
        return 1
      fi
      log_info "Scheduler warm-up: first cycle in progress for $((time_since_start_ms / 1000))s"
      return 0
    fi

    log_warn "No scheduler cycle timestamps yet"
    return 0
  fi

  local time_since_cycle_ms
  time_since_cycle_ms=$(( current_time_ms - current_cycle_end ))

  if [[ ${time_since_cycle_ms} -gt ${stuck_threshold_ms} ]]; then
    log_warn "Bot appears stuck: no cycle completion for $((time_since_cycle_ms / 1000))s"
    ((STUCK_COUNT++))

    if [[ ${STUCK_COUNT} -ge ${MAX_CONSECUTIVE_STUCK} ]]; then
      recover_bot
    fi
    return 1
  fi

  if [[ ${STUCK_COUNT} -gt 0 ]]; then
    log_info "Bot recovered from stuck state (${STUCK_COUNT} stall detected)"
    STUCK_COUNT=0
  fi

  return 0
}

main() {
  log_info "Starting advanced bot monitor..."
  log_info "Health endpoint: ${HEALTH_ENDPOINT}"
  log_info "Stuck timeout: ${STUCK_TIMEOUT_SECS}s"
  log_info "Check interval: ${CHECK_INTERVAL_SECS}s"
  
  while true; do
    if ! check_bot_health; then
      log_error "Bot health check failed - attempting recovery"
      recover_bot || true
    else
      if monitor_cycle; then
        log_info "✓ Bot running normally"
      fi
    fi
    
    sleep "${CHECK_INTERVAL_SECS}"
  done
}

trap 'log_info "Monitor stopped"; exit 0' SIGTERM SIGINT

main
