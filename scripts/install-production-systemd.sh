#!/usr/bin/env bash
# install-production-systemd.sh
# Installs both okx-bot.service (main bot) and noc-probe-runner.service + timer
# Safe to re-run — idempotent

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SYSTEMD_SRC="$SCRIPT_DIR/systemd"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

# ---- Colors ----
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}[OK]${RESET} $*"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $*"; }
fail() { echo -e "${RED}[FAIL]${RESET} $*"; exit 1; }
info() { echo -e "[INFO] $*"; }

echo ""
echo "======================================"
echo " OKX Agentic Bot — Production Systemd"
echo "======================================"
echo "Project: $PROJECT_DIR"
echo "Systemd user dir: $SYSTEMD_USER_DIR"
echo ""

# ---- Preflight checks ----
[[ -f "$PROJECT_DIR/.env" ]] || fail ".env not found at $PROJECT_DIR/.env"
[[ -f "$PROJECT_DIR/package.json" ]] || fail "package.json not found at $PROJECT_DIR"
[[ -d "$PROJECT_DIR/node_modules" ]] || fail "node_modules missing — run 'npm install' first"

info "Preflight OK"
echo ""

# ---- Ensure target dir exists ----
mkdir -p "$SYSTEMD_USER_DIR"

# ---- Ensure log dir exists ----
mkdir -p "$PROJECT_DIR/data/logs"
ok "Log dir: $PROJECT_DIR/data/logs"

# ---- Helper: install service from template ----
install_service() {
    local name="$1"          # e.g. okx-bot
    local src_file="$2"      # path to template

    info "Installing ${name}.service ..."

    # Replace __PROJECT_DIR__ placeholder
    sed "s|__PROJECT_DIR__|$PROJECT_DIR|g" "$src_file" \
        > "$SYSTEMD_USER_DIR/${name}.service"

    ok "${name}.service → $SYSTEMD_USER_DIR/${name}.service"
}

# ---- Helper: install timer (no placeholder) ----
install_timer() {
    local name="$1"
    local src_file="$2"

    info "Installing ${name}.timer ..."
    cp "$src_file" "$SYSTEMD_USER_DIR/${name}.timer"
    ok "${name}.timer → $SYSTEMD_USER_DIR/${name}.timer"
}

# ---- Install bot service ----
[[ -f "$SYSTEMD_SRC/okx-bot.service" ]] || fail "Template not found: $SYSTEMD_SRC/okx-bot.service"
install_service "okx-bot" "$SYSTEMD_SRC/okx-bot.service"

# ---- Install NOC probe runner service + timer ----
[[ -f "$SYSTEMD_SRC/noc-probe-runner.service" ]] || fail "Template not found: $SYSTEMD_SRC/noc-probe-runner.service"
[[ -f "$SYSTEMD_SRC/noc-probe-runner.timer" ]] || fail "Template not found: $SYSTEMD_SRC/noc-probe-runner.timer"
install_service "noc-probe-runner" "$SYSTEMD_SRC/noc-probe-runner.service"
install_timer   "noc-probe-runner" "$SYSTEMD_SRC/noc-probe-runner.timer"

echo ""
info "Running systemd daemon-reload ..."
systemctl --user daemon-reload && ok "daemon-reload OK"

# ---- Verify files ----
echo ""
info "Verifying unit files ..."
VERIFY_FAILED=0
for unit in okx-bot.service noc-probe-runner.service noc-probe-runner.timer; do
    if systemd-analyze --user verify "$SYSTEMD_USER_DIR/$unit" 2>&1; then
        ok "  verify: $unit"
    else
        warn "  verify warning on $unit (may be non-fatal)"
    fi
done

# ---- Enable units ----
echo ""
info "Enabling okx-bot.service ..."
systemctl --user enable okx-bot.service && ok "okx-bot.service enabled (auto-start at login)"

info "Enabling noc-probe-runner.timer ..."
systemctl --user enable noc-probe-runner.timer && ok "noc-probe-runner.timer enabled (auto-start at login)"

# ---- Summary ----
echo ""
echo "============================================"
echo " Installation complete."
echo "============================================"
echo ""
echo "Next steps:"
echo ""
echo "  1. Enable lingering (services survive logout/reboot):"
echo "       loginctl enable-linger"
echo ""
echo "  2. Stop the manually-running bot process:"
echo "       pkill -f 'tsx src/server.ts' || true"
echo ""
echo "  3. Start bot under systemd:"
echo "       systemctl --user start okx-bot.service"
echo ""
echo "  4. Start NOC probe timer:"
echo "       systemctl --user start noc-probe-runner.timer"
echo ""
echo "  5. Verify:"
echo "       systemctl --user status okx-bot.service"
echo "       systemctl --user status noc-probe-runner.timer"
echo "       systemctl --user list-timers | grep noc"
echo "       curl -s http://localhost:8787/health"
echo ""
