#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/browser-stay-alive.log"
LOCK_FILE="$PROJECT_DIR/data/browser-stay-alive.lock"
CHECK_INTERVAL="${BROWSER_STAY_ALIVE_INTERVAL_SECONDS:-30}"
START_COOLDOWN="${BROWSER_STAY_ALIVE_START_COOLDOWN_SECONDS:-12}"
PROFILE_MARKER="${BROWSER_STAY_ALIVE_PROFILE_MARKER:-data/google-oauth-profile}"

mkdir -p "$LOG_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[browser-stay-alive] already running"
  exit 0
fi

cd "$PROJECT_DIR"

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

is_anodos_browser_running() {
  pgrep -af "okx-wallet-browser.ts --url https://dex.anodos.finance/portfolio|${PROFILE_MARKER}" >/dev/null 2>&1
}

log() {
  echo "[$(timestamp)] $1" | tee -a "$LOG_FILE"
}

log "started"

while true; do
  if is_anodos_browser_running; then
    npm run -s xrpl:session:allow >/dev/null 2>&1 || true
    log "browser running -> refreshed xrpl session bridge"
    sleep "$CHECK_INTERVAL"
    continue
  fi

  log "browser not detected -> starting okx:wallet:anodos"
  nohup npm run okx:wallet:anodos >> "$LOG_FILE" 2>&1 &
  sleep "$START_COOLDOWN"

  if is_anodos_browser_running; then
    npm run -s xrpl:session:allow >/dev/null 2>&1 || true
    log "browser start detected -> session bridge refreshed"
  else
    npm run -s xrpl:session:block >/dev/null 2>&1 || true
    log "browser still not detected -> session marked blocked"
  fi

  sleep "$CHECK_INTERVAL"
done
