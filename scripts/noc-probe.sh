#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

BOT_PORT="${BOT_PORT:-8787}"
MAX_STALE_SEC="${NOC_MAX_STALE_SEC:-900}"
CRIT_STALE_SEC="${NOC_CRIT_STALE_SEC:-1800}"
FORMAT="text"

for arg in "$@"; do
  case "$arg" in
    --json)
      FORMAT="json"
      ;;
    --text)
      FORMAT="text"
      ;;
    -h|--help)
      cat <<'EOF'
Usage: scripts/noc-probe.sh [--text|--json]

Options:
  --text   Human-readable output (default)
  --json   Machine-readable JSON output
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 64
      ;;
  esac
done

PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

TIMESTAMP="$(date '+%Y-%m-%d %H:%M:%S')"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

HEALTH_STATUS="unknown"
HEALTH_MESSAGE="not checked"
DEEP_STATUS="unknown"
DEEP_MESSAGE="not checked"
WATCHDOG_STATUS="unknown"
WATCHDOG_MESSAGE="not checked"
SCHEDULER_STATUS="unknown"
SCHEDULER_MESSAGE="not checked"
WATCHDOG_LOG_STATUS="unknown"
WATCHDOG_LOG_MESSAGE="not checked"

emit() {
  if [[ "$FORMAT" == "text" ]]; then
    echo "$1"
  fi
}

mark_pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  emit "PASS: $1"
}

mark_warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  emit "WARN: $1"
}

mark_fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  emit "FAIL: $1"
}

emit "=== NOC PROBE ==="
emit "timestamp: ${TIMESTAMP}"

emit ""
emit "[1] /health"
health_file="$TMP_DIR/health.json"
health_code="$(curl -s -o "$health_file" -w "%{http_code}" -m 5 "http://127.0.0.1:${BOT_PORT}/health" 2>/dev/null || true)"
if [[ "$health_code" == "200" ]]; then
  if [[ "$FORMAT" == "text" ]]; then
    cat "$health_file"
    echo
  fi
  HEALTH_STATUS="pass"
  HEALTH_MESSAGE="/health reachable on port ${BOT_PORT}"
  mark_pass "$HEALTH_MESSAGE"
else
  emit "health endpoint failed"
  HEALTH_STATUS="fail"
  HEALTH_MESSAGE="/health unreachable or non-200 (code=${health_code:-none})"
  mark_fail "$HEALTH_MESSAGE"
fi

emit ""
emit "[2] /health/deep (condensed)"
deep_status="unknown"
deep_reason="unknown"
deep_report=""
if deep_json="$(curl -sS -m 8 "http://127.0.0.1:${BOT_PORT}/health/deep")"; then
  deep_report="$(python3 - "$deep_json" "$MAX_STALE_SEC" "$CRIT_STALE_SEC" "$TMP_DIR/deep-summary.txt" <<'PY'
import json
import sys
import time

raw = sys.argv[1]
max_stale = int(sys.argv[2])
crit_stale = int(sys.argv[3])
summary_file = sys.argv[4]
try:
    d = json.loads(raw)
except Exception:
    with open(summary_file, "w", encoding="utf-8") as f:
        f.write("deep parse error\n")
    print("PROBE_STATUS:fail")
    print("PROBE_REASON:parse_error")
    raise SystemExit(0)

s = d.get("scheduler", {})
print(f"ok={d.get('ok')} dryRun={d.get('dryRun')} model={d.get('model')}")
print(
    "scheduler "
    f"running={s.get('running')} "
    f"interval={s.get('intervalMinutes')}m "
    f"lastFinish={s.get('lastCycleFinishedAt')} "
    f"lastDecision={s.get('lastDecisionAction')} "
    f"lastExecMode={s.get('lastExecutionMode')} "
    f"lastReceipt={s.get('lastReceiptStatus')} "
    f"receiptFailedStreak={s.get('receiptFailedStreak')}"
)

status = "pass"
reasons = []

if d.get("ok") is not True:
    status = "fail"
    reasons.append("deep_ok_false")

last_finished = s.get("lastCycleFinishedAt")
if isinstance(last_finished, int):
    lag = int((time.time() * 1000 - last_finished) / 1000)
    print(f"schedulerLagSec={lag}")
    if lag > crit_stale:
        status = "fail"
        reasons.append(f"stale>{crit_stale}s")
    elif lag > max_stale and status != "fail":
        status = "warn"
        reasons.append(f"stale>{max_stale}s")
else:
    print("schedulerLagSec=unknown")

receipt_streak = int(s.get("receiptFailedStreak") or 0)
if receipt_streak >= 4:
    status = "fail"
    reasons.append("receipt_streak>=4")
elif receipt_streak >= 2 and status != "fail":
    status = "warn"
    reasons.append("receipt_streak>=2")

if not reasons:
    reasons.append("healthy")

with open(summary_file, "w", encoding="utf-8") as f:
    f.write("; ".join(reasons) + "\n")

print("PROBE_STATUS:" + status)
print("PROBE_REASON:" + ",".join(reasons))
PY
)"
  if [[ "$FORMAT" == "text" ]]; then
    echo "$deep_report"
  fi
  deep_status="$(echo "$deep_report" | awk -F: '/^PROBE_STATUS:/ {print $2}' | tail -1)"
  deep_reason="$(echo "$deep_report" | awk -F: '/^PROBE_REASON:/ {print $2}' | tail -1)"

  if [[ "$deep_status" == "pass" ]]; then
    DEEP_STATUS="pass"
    DEEP_MESSAGE="/health/deep healthy (${deep_reason})"
    mark_pass "$DEEP_MESSAGE"
  elif [[ "$deep_status" == "warn" ]]; then
    DEEP_STATUS="warn"
    DEEP_MESSAGE="/health/deep warning (${deep_reason})"
    mark_warn "$DEEP_MESSAGE"
  else
    DEEP_STATUS="fail"
    DEEP_MESSAGE="/health/deep failed (${deep_reason:-unknown})"
    mark_fail "$DEEP_MESSAGE"
  fi
else
  emit "deep health endpoint failed"
  DEEP_STATUS="fail"
  DEEP_MESSAGE="/health/deep unreachable"
  mark_fail "$DEEP_MESSAGE"
fi

emit ""
emit "[3] watchdog processes"
watchdog_pids="$(pgrep -af "scripts/monitor-bot.sh|scripts/watchdog-loop.sh" || true)"
if [[ -n "$watchdog_pids" ]]; then
  emit "$watchdog_pids"
  WATCHDOG_STATUS="pass"
  WATCHDOG_MESSAGE="watchdog process detected"
  mark_pass "$WATCHDOG_MESSAGE"
else
  emit "(none)"
  WATCHDOG_STATUS="warn"
  WATCHDOG_MESSAGE="watchdog process not detected"
  mark_warn "$WATCHDOG_MESSAGE"
fi

emit ""
emit "[4] recent scheduler lines"
if [[ -f data/logs/production.log ]]; then
  scheduler_lines="$(grep -nE "\[scheduler\] decision=|\[scheduler\] execution_mode=|\[scheduler\] execution_receipt=|\[scheduler\] cycle finished" data/logs/production.log | tail -20 || true)"
  if [[ -n "$scheduler_lines" ]]; then
    emit "$scheduler_lines"
    SCHEDULER_STATUS="pass"
    SCHEDULER_MESSAGE="scheduler activity lines found"
    mark_pass "$SCHEDULER_MESSAGE"
  else
    emit "(no scheduler lines found)"
    SCHEDULER_STATUS="warn"
    SCHEDULER_MESSAGE="scheduler lines not found in production.log"
    mark_warn "$SCHEDULER_MESSAGE"
  fi
else
  emit "production.log not found"
  SCHEDULER_STATUS="warn"
  SCHEDULER_MESSAGE="production.log missing"
  mark_warn "$SCHEDULER_MESSAGE"
fi

emit ""
emit "[5] recent watchdog lines"
if [[ -f data/logs/watchdog.log ]]; then
  if [[ "$FORMAT" == "text" ]]; then
    tail -20 data/logs/watchdog.log
  fi
  WATCHDOG_LOG_STATUS="pass"
  WATCHDOG_LOG_MESSAGE="watchdog.log readable"
  mark_pass "$WATCHDOG_LOG_MESSAGE"
else
  emit "watchdog.log not found"
  WATCHDOG_LOG_STATUS="warn"
  WATCHDOG_LOG_MESSAGE="watchdog.log missing"
  mark_warn "$WATCHDOG_LOG_MESSAGE"
fi

EXIT_CODE=0
OVERALL="PASS"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  OVERALL="FAIL"
  EXIT_CODE=2
elif [[ "$WARN_COUNT" -gt 0 ]]; then
  OVERALL="WARN"
  EXIT_CODE=1
fi

if [[ "$FORMAT" == "json" ]]; then
  health_body=""
  if [[ -f "$health_file" ]]; then
    health_body="$(cat "$health_file")"
  fi
  python3 - "$TIMESTAMP" "$BOT_PORT" "$MAX_STALE_SEC" "$CRIT_STALE_SEC" \
    "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$OVERALL" "$EXIT_CODE" \
    "$HEALTH_STATUS" "$HEALTH_MESSAGE" "$health_body" \
    "$DEEP_STATUS" "$DEEP_MESSAGE" "$deep_reason" \
    "$WATCHDOG_STATUS" "$WATCHDOG_MESSAGE" \
    "$SCHEDULER_STATUS" "$SCHEDULER_MESSAGE" \
    "$WATCHDOG_LOG_STATUS" "$WATCHDOG_LOG_MESSAGE" <<'PY'
import json
import sys

(
    timestamp,
    bot_port,
    max_stale,
    crit_stale,
    pass_count,
    warn_count,
    fail_count,
    overall,
    exit_code,
    health_status,
    health_message,
    health_body,
    deep_status,
    deep_message,
    deep_reason,
    watchdog_status,
    watchdog_message,
    scheduler_status,
    scheduler_message,
    watchdog_log_status,
    watchdog_log_message,
) = sys.argv[1:]

health_json = None
if health_body:
    try:
        health_json = json.loads(health_body)
    except Exception:
        health_json = health_body

report = {
    "timestamp": timestamp,
    "port": int(bot_port),
    "thresholds": {
        "warnStaleSec": int(max_stale),
        "critStaleSec": int(crit_stale),
    },
    "counts": {
        "pass": int(pass_count),
        "warn": int(warn_count),
        "fail": int(fail_count),
    },
    "overall": overall,
    "exitCode": int(exit_code),
    "checks": {
        "health": {
            "status": health_status,
            "message": health_message,
            "body": health_json,
        },
        "deepHealth": {
            "status": deep_status,
            "message": deep_message,
            "reason": deep_reason,
        },
        "watchdogProcess": {
            "status": watchdog_status,
            "message": watchdog_message,
        },
        "schedulerLog": {
            "status": scheduler_status,
            "message": scheduler_message,
        },
        "watchdogLog": {
            "status": watchdog_log_status,
            "message": watchdog_log_message,
        },
    },
}

print(json.dumps(report, ensure_ascii=True))
PY
else
  emit ""
  emit "=== NOC PROBE SUMMARY ==="
  emit "pass=${PASS_COUNT} warn=${WARN_COUNT} fail=${FAIL_COUNT}"
  emit "overall=${OVERALL}"
fi

exit "$EXIT_CODE"
