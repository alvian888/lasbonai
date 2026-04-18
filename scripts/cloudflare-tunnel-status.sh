#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="$PROJECT_DIR/data/logs/cloudflared-okx-agentic-bot.log"
LOCAL_NAME="okx-agentic-bot-cloudflared"

echo "[cloudflare] status (non-destructive)"

if pgrep -a cloudflared >/dev/null 2>&1; then
  echo "[cloudflare] host processes:"
  pgrep -a cloudflared
else
  echo "[cloudflare] host processes: none"
fi

if [[ -f "$LOG_FILE" ]]; then
  echo "[cloudflare] latest host tunnel URL from log:"
  grep -Eo 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' "$LOG_FILE" | tail -n 1 || true
fi

if command -v docker >/dev/null 2>&1; then
  if sg docker -c "docker ps -a --format '{{.Names}}' | grep -Fx '$LOCAL_NAME'" >/dev/null 2>&1; then
    echo "[cloudflare] docker container state:"
    sg docker -c "docker ps -a --filter name=^/$LOCAL_NAME$ --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'"
    echo "[cloudflare] possible tunnel URL from container logs:"
    sg docker -c "docker logs --tail 80 $LOCAL_NAME 2>&1 | grep -Eo 'https://[-a-zA-Z0-9]+\.trycloudflare\.com' | tail -n 1" || true
  else
    echo "[cloudflare] docker container $LOCAL_NAME not found"
  fi
fi
