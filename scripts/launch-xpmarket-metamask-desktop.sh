#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="/home/lasbonai/Desktop/lasbonai/okx-agentic-bot"
LOG_DIR="$PROJECT_DIR/logs"
RUN_LOG_DIR="$LOG_DIR/runs"
STAMP="$(date +%Y%m%d-%H%M%S)"
STATE_CHECK_LOG="$RUN_LOG_DIR/${STAMP}-xpmarket-state-check.log"
STATE_EXPORT_LOG="$RUN_LOG_DIR/${STAMP}-xpmarket-state-export.log"
SESSION_LOG="$RUN_LOG_DIR/${STAMP}-xpmarket-launch.log"

if [[ ! -f "$PROJECT_DIR/src/connect-xpmarket-wallet.ts" ]]; then
  echo "[launcher] missing file: $PROJECT_DIR/src/connect-xpmarket-wallet.ts" >&2
  exit 1
fi

mkdir -p "$LOG_DIR" "$RUN_LOG_DIR"

# Verify XRPL Snap state before opening Chromium. Do not block launch if the check fails.
npm --prefix "$PROJECT_DIR" run xpmarket:state:check >"$STATE_CHECK_LOG" 2>&1 || true
npm --prefix "$PROJECT_DIR" run xpmarket:state:export >"$STATE_EXPORT_LOG" 2>&1 || true

# Keep a timestamped session log for the Chromium launch itself.
exec > >(tee -a "$SESSION_LOG") 2>&1
echo "[launcher] stamp=$STAMP"
echo "[launcher] state_check_log=$STATE_CHECK_LOG"
echo "[launcher] state_export_log=$STATE_EXPORT_LOG"
echo "[launcher] session_log=$SESSION_LOG"

# Launch headed Chromium session with MetaMask and keep it open.
exec env HEADLESS=0 npm --prefix "$PROJECT_DIR" exec tsx "$PROJECT_DIR/src/connect-xpmarket-wallet.ts" -- --keep-open
