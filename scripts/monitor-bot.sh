#!/bin/bash

# OKX Agentic Bot - Active Monitoring with Auto-Recovery
# Monitors bot process, detects errors, sends Telegram alerts, auto-restarts
# Features:
#   - 10-minute cycle watchdog timer
#   - Error detection and immediate Telegram alerts
#   - Auto-restart on process crash
#   - Continuous health checking

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

BOT_PORT=${BOT_PORT:-8787}
MAX_CYCLE_DURATION_MS=$((10 * 60 * 1000)) # 10 minutes in milliseconds
MAX_NO_CYCLE_FINISH_SEC=${MONITOR_MAX_NO_CYCLE_FINISH_SEC:-900}
TELEGRAM_TOKEN=${TELEGRAM_BOT_TOKEN:-"8502781876:AAH-zhd9w_w0kQFrx0OmKBpoKyWpfdrcRAI"}
TELEGRAM_CHAT=${TELEGRAM_CHAT_ID:-"8706918319"}
MONITOR_LOG="$PROJECT_ROOT/data/logs/monitor-$(date +%Y%m%d-%H%M%S).log"
BOT_PID_FILE="$PROJECT_ROOT/data/bot.pid"

mkdir -p "$PROJECT_ROOT/data/logs"

log_msg() {
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$timestamp] $1" | tee -a "$MONITOR_LOG"
}

send_telegram() {
  local message="$1"
  local escaped_msg=$(echo "$message" | sed 's/"/\\"/g')
  
  curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_TOKEN/sendMessage" \
    -H "Content-Type: application/json" \
    -d "{\"chat_id\": $TELEGRAM_CHAT, \"text\": \"$escaped_msg\", \"parse_mode\": \"HTML\"}" \
    >/dev/null 2>&1 || true
}

check_bot_health() {
  local health_url="http://127.0.0.1:$BOT_PORT/health"
  local response=$(curl -s -w "\n%{http_code}" "$health_url" 2>/dev/null || echo "")
  local http_code=$(echo "$response" | tail -1)
  
  if [[ "$http_code" == "200" ]]; then
    return 0
  else
    return 1
  fi
}

check_scheduler_stall() {
  local deep_url="http://127.0.0.1:$BOT_PORT/health/deep"
  local deep_json
  deep_json=$(curl -sS -m 5 "$deep_url" 2>/dev/null || echo "")

  if [[ -z "$deep_json" ]]; then
    # If deep endpoint is temporarily unavailable, don't hard fail monitor loop.
    echo "DEEP_UNAVAILABLE"
    return 0
  fi

  local status
  status=$(python3 - "$deep_json" "$MAX_NO_CYCLE_FINISH_SEC" <<'PY'
import json
import sys
import time

raw = sys.argv[1]
max_lag_sec = int(sys.argv[2])

try:
    payload = json.loads(raw)
except Exception:
    print("DEEP_PARSE_ERROR")
    raise SystemExit(0)

scheduler = payload.get("scheduler") or {}
running = bool(scheduler.get("running"))
last_finished = scheduler.get("lastCycleFinishedAt")
receipt_streak = int(scheduler.get("receiptFailedStreak") or 0)

if last_finished is None:
    # Startup grace: no finished cycle yet is acceptable.
    print(f"DEEP_OK lag=-1 running={running} receipt_streak={receipt_streak}")
    raise SystemExit(0)

lag_sec = int((time.time() * 1000 - int(last_finished)) / 1000)
if lag_sec > max_lag_sec:
    print(f"DEEP_STALL lag={lag_sec} running={running} receipt_streak={receipt_streak}")
    raise SystemExit(2)

print(f"DEEP_OK lag={lag_sec} running={running} receipt_streak={receipt_streak}")
PY
)
  local rc=$?

  echo "$status"
  if [[ $rc -eq 2 ]]; then
    return 2
  fi
  return 0
}

start_bot() {
  log_msg "Starting bot..."
  npm run dev > "$PROJECT_ROOT/data/logs/bot-$(date +%s).log" 2>&1 &
  local pid=$!
  echo "$pid" > "$BOT_PID_FILE"
  log_msg "Bot started with PID $pid"
  sleep 3
  
  if check_bot_health; then
    log_msg "✅ Bot health check PASSED"
    return 0
  else
    log_msg "❌ Bot health check FAILED after start"
    return 1
  fi
}

stop_bot() {
  if [[ -f "$BOT_PID_FILE" ]]; then
    local pid=$(cat "$BOT_PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      log_msg "Stopping bot (PID $pid)..."
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$BOT_PID_FILE"
  fi
}

restart_bot() {
  log_msg "⚠️ Restarting bot..."
  send_telegram "⚠️ <b>Bot Restart</b>\nBot was restarted due to health check failure or process crash.\nTimestamp: $(date '+%Y-%m-%d %H:%M:%S')"
  stop_bot
  sleep 2
  start_bot
}

monitor_cycle() {
  local cycle_start_ms
  cycle_start_ms=$(date +%s%3N)
  local cycle_count=0
  
  log_msg "=== Monitoring cycle started ==="
  
  while true; do
    sleep 5
    cycle_count=$((cycle_count + 1))
    local current_ms
    current_ms=$(date +%s%3N)
    local elapsed_ms=$((current_ms - cycle_start_ms))
    
    # Check if bot process exists
    if [[ -f "$BOT_PID_FILE" ]]; then
      local pid=$(cat "$BOT_PID_FILE")
      if ! kill -0 "$pid" 2>/dev/null; then
        log_msg "❌ Bot process (PID $pid) is not running"
        send_telegram "❌ <b>Bot Crashed</b>\nProcess died unexpectedly.\nTimestamp: $(date '+%Y-%m-%d %H:%M:%S')"
        restart_bot
        return 1
      fi
    fi
    
    # Check health endpoint
    if ! check_bot_health; then
      log_msg "❌ Bot health check failed (cycle $cycle_count, elapsed: ${elapsed_ms}ms)"
      send_telegram "❌ <b>Bot Health Failed</b>\nHealth endpoint unreachable.\nTimestamp: $(date '+%Y-%m-%d %H:%M:%S')"
      restart_bot
      return 1
    fi

    local deep_status
    deep_status=$(check_scheduler_stall || true)
    if [[ "$deep_status" == DEEP_STALL* ]]; then
      log_msg "❌ Scheduler stall detected ($deep_status)"
      send_telegram "❌ <b>Scheduler Stall Detected</b>\n$deep_status\nAction: restarting bot\nTimestamp: $(date '+%Y-%m-%d %H:%M:%S')"
      restart_bot
      return 1
    fi
    log_msg "ℹ️ $deep_status"
    
    # Check 10-minute watchdog
    if [[ $elapsed_ms -gt $MAX_CYCLE_DURATION_MS ]]; then
      log_msg "⏱️ 10-minute watchdog triggered (elapsed: ${elapsed_ms}ms)"
      send_telegram "⏱️ <b>Watchdog Timeout</b>\nCycle exceeded 10 minutes. Killing and restarting.\nElapsed: ${elapsed_ms}ms"
      restart_bot
      return 1
    fi
    
    # Check for ERROR patterns in bot logs
    local recent_errors=$(tail -100 "$PROJECT_ROOT/data/logs/bot-"*.log 2>/dev/null | grep -iE "error|exception|failed|fatal" | tail -5 || true)
    if [[ -n "$recent_errors" ]]; then
      log_msg "⚠️ Errors detected in bot logs:"
      echo "$recent_errors" | while read -r line; do
        log_msg "  $line"
      done
      
      # Send error alert
      local error_summary=$(echo "$recent_errors" | head -3 | sed 's/$/\\n/' | tr -d '\n')
      send_telegram "⚠️ <b>Bot Errors Detected</b>\nErrors found in recent logs:\n\n$error_summary\n\nTimestamp: $(date '+%Y-%m-%d %H:%M:%S')"
    fi
    
    log_msg "✅ Health check OK (cycle $cycle_count, elapsed: ${elapsed_ms}ms)"
  done
}

main() {
  log_msg "=================================================="
  log_msg "OKX Agentic Bot Monitoring Started"
  log_msg "Features: 10-min watchdog, error detection, auto-restart"
  log_msg "=================================================="
  
  # Start bot if not running
  if ! check_bot_health; then
    log_msg "Bot is not healthy, starting..."
    start_bot || {
      log_msg "❌ Failed to start bot"
      send_telegram "❌ <b>Bot Startup Failed</b>\nCould not start bot on first attempt.\nCheck logs at: $MONITOR_LOG"
      exit 1
    }
  else
    log_msg "✅ Bot is already running and healthy"
  fi
  
  # Continuous monitoring
  while true; do
    monitor_cycle
    log_msg "Cycle completed, restarting monitoring..."
  done
}

# Trap signals for graceful shutdown
trap 'log_msg "Monitor shutting down..."; stop_bot; exit 0' SIGTERM SIGINT

main
