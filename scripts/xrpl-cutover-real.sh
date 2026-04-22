#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8787}"

required_cmds=(curl python3)
for cmd in "${required_cmds[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[xrpl-cutover] missing command: $cmd"
    exit 1
  fi
done

echo "[xrpl-cutover] starting production cutover preflight"

if [[ "${DRY_RUN:-true}" != "false" ]]; then
  echo "[xrpl-cutover] DRY_RUN must be false for production cutover"
  exit 2
fi

if [[ "${LIVE_STAGE:-dry-run}" == "dry-run" ]]; then
  echo "[xrpl-cutover] LIVE_STAGE must be canary or full"
  exit 3
fi

if [[ -z "${XRPL_NATIVE_EXECUTE_URL:-}" ]]; then
  echo "[xrpl-cutover] XRPL_NATIVE_EXECUTE_URL is required"
  exit 4
fi

if [[ "${XRPL_NATIVE_EXECUTE_MOCK_ENABLED:-false}" == "true" ]]; then
  echo "[xrpl-cutover] XRPL_NATIVE_EXECUTE_MOCK_ENABLED must be false for production cutover"
  exit 5
fi

if [[ "${XRPL_NATIVE_EXECUTE_URL}" == *"/api/xrpl/executor/mock"* ]]; then
  echo "[xrpl-cutover] XRPL_NATIVE_EXECUTE_URL points to mock endpoint; set real executor URL"
  exit 6
fi

if [[ -z "${XRPL_NATIVE_EXECUTE_ALLOWED_HOSTS:-}" ]]; then
  echo "[xrpl-cutover] XRPL_NATIVE_EXECUTE_ALLOWED_HOSTS is required for production cutover"
  exit 7
fi

executor_host="$(python3 - <<'PY'
import os
from urllib.parse import urlparse

url = os.environ.get("XRPL_NATIVE_EXECUTE_URL", "").strip()
try:
    print((urlparse(url).hostname or "").lower())
except Exception:
    print("")
PY
)"

if [[ -z "$executor_host" ]]; then
  echo "[xrpl-cutover] failed to parse host from XRPL_NATIVE_EXECUTE_URL"
  exit 8
fi

allowed_csv="${XRPL_NATIVE_EXECUTE_ALLOWED_HOSTS,,}"
IFS=',' read -r -a allowed_hosts <<< "$allowed_csv"
host_allowed=false
for host in "${allowed_hosts[@]}"; do
  clean_host="$(echo "$host" | xargs)"
  if [[ -n "$clean_host" && "$clean_host" == "$executor_host" ]]; then
    host_allowed=true
    break
  fi
done

if [[ "$host_allowed" != "true" ]]; then
  echo "[xrpl-cutover] executor host '$executor_host' not in XRPL_NATIVE_EXECUTE_ALLOWED_HOSTS"
  exit 9
fi

echo "[xrpl-cutover] local env gates passed"
echo "[xrpl-cutover] checking runtime status endpoint"
curl -s --max-time 10 "${BASE_URL%/}/api/xrpl/status" | python3 -m json.tool

echo "[xrpl-cutover] checking readiness in production mode"
bash "$(dirname "$0")/xrpl-live-readiness.sh" "$BASE_URL" production

echo "[xrpl-cutover] production cutover preflight PASSED"
