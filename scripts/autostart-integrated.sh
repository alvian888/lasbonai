#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/production.log"
PWA_URL="${AUTOSTART_PWA_URL:-http://127.0.0.1:8787}"
OPEN_PWA="${AUTOSTART_OPEN_BROWSER_PWA:-true}"

mkdir -p "$LOG_DIR"

echo "[autostart] integrating local agent first"
cd "$PROJECT_DIR"
npm run compute:apply
npm run integrate:local-agent

if curl -sS -m 3 http://127.0.0.1:8787/health >/dev/null 2>&1; then
  echo "[autostart] bot already running"
else
  echo "[autostart] starting bot service in background"
  THREADPOOL_SIZE="${BOT_UV_THREADPOOL_SIZE:-$(nproc 2>/dev/null || echo 16)}"
  nohup env UV_THREADPOOL_SIZE="$THREADPOOL_SIZE" npm start > "$LOG_FILE" 2>&1 &
fi

for _ in {1..20}; do
  if curl -sS -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then
    echo "[autostart] bot health ok"
    break
  fi
  sleep 1
done

if ! curl -sS -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then
  echo "[autostart] bot failed to reach healthy state"
  echo "[autostart] check log: $LOG_FILE"
  exit 1
fi

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
