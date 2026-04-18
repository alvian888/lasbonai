#!/usr/bin/env bash
# lasbonai_xpmarket — PWA Desktop Launcher + Post-Session Learning
set -euo pipefail

DIR="/home/lasbonai/Desktop/lasbonai/okx-agentic-bot"
CHROME="$HOME/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome"
PROFILE="$DIR/data/browser-profile"
EXT="$DIR/extensions/metamask"
LOG_DIR="$DIR/logs"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOG_DIR/session-${STAMP}.log"

mkdir -p "$LOG_DIR"

# Validate
[[ -x "$CHROME" ]] || { notify-send "XPMarket" "Chrome not found" 2>/dev/null; exit 1; }
[[ -f "$EXT/manifest.json" ]] || { notify-send "XPMarket" "MetaMask not found" 2>/dev/null; exit 1; }

# Cleanup stale processes + lock files
pkill -f "chrome-linux64/chrome.*browser-profile" 2>/dev/null && sleep 1 || true
rm -f "$PROFILE"/{SingletonLock,SingletonSocket,SingletonCookie} "$PROFILE/Default/LOCK" 2>/dev/null || true

# Rotate logs — keep last 5 sessions
find "$LOG_DIR" -maxdepth 1 -name 'session-*.log' -type f | sort -r | tail -n +6 | xargs rm -f 2>/dev/null || true
find "$LOG_DIR/runs" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null || true

SESSION_START="$(date -Iseconds)"
LOADER="file://$DIR/public/xpmarket-loader.html"

echo "[xpmarket] launching — $STAMP"

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
  --class="lasbonai_xpmarket" \
  --window-size=1366,900 \
  "$@" \
  >"$LOG" 2>&1 &

PID=$!
echo "[xpmarket] chrome PID=$PID"

trap 'kill "$PID" 2>/dev/null || true' SIGINT SIGTERM
wait "$PID" 2>/dev/null || true
EXIT_CODE=$?

SESSION_END="$(date -Iseconds)"
echo "[xpmarket] closed — exit=$EXIT_CODE"

# Post-session learning (lightweight — no headless browser)
export SESSION_STAMP="$STAMP" SESSION_EXIT_CODE="$EXIT_CODE" SESSION_START SESSION_END
export CHROME_LOG_PATH="$PROFILE/chrome_debug.log"

cd "$DIR"
npx tsx src/post-session-learn.ts 2>&1 | tee -a "$LOG"
