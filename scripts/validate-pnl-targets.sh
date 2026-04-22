#!/bin/bash
#
# P&L Validator: Tracks daily/weekly P&L and verifies 15% weekly target achievement
# Also validates profitability of endpoints and slippage metrics
# Usage: bash scripts/validate-pnl-targets.sh [--report-only] [--daily-target 5]
#

set -e

DAILY_TARGET=${DAILY_TARGET:-5}  # Target daily P&L in %
WEEKLY_TARGET=15                  # Target weekly P&L in %
REPORT_DIR="token portfolio/BSC/REPORT"
DAILY_DIR="${REPORT_DIR}/daily"
POST_FIX_ONLY=0
POST_FIX_SINCE="${POST_FIX_SINCE:-}"

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[ERROR]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[✓]${NC} $1"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --daily-target)
        DAILY_TARGET="$2"
        shift 2
        ;;
      --post-fix-since)
        POST_FIX_SINCE="$2"
        shift 2
        ;;
      --post-fix-only)
        POST_FIX_ONLY=1
        shift
        ;;
      --report-only)
        shift
        ;;
      *)
        log_warn "Ignoring unknown argument: $1"
        shift
        ;;
    esac
  done
}

resolve_post_fix_since() {
  if [[ -n "$POST_FIX_SINCE" ]]; then
    echo "$POST_FIX_SINCE"
    return 0
  fi

  local deployment_file="DEPLOYMENT_COMPLETE.md"
  if [[ -f "$deployment_file" ]]; then
    local inferred
    inferred=$(python3 <<'EOF'
import re
from pathlib import Path

content = Path("DEPLOYMENT_COMPLETE.md").read_text(errors="ignore")
match = re.search(r"\*\*Timestamp:\*\*\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", content)
print(match.group(1) if match else "")
EOF
)
    if [[ -n "$inferred" ]]; then
      echo "$inferred"
      return 0
    fi
  fi

  return 1
}

analyze_daily_reports() {
  if [[ ! -d "$DAILY_DIR" ]]; then
    log_error "Daily reports directory not found: $DAILY_DIR"
    return 1
  fi
  
  echo -e "\n${BLUE}=== DAILY P&L ANALYSIS ===${NC}"
  
  local latest_report=$(ls -t "$DAILY_DIR"/*.json 2>/dev/null | head -1)
  
  if [[ -z "$latest_report" ]]; then
    log_error "No daily reports found"
    return 1
  fi
  
  # Parse latest report using Python
  python3 <<EOF
import json
import sys
from datetime import datetime, timedelta

try:
  with open('$latest_report') as f:
    data = json.load(f)
  
  portfolio = data.get('portfolio', {})
  daily_pnl = portfolio.get('dailyPnlPct', 0)
  daily_pnl_usd = portfolio.get('dailyPnlUSD', 0)
  date = data.get('date', 'Unknown')
  
  print(f"Latest Report: {date}")
  print(f"Daily P&L: {daily_pnl:.2f}% (${daily_pnl_usd:.2f})")
  print(f"Target: ${DAILY_TARGET}%")
  
  if daily_pnl >= $DAILY_TARGET:
    print(f"Status: ✓ ACHIEVED")
    sys.exit(0)
  elif daily_pnl >= ($DAILY_TARGET * 0.7):
    print(f"Status: ⚠ PARTIAL ({daily_pnl/('$DAILY_TARGET')*100:.0f}% of target)")
    sys.exit(1)
  else:
    print(f"Status: ✗ MISSED")
    sys.exit(2)
except Exception as e:
  print(f"Error: {e}")
  sys.exit(3)
EOF
  
  local exit_code=$?
  return $exit_code
}

validate_slippage_endpoints() {
  echo -e "\n${BLUE}=== SLIPPAGE & ENDPOINT VALIDATION ===${NC}"
  
  python3 <<'EOF'
import json
import os
from pathlib import Path

report_dir = Path("token portfolio/BSC/REPORT")
reports = sorted(report_dir.glob("*.json"), reverse=True)[:5]

slippage_good = 0
slippage_warn = 0
slippage_bad = 0

for report_file in reports:
  try:
    with open(report_file) as f:
      report = json.load(f)
    
    if 'raw' not in report:
      continue
    
    raw = report.get('raw', {})
    slippage = raw.get('slippageEstPct', 0)
    impact = raw.get('priceImpactPercent', 0)
    
    if isinstance(slippage, str):
      try:
        slippage = float(slippage)
      except:
        continue
    
    if slippage < 0.2 and impact < 0.3:
      slippage_good += 1
    elif slippage < 0.5 and impact < 0.5:
      slippage_warn += 1
    else:
      slippage_bad += 1
  except:
    continue

print(f"Slippage Summary (Last 5 reports):")
print(f"  ✓ Good (<0.2%):  {slippage_good}")
print(f"  ⚠ Warning (<0.5%): {slippage_warn}")
print(f"  ✗ Bad (>0.5%):    {slippage_bad}")

total = slippage_good + slippage_warn + slippage_bad
if total > 0:
  good_ratio = (slippage_good / total) * 100
  if good_ratio >= 80:
    print(f"\nStatus: ✓ EXCELLENT slippage management ({good_ratio:.0f}% good)")
  elif good_ratio >= 60:
    print(f"\nStatus: ⚠ ACCEPTABLE slippage ({good_ratio:.0f}% good)")
  else:
    print(f"\nStatus: ✗ HIGH SLIPPAGE risk ({good_ratio:.0f}% good)")
EOF
}

validate_weekly_pnl() {
  echo -e "\n${BLUE}=== WEEKLY P&L TARGET ===${NC}"
  
  python3 <<EOF
import json
from pathlib import Path
from datetime import datetime, timedelta

daily_dir = Path("$DAILY_DIR")
daily_reports = sorted(daily_dir.glob("*.json"), reverse=True)

# Get reports from last 7 days
seven_days_ago = datetime.now() - timedelta(days=7)
recent_reports = []

for report_file in daily_reports[:20]:  # Check up to 20 files
  try:
    with open(report_file) as f:
      data = json.load(f)
    recent_reports.append(data)
    if len(recent_reports) >= 7:
      break
  except:
    continue

if not recent_reports:
  print("No recent reports found for weekly calculation")
else:
  weekly_pnl = sum(r.get('portfolio', {}).get('dailyPnlPct', 0) for r in recent_reports)
  avg_daily = weekly_pnl / len(recent_reports)
  
  print(f"Weekly P&L (last {len(recent_reports)} days): {weekly_pnl:.2f}%")
  print(f"Average Daily P&L: {avg_daily:.2f}%")
  print(f"Target: $WEEKLY_TARGET%")
  
  if weekly_pnl >= $WEEKLY_TARGET:
    print(f"Status: ✓ ACHIEVED ({weekly_pnl:.1f}%)")
  elif weekly_pnl >= ($WEEKLY_TARGET * 0.7):
    print(f"Status: ⚠ ON TRACK ({weekly_pnl:.1f}% of $WEEKLY_TARGET% target)")
  else:
    print(f"Status: ✗ BELOW TARGET ({weekly_pnl:.1f}% vs $WEEKLY_TARGET% target)")
    print(f"Recommendation: Increase position sizing or find higher-conviction trades")
EOF
}

show_live_session_snapshot() {
  echo -e "\n${BLUE}=== LIVE SESSION SNAPSHOT (POST-FIX) ===${NC}"

  python3 <<'EOF'
import json
import re
from pathlib import Path

log_path = Path("data/logs/production.log")

if not log_path.exists():
  print("Production log not found: data/logs/production.log")
  raise SystemExit(0)

latest_position = None
latest_decision = None

try:
  lines = log_path.read_text(errors="ignore").splitlines()
except Exception as exc:
  print(f"Unable to read production log: {exc}")
  raise SystemExit(0)

for line in reversed(lines):
  if latest_position is None and "[scheduler] position:" in line:
    latest_position = line.strip()
  if latest_decision is None and "[scheduler] decision=" in line:
    latest_decision = line.strip()
  if latest_position and latest_decision:
    break

print("Latest scheduler position:")
if latest_position:
  print(f"  {latest_position}")
else:
  print("  Not available yet")

print("Latest scheduler decision:")
if latest_decision:
  print(f"  {latest_decision}")
else:
  print("  Not available yet")

print("Historical daily reports may still include pre-fix losses.")
print("Use this live section to judge post-fix behavior during first 24h.")
EOF
}

show_post_fix_report() {
  local since
  since=$(resolve_post_fix_since || true)

  echo -e "\n${BLUE}=== POST-FIX PERFORMANCE WINDOW ===${NC}"

  if [[ -z "$since" ]]; then
    log_warn "No post-fix timestamp found. Use --post-fix-since 'YYYY-MM-DD HH:MM:SS' for strict filtering."
  else
    echo "Post-fix since: $since"
  fi

  SINCE_RAW="$since" DAILY_DIR_ENV="$DAILY_DIR" python3 <<'EOF'
import json
import os
import re
from datetime import datetime
from pathlib import Path

since_raw = os.environ.get("SINCE_RAW", "").strip()
daily_dir = Path(os.environ.get("DAILY_DIR_ENV", ""))
log_path = Path("data/logs/production.log")

def parse_dt(text):
  if not text:
    return None
  candidates = [
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%fZ",
    "%Y-%m-%dT%H:%M:%SZ",
  ]
  for fmt in candidates:
    try:
      return datetime.strptime(text, fmt)
    except ValueError:
      pass
  return None

since_dt = parse_dt(since_raw)

reports = []
for report_file in sorted(daily_dir.glob("*.json")):
  try:
    data = json.loads(report_file.read_text())
  except Exception:
    continue
  generated_at = parse_dt(data.get("generatedAt", ""))
  if since_dt and (generated_at is None or generated_at < since_dt):
    continue
  reports.append((report_file.name, generated_at, data))

if reports:
  first = reports[0][2].get("portfolio", {})
  last = reports[-1][2].get("portfolio", {})
  start_value = first.get("startValueUSD", 0)
  end_value = last.get("endValueUSD", 0)
  pnl_usd = end_value - start_value
  pnl_pct = ((pnl_usd / start_value) * 100) if start_value else 0
  print(f"Daily reports in post-fix window: {len(reports)}")
  print(f"Window start value: ${start_value:.2f}")
  print(f"Window end value:   ${end_value:.2f}")
  print(f"Net change:         ${pnl_usd:.2f} ({pnl_pct:.2f}%)")
else:
  print("No daily report generated fully inside post-fix window yet.")

if not log_path.exists():
  print("Live session delta unavailable: production log not found.")
  raise SystemExit(0)

pattern = re.compile(r"\[scheduler\] position: .*?\(\$(?P<base>[0-9.]+)\) USDT=\$(?P<quote>[0-9.]+) pnl=(?P<pnl>-?[0-9.]+)%")
positions = []
for line in log_path.read_text(errors="ignore").splitlines():
  match = pattern.search(line)
  if not match:
    continue
  base = float(match.group("base"))
  quote = float(match.group("quote"))
  pnl = float(match.group("pnl"))
  positions.append({"base": base, "quote": quote, "total": base + quote, "pnl": pnl})

if len(positions) < 2:
  print("Live session delta unavailable: need at least 2 scheduler position snapshots.")
  raise SystemExit(0)

first = positions[0]
last = positions[-1]
delta_usd = last["total"] - first["total"]
delta_pct = ((delta_usd / first["total"]) * 100) if first["total"] else 0

print("")
print("Live session delta from current production log:")
print(f"  Start total:   ${first['total']:.2f} (base=${first['base']:.2f}, quote=${first['quote']:.2f})")
print(f"  Current total: ${last['total']:.2f} (base=${last['base']:.2f}, quote=${last['quote']:.2f})")
print(f"  Net change:    ${delta_usd:.2f} ({delta_pct:.2f}%)")
print(f"  Current P&L:   {last['pnl']:.2f}%")
print("  Note: this live delta is based on the current production.log session after the latest restart.")
EOF
}

generate_report() {
  echo -e "\n${BLUE}╔════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║  OKX Trading Bot - P&L Validation Report║${NC}"
  echo -e "${BLUE}║  Generated: $(date '+%Y-%m-%d %H:%M:%S')          ║${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
  
  daily_status=0
  if [[ "$POST_FIX_ONLY" -eq 0 ]]; then
    if analyze_daily_reports; then
      daily_status=0
    else
      daily_status=$?
    fi
    
    validate_slippage_endpoints
    validate_weekly_pnl
  fi

  show_post_fix_report
  show_live_session_snapshot
  
  echo -e "\n${BLUE}=== RECOMMENDATIONS ===${NC}"

  if [[ "$POST_FIX_ONLY" -eq 1 ]]; then
    log_info "Post-fix-only mode: use live session delta until a new daily report is generated after the fix timestamp"
    echo -e "\n${BLUE}=== NEXT STEPS ===${NC}"
    echo "1. Wait for the next daily analysis report after the post-fix timestamp"
    echo "2. Use current production.log live delta to judge short-horizon recovery"
    echo "3. If live delta stays flat, review hold reasoning and probe sizing"
    echo "4. If slippage remains high, reduce single-source sentiment entries further"
    echo "5. Check /health/deep endpoint for cycle metrics"
    return
  fi
  
  case $daily_status in
    0) log_success "Daily target achieved - maintain current strategy" ;;
    1) log_warn "Daily target partial - consider increasing position size by 20%" ;;
    2) log_error "Daily target missed - review trade selection and execution timing" ;;
  esac
  
  echo -e "\n${BLUE}=== NEXT STEPS ===${NC}"
  echo "1. Monitor next 24 hours of trading"
  echo "2. If P&L > 5% daily: keep settings"
  echo "3. If P&L < 2% daily: increase confidence threshold to 0.45"
  echo "4. If slippage > 0.5%: reduce position sizes"
  echo "5. Check /health/deep endpoint for cycle metrics"
}

main() {
  parse_args "$@"
  generate_report
}

trap 'exit 0' SIGTERM SIGINT

main "$@"
