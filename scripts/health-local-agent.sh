#!/usr/bin/env bash
set -euo pipefail

# Read token from project .env if present (without sourcing arbitrary file content).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
if [[ -f "$PROJECT_ROOT/.env" ]]; then
  token_line="$(grep -m1 '^OPENCLAW_GATEWAY_TOKEN=' "$PROJECT_ROOT/.env" || true)"
  if [[ -n "$token_line" ]]; then
    OPENCLAW_GATEWAY_TOKEN="${token_line#OPENCLAW_GATEWAY_TOKEN=}"
  fi
fi

check() {
  local name="$1"
  local url="$2"
  if curl -sS -m 3 "$url" >/dev/null 2>&1; then
    echo "[ok] $name -> $url"
  else
    echo "[fail] $name -> $url"
  fi
}

check_openclaw() {
  local url="http://127.0.0.1:3001/v1/models"
  local code
  local auth_args=()

  if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
    auth_args=(-H "Authorization: Bearer ${OPENCLAW_GATEWAY_TOKEN}")
  fi

  code="$(curl -sS -m 3 -o /dev/null -w "%{http_code}" "${auth_args[@]}" "$url" || true)"
  if [[ "$code" == "200" || "$code" == "401" ]]; then
    echo "[ok] openclaw -> $url (http $code)"
  else
    echo "[fail] openclaw -> $url (http ${code:-000})"
  fi
}

echo "[health] checking local AI and bot endpoints"
check_openclaw
check "ollama-openai" "http://127.0.0.1:11435/v1/models"
check "bot" "http://127.0.0.1:8787/health"
