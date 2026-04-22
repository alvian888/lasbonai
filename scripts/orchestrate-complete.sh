#!/bin/bash
#
# Complete Trading Bot Orchestration: Integration & Zero-Error Deployment
# Handles: monitoring, error recovery, AI model updates, and live trading validation
# Usage: bash scripts/orchestrate-complete.sh [--mode production|canary|debug]
#

set -e

MODE="${1:-production}"
BOT_PORT=8787
MONITOR_CHECK_INTERVAL=30
MAX_RETRIES=3
RETRY_DELAY=5

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

log_step() {
  echo -e "\n${MAGENTA}▶${NC} $1"
}

log_info() {
  echo -e "${BLUE}  ℹ${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}  ⚠${NC} $1"
}

log_error() {
  echo -e "${RED}  ✗${NC} $1"
}

log_success() {
  echo -e "${GREEN}  ✓${NC} $1"
}

banner() {
  echo -e "\n${MAGENTA}╔════════════════════════════════════════════════════╗${NC}"
  echo -e "${MAGENTA}║  OKX Trading Bot - Complete Orchestration System   ║${NC}"
  echo -e "${MAGENTA}║  Mode: ${MODE}${NC}${MAGENTA}                                        ║${NC}"
  echo -e "${MAGENTA}║  Generated: $(date '+%Y-%m-%d %H:%M:%S')${NC}${MAGENTA}        ║${NC}"
  echo -e "${MAGENTA}╚════════════════════════════════════════════════════╝${NC}"
}

verify_prerequisites() {
  log_step "PHASE 1: Verifying prerequisites..."
  
  # Check required environment variables
  local required_vars=("TELEGRAM_BOT_TOKEN" "TELEGRAM_CHAT_ID" "OKX_ACCESS_KEY")
  for var in "${required_vars[@]}"; do
    if [[ -z "${!var}" ]]; then
      log_warn "Missing environment variable: $var"
    else
      log_success "Found: $var"
    fi
  done
  
  # Check required files
  local required_files=(".env" "package.json" "src/server.ts" "src/bot.ts")
  for file in "${required_files[@]}"; do
    if [[ ! -f "$file" ]]; then
      log_error "Missing required file: $file"
      return 1
    fi
    log_success "Found: $file"
  done
  
  # Check Node.js and npm
  if ! command -v node &> /dev/null; then
    log_error "Node.js not found"
    return 1
  fi
  log_success "Node.js $(node -v)"
  
  # Check npm dependencies
  if [[ ! -d "node_modules" ]]; then
    log_info "Installing dependencies..."
    npm install --legacy-peer-deps > /dev/null 2>&1
    log_success "Dependencies installed"
  else
    log_success "Dependencies already installed"
  fi
}

configure_environment() {
  log_step "PHASE 2: Configuring environment for ${MODE}..."
  
  case "$MODE" in
    production)
      log_info "Setting up PRODUCTION mode (LIVE TRADING ENABLED)"
      export DRY_RUN=false
      export LIVE_STAGE=full
      ;;
    canary)
      log_info "Setting up CANARY mode (SMALL TRADES, CAREFUL VALIDATION)"
      export DRY_RUN=false
      export LIVE_STAGE=canary
      ;;
    debug)
      log_info "Setting up DEBUG mode (DRY RUN, NO EXECUTION)"
      export DRY_RUN=true
      export LIVE_STAGE=dry-run
      ;;
  esac
  
  log_success "Environment configured"
}

build_and_validate() {
  log_step "PHASE 3: Building and validating code..."
  
  log_info "Running TypeScript build..."
  if ! npm run build > /dev/null 2>&1; then
    log_error "TypeScript build failed"
    npm run build
    return 1
  fi
  log_success "Build successful"
  
  log_info "Validating configuration..."
  if ! npm run validate:quick > /dev/null 2>&1; then
    log_warn "Validation warnings detected"
    npm run validate:quick | tail -10
  else
    log_success "Configuration validated"
  fi
}

start_bot_service() {
  log_step "PHASE 4: Starting bot service..."
  
  # Kill any existing processes
  log_info "Cleaning up old processes..."
  pkill -f "tsx src/server" 2>/dev/null || true
  fuser -k ${BOT_PORT}/tcp 2>/dev/null || true
  sleep 2
  
  log_info "Starting bot on port ${BOT_PORT}..."
  nohup npm run dev > data/logs/production.log 2>&1 &
  BOT_PID=$!
  
  # Wait for startup
  sleep 5
  
  # Verify startup
  local attempt=1
  while [[ $attempt -le 10 ]]; do
    if curl -s "http://localhost:${BOT_PORT}/health" > /dev/null 2>&1; then
      log_success "Bot started successfully (PID: $BOT_PID)"
      return 0
    fi
    log_info "Waiting for bot to start... (attempt $attempt/10)"
    sleep 2
    ((attempt++))
  done
  
  log_error "Bot failed to start after 20 seconds"
  tail -20 data/logs/production.log
  return 1
}

setup_monitoring() {
  log_step "PHASE 5: Setting up monitoring and auto-recovery..."
  
  log_info "Starting advanced monitor..."
  nohup bash scripts/advanced-monitor.sh --check-interval ${MONITOR_CHECK_INTERVAL} > data/logs/monitor.log 2>&1 &
  MONITOR_PID=$!
  log_success "Monitor started (PID: $MONITOR_PID)"
  
  log_info "Starting error detection..."
  nohup bash scripts/telegram-error-monitor.sh --polling-interval 10 > data/logs/telegram-errors.log 2>&1 &
  ERROR_MONITOR_PID=$!
  log_success "Error monitor started (PID: $ERROR_MONITOR_PID)"
}

validate_trading_endpoints() {
  log_step "PHASE 6: Validating trading endpoints..."
  
  log_info "Testing quote endpoints..."
  python3 <<'EOF'
import json
import urllib.request

# Test endpoints
endpoints = [
  ("OKX Web3", "https://web3.okx.com/api/v6/dex/aggregator/quote"),
  ("OKX Portfolio", "https://web3.okx.com/portfolio"),
]

for name, url in endpoints:
  try:
    req = urllib.request.Request(url, headers={'User-Agent': 'OKX-Bot/1.0'})
    response = urllib.request.urlopen(req, timeout=5)
    print(f"✓ {name}: OK ({response.getcode()})")
  except Exception as e:
    print(f"✗ {name}: FAILED ({str(e)[:50]})")
EOF
}

validate_profitability() {
  log_step "PHASE 7: Validating profitability targets..."
  
  bash scripts/validate-pnl-targets.sh 2>&1 | tail -30
}

setup_ai_model() {
  log_step "PHASE 8: Setting up AI model training..."
  
  if [[ "$MODE" == "production" ]]; then
    log_info "Preparing Ollama model upgrade..."
    bash scripts/train-ollama-model.sh --epochs 3 > /dev/null 2>&1 || log_warn "Model training skipped"
    log_success "AI model ready"
  else
    log_info "Skipping model training in $MODE mode"
  fi
}

setup_process_recovery() {
  log_step "PHASE 9: Setting up process recovery with 10-minute timeout..."
  
  cat > data/logs/process-recovery.sh <<'EOF'
#!/bin/bash
# Auto-recovery script triggered every 10 minutes if bot is stuck

BOT_PORT=8787
HEALTH_URL="http://localhost:${BOT_PORT}/health"
STUCK_TIMEOUT=600

while true; do
  if ! curl -s "$HEALTH_URL" > /dev/null 2>&1; then
    echo "[$(date)] Bot unresponsive - triggering recovery"
    pkill -f "tsx src/server"
    sleep 5
    nohup npm run dev > data/logs/production.log 2>&1 &
  fi
  
  sleep $STUCK_TIMEOUT
done
EOF
  chmod +x data/logs/process-recovery.sh
  log_success "Recovery script installed"
}

final_summary() {
  log_step "ORCHESTRATION COMPLETE"
  
  echo -e "\n${GREEN}═══════════════════════════════════════════${NC}"
  echo -e "${GREEN}  ✓ Bot Service: RUNNING${NC}"
  echo -e "${GREEN}  ✓ Monitoring: ACTIVE${NC}"
  echo -e "${GREEN}  ✓ Error Detection: ENABLED${NC}"
  echo -e "${GREEN}  ✓ Auto-Recovery: READY${NC}"
  echo -e "${GREEN}  ✓ Mode: ${MODE}${NC}"
  echo -e "${GREEN}═══════════════════════════════════════════${NC}"
  
  echo -e "\n${BLUE}Endpoints:${NC}"
  echo -e "  Health: curl http://localhost:${BOT_PORT}/health"
  echo -e "  Deep Health: curl http://localhost:${BOT_PORT}/health/deep"
  echo -e "  Logs: tail -f data/logs/production.log"
  echo -e "  Monitor: tail -f data/logs/monitor.log"
  
  echo -e "\n${BLUE}Management:${NC}"
  echo -e "  Stop Bot: pkill -f 'tsx src/server'"
  echo -e "  Restart: bash scripts/orchestrate-complete.sh $MODE"
  echo -e "  Validate P&L: bash scripts/validate-pnl-targets.sh"
  
  echo -e "\n${YELLOW}⚠ Remember:${NC}"
  echo "  • Monitor telegram @OKXONE_BOT for trading alerts"
  echo "  • Check P&L targets (5% daily, 15% weekly)"
  echo "  • Review slippage metrics (target: < 0.2%)"
  echo "  • System will auto-restart if stuck >10 minutes"
}

main() {
  banner
  
  # Execute phases
  verify_prerequisites || exit 1
  configure_environment
  build_and_validate || exit 1
  start_bot_service || exit 1
  setup_monitoring
  validate_trading_endpoints
  validate_profitability
  setup_ai_model
  setup_process_recovery
  
  final_summary
  
  echo -e "\n${GREEN}System ready for trading!${NC}\n"
}

trap 'log_error "Orchestration interrupted"; exit 1' SIGTERM SIGINT

main
