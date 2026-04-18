#!/usr/bin/env bash
# lasbonai_xmagnetic — PWA Desktop Launcher + Post-Session Learning
set -euo pipefail

DIR="/home/lasbonai/Desktop/lasbonai/okx-agentic-bot"
CHROME="$HOME/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
PROFILE="$DIR/data/browser-profile"
EXT="$DIR/extensions/metamask"
LOG_DIR="$DIR/logs"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/session-xmagnetic-${STAMP}.log"

mkdir -p "$LOG_DIR"

# Validate
[[ -x "$CHROME" ]] || { notify-send "xMagnetic" "Chrome not found" 2>/dev/null; exit 1; }
[[ -f "$EXT/manifest.json" ]] || { notify-send "xMagnetic" "MetaMask not found" 2>/dev/null; exit 1; }

# Cleanup stale processes + lock files
pkill -f "chrome-linux64/chrome.*browser-profile" 2>/dev/null && sleep 1 || true
rm -f "$PROFILE"/{SingletonLock,SingletonSocket,SingletonCookie} "$PROFILE/Default/LOCK" 2>/dev/null || true

# Rotate logs — keep last 5 sessions
find "$LOG_DIR" -maxdepth 1 -name 'session-xmagnetic-*.log' -type f | sort -r | tail -n +6 | xargs rm -f 2>/dev/null || true
find "$LOG_DIR/runs" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null || true

LOADER="file://$DIR/public/xmagnetic-loader.html"

echo "[xmagnetic] launching — $STAMP"

"$CHROME" \
  --new-window "$LOADER" \
  --user-data-dir="$PROFILE" \
  --disable-extensions-except="$EXT" \
  --load-extension="$EXT" \
  --no-sandbox --disable-setuid-sandbox \
  --no-first-run --no-default-browser-check \
  --disable-infobars --disable-notifications \
  --disable-component-update \
  --disable-features=DownloadBubble,DownloadBubbleV2 \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --class="lasbonai_xmagnetic" \
  --window-size=1366,900 \
  "$@" \
  >"$LOG" 2>&1 &

PID=$!
echo "[xmagnetic] chrome PID=$PID"

trap 'kill "$PID" 2>/dev/null || true' SIGINT SIGTERM
wait "$PID" 2>/dev/null || true
EXIT_CODE=$?

echo "[xmagnetic] closed — exit=$EXIT_CODE"
