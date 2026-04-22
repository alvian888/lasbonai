#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_DIR/.env"

upsert_env() {
  local key="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" k "=" {
      print k "=" v
      done = 1
      next
    }
    { print }
    END {
      if (!done) {
        print k "=" v
      }
    }
  ' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
}

has_env_key() {
  local key="$1"
  grep -q "^${key}=" "$ENV_FILE"
}

http_status() {
  local url="$1"
  local token="${2:-}"
  local auth_args=()

  if [[ -n "$token" ]]; then
    auth_args=(-H "Authorization: Bearer $token")
  fi

  curl -sS -m 3 -o /dev/null -w "%{http_code}" "${auth_args[@]}" "$url" || true
}

can_reach() {
  local url="$1"
  local token="${2:-}"
  local status

  status="$(http_status "$url" "$token")"
  [[ "$status" == "200" || "$status" == "401" ]]
}

endpoint_works() {
  local url="$1"
  local token="${2:-}"
  local status

  status="$(http_status "$url" "$token")"
  [[ "$status" == "200" ]]
}

try_start_stack() {
  local compose_file="$WORKSPACE_DIR/docker-compose.yml"

  if [[ ! -f "$compose_file" ]]; then
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    return
  fi

  echo "[integrate] trying to start local docker AI stack (ollama/openclaw/open-webui)"
  if docker compose --env-file "$WORKSPACE_DIR/.env" -f "$compose_file" up -d ollama openclaw open-webui >/dev/null 2>&1; then
    echo "[integrate] docker stack start command executed"
    return
  fi

  if ! docker ps >/dev/null 2>&1; then
    echo "[integrate] docker is not accessible for current user"
    echo "[integrate] run: sudo usermod -aG docker \$USER && newgrp docker"
    return
  fi

  echo "[integrate] docker compose start failed, please inspect logs from workspace root"
  echo "[integrate] command: docker compose -f docker-compose.yml logs --tail 100"
}

echo "[integrate] project: $PROJECT_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$PROJECT_DIR/.env.example" "$ENV_FILE"
  echo "[integrate] .env created from .env.example"
fi

OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-}"
if [[ -f "$PROJECT_DIR/.env" ]]; then
  token_line="$(grep -m1 '^OPENCLAW_GATEWAY_TOKEN=' "$PROJECT_DIR/.env" || true)"
  if [[ -n "$token_line" ]]; then
    OPENCLAW_GATEWAY_TOKEN="${token_line#OPENCLAW_GATEWAY_TOKEN=}"
  fi
fi

MODEL_ENDPOINT=""
DEFAULT_MODEL=""

if endpoint_works "http://127.0.0.1:3001/v1/models" "$OPENCLAW_GATEWAY_TOKEN"; then
  MODEL_ENDPOINT="http://127.0.0.1:3001/v1"
  DEFAULT_MODEL="openclaw/default"
  if [[ -n "$OPENCLAW_GATEWAY_TOKEN" ]]; then
    echo "[integrate] detected OpenClaw gateway on :3001 with auth token"
  else
    echo "[integrate] detected OpenClaw gateway on :3001"
  fi
  echo "[integrate] selected local model: openclaw/default"
elif endpoint_works "http://127.0.0.1:11435/v1/models"; then
  MODEL_ENDPOINT="http://127.0.0.1:11435/v1"
  DEFAULT_MODEL="lasbonai-trading"
  echo "[integrate] detected Ollama gateway on :11435"
  if curl -sS "http://127.0.0.1:11435/v1/models" | grep -q 'lasbonai-trading'; then
    DEFAULT_MODEL="lasbonai-trading"
    echo "[integrate] selected local model: lasbonai-trading"
  elif curl -sS "http://127.0.0.1:11435/v1/models" | grep -q 'rahmatginanjar120/lasbonai:latest'; then
    DEFAULT_MODEL="rahmatginanjar120/lasbonai:latest"
    echo "[integrate] selected fallback local model: rahmatginanjar120/lasbonai:latest"
  fi
else
  echo "[integrate] no local AI endpoint found on :3001 or :11435"
  try_start_stack

  if endpoint_works "http://127.0.0.1:3001/v1/models" "$OPENCLAW_GATEWAY_TOKEN"; then
    MODEL_ENDPOINT="http://127.0.0.1:3001/v1"
    DEFAULT_MODEL="openclaw/default"
    echo "[integrate] detected OpenClaw gateway on :3001 after docker startup"
  elif endpoint_works "http://127.0.0.1:11435/v1/models"; then
    MODEL_ENDPOINT="http://127.0.0.1:11435/v1"
    DEFAULT_MODEL="lasbonai-trading"
    echo "[integrate] detected Ollama gateway on :11435 after docker startup"
    if curl -sS "http://127.0.0.1:11435/v1/models" | grep -q 'lasbonai-trading'; then
      DEFAULT_MODEL="lasbonai-trading"
      echo "[integrate] selected local model: lasbonai-trading"
    elif curl -sS "http://127.0.0.1:11435/v1/models" | grep -q 'rahmatginanjar120/lasbonai:latest'; then
      DEFAULT_MODEL="rahmatginanjar120/lasbonai:latest"
      echo "[integrate] selected fallback local model: rahmatginanjar120/lasbonai:latest"
    fi
  else
    echo "[integrate] start your docker stack first, then rerun this script"
    echo "[integrate] suggested command (from workspace root): docker compose --env-file .env up -d"
    exit 1
  fi
fi

upsert_env "OPENAI_BASE_URL" "$MODEL_ENDPOINT"
upsert_env "OPENAI_MODEL" "$DEFAULT_MODEL"
if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" && "$MODEL_ENDPOINT" == "http://127.0.0.1:3001/v1" ]]; then
  upsert_env "OPENAI_API_KEY" "$OPENCLAW_GATEWAY_TOKEN"
else
  upsert_env "OPENAI_API_KEY" "ollama"
fi

# Preserve explicit runtime mode if user has already set it.
if ! has_env_key "LIVE_STAGE"; then
  upsert_env "LIVE_STAGE" "dry-run"
fi
if ! has_env_key "DRY_RUN"; then
  upsert_env "DRY_RUN" "true"
fi

echo "[integrate] .env updated"

echo "[integrate] running build + preflight"
cd "$PROJECT_DIR"
npm run build
npm run live:preflight

echo "[integrate] done. start bot with: npm run dev"
