#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

MAX_DURATION="${1:-2h}"
RESTART_DELAY="5"
BOT_PORT="${BOT_PORT:-8787}"

if ! command -v timeout >/dev/null 2>&1; then
  echo "[watchdog] required command 'timeout' not found"
  exit 1
fi

health_ok() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${BOT_PORT}/health" 2>/dev/null || true)
  [[ "$code" == "200" ]]
}

while true; do
  if health_ok; then
    echo "[watchdog] existing bot is healthy on port ${BOT_PORT}; skip spawn"
    sleep "$RESTART_DELAY"
    continue
  fi

  echo "[watchdog] starting bot with timeout=$MAX_DURATION"
  if timeout --foreground "$MAX_DURATION" npm run dev; then
    echo "[watchdog] bot exited normally"
  else
    rc=$?
    if [[ "$rc" -eq 124 || "$rc" -eq 137 ]]; then
      echo "[watchdog] bot reached timeout and was terminated (code=$rc). Restarting after $RESTART_DELAY seconds."
    else
      echo "[watchdog] bot exited unexpectedly with code=$rc. Restarting after $RESTART_DELAY seconds."
    fi
  fi
  sleep "$RESTART_DELAY"
done
