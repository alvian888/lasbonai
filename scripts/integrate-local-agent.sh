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

can_reach() {
  local url="$1"
  curl -sS -m 3 "$url" >/dev/null 2>&1
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

MODEL_ENDPOINT=""
DEFAULT_MODEL=""

if can_reach "http://127.0.0.1:3001/v1/models"; then
  MODEL_ENDPOINT="http://127.0.0.1:3001/v1"
  DEFAULT_MODEL="openclaw/default"
  echo "[integrate] detected OpenClaw gateway on :3001"
elif can_reach "http://127.0.0.1:11435/v1/models"; then
  MODEL_ENDPOINT="http://127.0.0.1:11435/v1"
  DEFAULT_MODEL="rahmatginanjar120/lasbonai:latest"
  echo "[integrate] detected Ollama gateway on :11435"
else
  echo "[integrate] no local AI endpoint found on :3001 or :11435"
  try_start_stack

  if can_reach "http://127.0.0.1:3001/v1/models"; then
    MODEL_ENDPOINT="http://127.0.0.1:3001/v1"
    DEFAULT_MODEL="openclaw/default"
    echo "[integrate] detected OpenClaw gateway on :3001 after docker startup"
  elif can_reach "http://127.0.0.1:11435/v1/models"; then
    MODEL_ENDPOINT="http://127.0.0.1:11435/v1"
    DEFAULT_MODEL="rahmatginanjar120/lasbonai:latest"
    echo "[integrate] detected Ollama gateway on :11435 after docker startup"
  else
    echo "[integrate] start your docker stack first, then rerun this script"
    echo "[integrate] suggested command (from workspace root): docker compose --env-file .env up -d"
    exit 1
  fi
fi

upsert_env "OPENAI_BASE_URL" "$MODEL_ENDPOINT"
upsert_env "OPENAI_MODEL" "$DEFAULT_MODEL"
upsert_env "OPENAI_API_KEY" "ollama"
upsert_env "LIVE_STAGE" "dry-run"
upsert_env "DRY_RUN" "true"

echo "[integrate] .env updated"

echo "[integrate] running build + preflight"
cd "$PROJECT_DIR"
npm run build
npm run live:preflight

echo "[integrate] done. start bot with: npm run dev"
