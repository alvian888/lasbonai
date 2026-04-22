#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

OUT_DIR="${NOC_REPORT_DIR:-data/reports/noc-probe}"
STATE_FILE="${NOC_STATE_FILE:-$OUT_DIR/status.state}"
LATEST_FILE="$OUT_DIR/latest.json"
ALERT_LOG_FILE="${NOC_ALERT_LOG_FILE:-data/logs/noc-alert.log}"
NOC_PROBE_BIN="${NOC_PROBE_BIN:-./scripts/noc-probe.sh}"
NOC_ALERT_ON_FIRST_RUN="${NOC_ALERT_ON_FIRST_RUN:-false}"
NOC_ALERT_SILENCE_HOURS="${NOC_ALERT_SILENCE_HOURS:-}"
NOC_ALERT_ALWAYS_FOR="${NOC_ALERT_ALWAYS_FOR:-FAIL}"
NOC_ALERT_TEST_HOUR="${NOC_ALERT_TEST_HOUR:-}"
NOC_RETENTION_DAYS="${NOC_RETENTION_DAYS:-7}"
NOC_RETENTION_MAX_FILES="${NOC_RETENTION_MAX_FILES:-2016}"

mkdir -p "$OUT_DIR"
mkdir -p "$(dirname "$ALERT_LOG_FILE")"

utc_ts="$(date -u +%Y%m%dT%H%M%SZ)"
uniq_ts="$(date -u +%s%N)-$$"
local_ts="$(date '+%Y-%m-%d %H:%M:%S')"
snapshot_file="$OUT_DIR/noc-probe-$utc_ts-$uniq_ts.json"
tmp_json="$OUT_DIR/.noc-probe-$utc_ts-$uniq_ts.tmp.json"

set +e
"$NOC_PROBE_BIN" --json > "$tmp_json" 2>/dev/null
probe_rc=$?
set -e

if ! python3 - "$tmp_json" >/dev/null 2>&1 <<'PY'
import json
import sys
json.load(open(sys.argv[1], 'r', encoding='utf-8'))
PY
then
  python3 - "$probe_rc" "$local_ts" > "$tmp_json" <<'PY'
import json
import sys

rc = int(sys.argv[1])
now = sys.argv[2]
report = {
  "timestamp": now,
  "overall": "FAIL",
  "exitCode": rc,
  "counts": {"pass": 0, "warn": 0, "fail": 1},
  "checks": {
    "runner": {
      "status": "fail",
      "message": "probe output was not valid JSON"
    }
  }
}
print(json.dumps(report, ensure_ascii=True))
PY
  probe_rc=2
fi

overall_status="$(python3 - "$tmp_json" <<'PY'
import json
import sys

d = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
print((d.get('overall') or 'UNKNOWN').strip().upper())
PY
)"

cp "$tmp_json" "$snapshot_file"
cp "$tmp_json" "$LATEST_FILE"
rm -f "$tmp_json"

prev_status="UNKNOWN"
if [[ -f "$STATE_FILE" ]]; then
  prev_status="$(cat "$STATE_FILE" 2>/dev/null || echo UNKNOWN)"
fi

should_alert="false"
if [[ "$prev_status" != "$overall_status" ]]; then
  if [[ "$prev_status" == "UNKNOWN" && "$NOC_ALERT_ON_FIRST_RUN" != "true" ]]; then
    should_alert="false"
  else
    should_alert="true"
  fi
fi

is_silence_window="false"
silence_note=""
severity_bypass_silence="false"
if [[ -n "$NOC_ALERT_SILENCE_HOURS" ]]; then
  start_hour="${NOC_ALERT_SILENCE_HOURS%-*}"
  end_hour="${NOC_ALERT_SILENCE_HOURS#*-}"
  if [[ "$start_hour" =~ ^[0-9]{1,2}$ ]] && [[ "$end_hour" =~ ^[0-9]{1,2}$ ]]; then
    start_hour=$((10#$start_hour))
    end_hour=$((10#$end_hour))
    if [[ "$start_hour" -ge 0 && "$start_hour" -le 23 && "$end_hour" -ge 0 && "$end_hour" -le 23 ]]; then
      current_hour_raw="$(date +%H)"
      if [[ -n "$NOC_ALERT_TEST_HOUR" && "$NOC_ALERT_TEST_HOUR" =~ ^[0-9]{1,2}$ ]]; then
        current_hour_raw="$NOC_ALERT_TEST_HOUR"
      fi
      current_hour=$((10#$current_hour_raw))

      if [[ "$start_hour" -lt "$end_hour" ]]; then
        if [[ "$current_hour" -ge "$start_hour" && "$current_hour" -lt "$end_hour" ]]; then
          is_silence_window="true"
        fi
      elif [[ "$start_hour" -gt "$end_hour" ]]; then
        if [[ "$current_hour" -ge "$start_hour" || "$current_hour" -lt "$end_hour" ]]; then
          is_silence_window="true"
        fi
      fi

      silence_note="window=${start_hour}-${end_hour} current=${current_hour}"
    else
      silence_note="invalid-window=$NOC_ALERT_SILENCE_HOURS"
    fi
  else
    silence_note="invalid-format=$NOC_ALERT_SILENCE_HOURS"
  fi
fi

if [[ -n "$NOC_ALERT_ALWAYS_FOR" ]]; then
  normalized_status="$(echo "$overall_status" | tr '[:lower:]' '[:upper:]')"
  IFS=',' read -ra always_levels <<< "$NOC_ALERT_ALWAYS_FOR"
  for lvl in "${always_levels[@]}"; do
    normalized_lvl="$(echo "$lvl" | tr -d '[:space:]' | tr '[:lower:]' '[:upper:]')"
    if [[ -n "$normalized_lvl" && "$normalized_lvl" == "$normalized_status" ]]; then
      severity_bypass_silence="true"
      break
    fi
  done
fi

if [[ "$should_alert" == "true" ]]; then
  if [[ "$is_silence_window" == "true" && "$severity_bypass_silence" != "true" ]]; then
    msg="[NOC] Status changed (silenced): $prev_status -> $overall_status at $local_ts ($silence_note)"
    echo "$msg" | tee -a "$ALERT_LOG_FILE" >/dev/null
    should_alert="silenced"
  else
    if [[ "$is_silence_window" == "true" && "$severity_bypass_silence" == "true" ]]; then
      msg="[NOC] Status changed (bypass-silence): $prev_status -> $overall_status at $local_ts ($silence_note; allow=$NOC_ALERT_ALWAYS_FOR)"
    else
      msg="[NOC] Status changed: $prev_status -> $overall_status at $local_ts"
    fi
    echo "$msg" | tee -a "$ALERT_LOG_FILE" >/dev/null

    if [[ -n "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_CHAT_ID:-}" ]]; then
      escaped_msg="${msg//\"/\\\"}"
      curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\": ${TELEGRAM_CHAT_ID}, \"text\": \"$escaped_msg\"}" \
        >/dev/null 2>&1 || true
    fi
  fi
fi

echo "$overall_status" > "$STATE_FILE"

# Retain snapshots with two controls:
# 1) Time-based cleanup (older than N days)
# 2) Count-based cleanup (keep newest N files)
if [[ "$NOC_RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  find "$OUT_DIR" -maxdepth 1 -type f -name "noc-probe-*.json" -mtime "+$NOC_RETENTION_DAYS" -delete || true
fi

if [[ "$NOC_RETENTION_MAX_FILES" =~ ^[0-9]+$ ]] && [[ "$NOC_RETENTION_MAX_FILES" -gt 0 ]]; then
  mapfile -t snapshot_files < <(ls -1t "$OUT_DIR"/noc-probe-*.json 2>/dev/null || true)
  if [[ "${#snapshot_files[@]}" -gt "$NOC_RETENTION_MAX_FILES" ]]; then
    for old_file in "${snapshot_files[@]:$NOC_RETENTION_MAX_FILES}"; do
      rm -f "$old_file"
    done
  fi
fi

echo "[noc-runner] status=$overall_status prev=$prev_status alert=$should_alert snapshot=$snapshot_file"
# WARN is an informational degraded state; only FAIL should surface as a service failure.
if [[ "$overall_status" == "FAIL" ]]; then
  exit "$probe_rc"
fi

exit 0
