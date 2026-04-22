#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:8787}"
MODE="${2:-default}"
STATUS_URL="${BASE_URL%/}/api/xrpl/status"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required"
  exit 1
fi

raw="$(curl -s --max-time 15 "$STATUS_URL" || true)"
if [[ -z "$raw" ]]; then
  echo "[xrpl] failed: empty response from $STATUS_URL"
  exit 1
fi

python3 - "$raw" "$MODE" <<'PY'
import json
import sys

payload = json.loads(sys.argv[1])
status = payload.get("status") or {}
executor = payload.get("executor") or {}
provider = payload.get("provider", "unknown")
reachable = bool(status.get("reachable", False))
blocked = bool(status.get("blocked", False))
hint = bool(status.get("hasXrplHint", False))
executor_configured = bool(executor.get("configured", False))
live_gate_open = bool(executor.get("liveGateOpen", False))
mock_enabled = bool(executor.get("mockEnabled", False))
uses_mock = bool(executor.get("usesMock", False))
recommendation = payload.get("recommendation", "")
mode = (sys.argv[2] if len(sys.argv) > 2 else "default").strip().lower()

print(f"[xrpl] provider     : {provider}")
print(f"[xrpl] reachable    : {reachable}")
print(f"[xrpl] blocked      : {blocked}")
print(f"[xrpl] xrpl_hint    : {hint}")
print(f"[xrpl] live_gate    : {live_gate_open}")
print(f"[xrpl] executor_cfg : {executor_configured}")
print(f"[xrpl] mock_enabled : {mock_enabled}")
print(f"[xrpl] uses_mock    : {uses_mock}")
if recommendation:
    print(f"[xrpl] recommendation: {recommendation}")

if blocked:
    print("[xrpl] status       : LIVE BLOCKED (checkpoint)")
    sys.exit(2)

if not reachable:
    print("[xrpl] status       : LIVE BLOCKED (unreachable)")
    sys.exit(3)

if not live_gate_open:
  print("[xrpl] status       : LIVE BLOCKED (global live gate closed)")
  sys.exit(4)

if not executor_configured:
  print("[xrpl] status       : LIVE BLOCKED (executor not configured)")
  sys.exit(5)

if mode in ("production", "prod", "real") and (mock_enabled or uses_mock):
  print("[xrpl] status       : LIVE BLOCKED (mock executor active in production mode)")
  sys.exit(6)

print("[xrpl] status       : READY FOR NEXT LIVE STEP")
sys.exit(0)
PY
