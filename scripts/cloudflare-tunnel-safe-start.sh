#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$PROJECT_DIR/data/logs"
LOG_FILE="$LOG_DIR/cloudflared-okx-agentic-bot.log"
TARGET_URL="${CLOUDFLARE_TUNNEL_TARGET_URL:-http://127.0.0.1:8787}"
LOCAL_NAME="okx-agentic-bot-cloudflared"

mkdir -p "$LOG_DIR"

echo "[cloudflare] non-destructive mode enabled"

if ! curl -sS -m 3 "$TARGET_URL/health" >/dev/null 2>&1; then
  echo "[cloudflare] local bot is not healthy at $TARGET_URL/health"
  echo "[cloudflare] run: npm run autostart:integrated"
  exit 1
fi

if pgrep -af "cloudflared.*$TARGET_URL" >/dev/null 2>&1; then
  echo "[cloudflare] existing local cloudflared process already serving $TARGET_URL"
  echo "[cloudflare] no changes made"
  exit 0
fi

if command -v cloudflared >/dev/null 2>&1; then
  echo "[cloudflare] starting host cloudflared quick tunnel"
  nohup cloudflared tunnel --no-autoupdate --url "$TARGET_URL" > "$LOG_FILE" 2>&1 &
  sleep 2
  echo "[cloudflare] started. log: $LOG_FILE"
  grep -Eo 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  if sg docker -c "docker ps -a --format '{{.Names}}' | grep -Fx '$LOCAL_NAME'" >/dev/null 2>&1; then
    RUNNING="$(sg docker -c "docker inspect -f '{{.State.Running}}' $LOCAL_NAME" 2>/dev/null || echo false)"
    if [[ "$RUNNING" == "true" ]]; then
      echo "[cloudflare] existing docker tunnel container is already running: $LOCAL_NAME"
      echo "[cloudflare] no changes made"
      exit 0
    fi

    echo "[cloudflare] starting existing docker tunnel container: $LOCAL_NAME"
    sg docker -c "docker start $LOCAL_NAME" >/dev/null
    echo "[cloudflare] started existing container"
    exit 0
  fi

  echo "[cloudflare] cloudflared binary not found, using docker fallback"
  sg docker -c "docker run -d --name $LOCAL_NAME --network host cloudflare/cloudflared:latest tunnel --no-autoupdate --url $TARGET_URL" >/dev/null
  echo "[cloudflare] docker quick tunnel started: $LOCAL_NAME"
  echo "[cloudflare] inspect URL with: npm run cloudflare:tunnel:status"
  exit 0
fi

echo "[cloudflare] cloudflared and docker are not available"
echo "[cloudflare] install cloudflared or enable docker access"
exit 1
