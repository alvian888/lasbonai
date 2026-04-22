#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/production.log"
PWA_URL="${AUTOSTART_PWA_URL:-http://127.0.0.1:8787}"
OPEN_PWA="${AUTOSTART_OPEN_BROWSER_PWA:-true}"
HEALTH_URL="http://127.0.0.1:8787/health"
START_RETRIES="${AUTOSTART_START_RETRIES:-3}"
HEALTH_WAIT_SECONDS="${AUTOSTART_HEALTH_WAIT_SECONDS:-20}"
LOCK_FILE="$PROJECT_DIR/data/autostart-integrated.lock"
LOCK_MODE="none"
ENABLE_WATCHDOG="${AUTOSTART_ENABLE_WATCHDOG:-false}"
WATCHDOG_SCRIPT="${AUTOSTART_WATCHDOG_SCRIPT:-monitor:bot}"
WATCHDOG_LOG="$LOG_DIR/watchdog.log"
ENABLE_BROWSER_STAY_ALIVE="${AUTOSTART_ENABLE_BROWSER_STAY_ALIVE:-true}"
BROWSER_STAY_ALIVE_LOG="$LOG_DIR/browser-stay-alive.log"

mkdir -p "$LOG_DIR"

cleanup_lock() {
  if [[ "$LOCK_MODE" == "pidfile" ]]; then
    rm -f "$LOCK_FILE"
  fi
}

acquire_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
      echo "[autostart] another autostart instance is running (flock lock active), skipping"
      exit 0
    fi
    LOCK_MODE="flock"
    return 0
  fi

  if [[ -f "$LOCK_FILE" ]]; then
    local old_pid
    old_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "[autostart] another autostart instance is running (pid=$old_pid), skipping"
      exit 0
    fi
  fi

  echo "$$" > "$LOCK_FILE"
  LOCK_MODE="pidfile"
}

acquire_lock
trap cleanup_lock EXIT

is_healthy() {
  curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1
}

stop_existing_bot() {
  pkill -f "tsx src/server.ts" 2>/dev/null || true
  pkill -f "node dist/server.js" 2>/dev/null || true
  fuser -k 8787/tcp 2>/dev/null || true
}

start_bot_with_retry() {
  local attempt
  for attempt in $(seq 1 "$START_RETRIES"); do
    echo "[autostart] start attempt $attempt/$START_RETRIES"
    stop_existing_bot
    sleep 2

    THREADPOOL_SIZE="${BOT_UV_THREADPOOL_SIZE:-$(nproc 2>/dev/null || echo 16)}"
    nohup env UV_THREADPOOL_SIZE="$THREADPOOL_SIZE" npm start > "$LOG_FILE" 2>&1 &

    local i
    for i in $(seq 1 "$HEALTH_WAIT_SECONDS"); do
      if is_healthy; then
        echo "[autostart] bot health ok (attempt $attempt)"
        return 0
      fi
      sleep 1
    done

    echo "[autostart] health check failed on attempt $attempt"
    if [[ -f "$LOG_FILE" ]]; then
      echo "[autostart] recent logs:"
      tail -20 "$LOG_FILE" || true
    fi
  done

  return 1
}

start_watchdog_if_enabled() {
  if [[ "$ENABLE_WATCHDOG" != "true" ]]; then
    return 0
  fi

  if pgrep -af "scripts/monitor-bot.sh|scripts/watchdog-loop.sh" >/dev/null 2>&1; then
    echo "[autostart] watchdog already running"
    return 0
  fi

  echo "[autostart] starting watchdog via npm run $WATCHDOG_SCRIPT"
  nohup npm run "$WATCHDOG_SCRIPT" > "$WATCHDOG_LOG" 2>&1 &
}

start_browser_stay_alive_if_enabled() {
  if [[ "$ENABLE_BROWSER_STAY_ALIVE" != "true" ]]; then
    return 0
  fi

  if pgrep -af "scripts/browser-stay-alive.sh" >/dev/null 2>&1; then
    echo "[autostart] browser stay-alive already running"
    return 0
  fi

  echo "[autostart] starting browser stay-alive"
  nohup npm run browser:stay-alive > "$BROWSER_STAY_ALIVE_LOG" 2>&1 &
}

echo "[autostart] integrating local agent first"
cd "$PROJECT_DIR"
npm run compute:apply
npm run integrate:local-agent

echo "[autostart] refreshing lasbonai-trading model"
RESTART_BOT=false bash "$PROJECT_DIR/scripts/update-lasbonai-trading-model.sh"

if is_healthy; then
  echo "[autostart] bot already running"
else
  echo "[autostart] bot unhealthy, starting with auto-retry"
  if ! start_bot_with_retry; then
    echo "[autostart] bot failed to reach healthy state after $START_RETRIES attempts"
    echo "[autostart] check log: $LOG_FILE"
    exit 1
  fi
fi

for _ in {1..10}; do
  if is_healthy; then
    echo "[autostart] bot health ok"
    break
  fi
  sleep 1
done

if ! is_healthy; then
  echo "[autostart] bot failed to reach healthy state"
  echo "[autostart] check log: $LOG_FILE"
  exit 1
fi

start_watchdog_if_enabled
start_browser_stay_alive_if_enabled

if [[ "$OPEN_PWA" != "true" ]]; then
  echo "[autostart] PWA launch skipped by AUTOSTART_OPEN_BROWSER_PWA=$OPEN_PWA"
  exit 0
fi

launch_browser_app() {
  local url="$1"
  if command -v google-chrome >/dev/null 2>&1; then
    google-chrome --app="$url" >/dev/null 2>&1 &
    return 0
  fi
  if command -v chromium-browser >/dev/null 2>&1; then
    chromium-browser --app="$url" >/dev/null 2>&1 &
    return 0
  fi
  if command -v chromium >/dev/null 2>&1; then
    chromium --app="$url" >/dev/null 2>&1 &
    return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
    return 0
  fi
  return 1
}

if launch_browser_app "$PWA_URL"; then
  echo "[autostart] PWA opened: $PWA_URL"
else
  echo "[autostart] no supported browser launcher found; open manually: $PWA_URL"
fi
