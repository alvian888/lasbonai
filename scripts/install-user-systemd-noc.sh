#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$PROJECT_DIR/scripts/systemd"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SERVICE_SRC="$SRC_DIR/noc-probe-runner.service"
TIMER_SRC="$SRC_DIR/noc-probe-runner.timer"
SERVICE_DEST="$SYSTEMD_USER_DIR/noc-probe-runner.service"
TIMER_DEST="$SYSTEMD_USER_DIR/noc-probe-runner.timer"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl not found. Install systemd first."
  exit 1
fi

mkdir -p "$SYSTEMD_USER_DIR"
sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$SERVICE_SRC" > "$SERVICE_DEST"
cp "$TIMER_SRC" "$TIMER_DEST"

if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "$SERVICE_DEST" "$TIMER_DEST"
fi

systemctl --user daemon-reload
systemctl --user enable --now noc-probe-runner.timer
systemctl --user start noc-probe-runner.service || true

next_trigger="$(systemctl --user list-timers noc-probe-runner.timer --no-pager --no-legend 2>/dev/null | awk '{print $1" "$2" "$3" "$4" "$5}' | head -1)"
echo "[systemd-noc] installed user timer: noc-probe-runner.timer"
if [[ -n "$next_trigger" ]]; then
  echo "[systemd-noc] next trigger: $next_trigger"
fi

systemctl --user status noc-probe-runner.timer --no-pager || true
