#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_DIR="$(cd "$PROJECT_DIR/.." && pwd)"
BOT_ENV="$PROJECT_DIR/.env"
ROOT_ENV="$WORKSPACE_DIR/.env"
ROOT_ENV_EXAMPLE="$WORKSPACE_DIR/.env.example"

upsert_env() {
  local file="$1"
  local key="$2"
  local value="$3"
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
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

cpu_threads="$(nproc 2>/dev/null || echo 8)"
if [[ -z "$cpu_threads" || "$cpu_threads" -lt 1 ]]; then
  cpu_threads=8
fi

if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  gpu_enabled="true"
  gpu_name="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1)"
else
  gpu_enabled="false"
  gpu_name="none"
fi

# Keep parallelism conservative to avoid starving scheduler/network tasks.
ollama_parallel=$(( cpu_threads / 4 ))
if [[ "$ollama_parallel" -lt 1 ]]; then
  ollama_parallel=1
fi
if [[ "$ollama_parallel" -gt 4 ]]; then
  ollama_parallel=4
fi

if [[ ! -f "$BOT_ENV" ]]; then
  cp "$PROJECT_DIR/.env.example" "$BOT_ENV"
fi

if [[ ! -f "$ROOT_ENV" ]]; then
  if [[ -f "$ROOT_ENV_EXAMPLE" ]]; then
    cp "$ROOT_ENV_EXAMPLE" "$ROOT_ENV"
  else
    touch "$ROOT_ENV"
  fi
fi

upsert_env "$BOT_ENV" "BOT_UV_THREADPOOL_SIZE" "$cpu_threads"
upsert_env "$BOT_ENV" "BOT_GPU_ENABLED" "$gpu_enabled"

upsert_env "$ROOT_ENV" "OPENCLAW_UV_THREADPOOL_SIZE" "$cpu_threads"
upsert_env "$ROOT_ENV" "OLLAMA_NUM_PARALLEL" "$ollama_parallel"
upsert_env "$ROOT_ENV" "OLLAMA_MAX_LOADED_MODELS" "2"
upsert_env "$ROOT_ENV" "OLLAMA_KEEP_ALIVE" "5m"
upsert_env "$ROOT_ENV" "OLLAMA_FLASH_ATTENTION" "$([[ "$gpu_enabled" == "true" ]] && echo 1 || echo 0)"

echo "[compute] applied profile"
echo "[compute] cpu_threads=$cpu_threads"
echo "[compute] gpu_enabled=$gpu_enabled"
echo "[compute] gpu_name=$gpu_name"
echo "[compute] ollama_num_parallel=$ollama_parallel"

if command -v docker >/dev/null 2>&1; then
  if sg docker -c "docker ps >/dev/null 2>&1" >/dev/null 2>&1; then
    echo "[compute] restarting AI services to apply profile"
    sg docker -c "cd '$WORKSPACE_DIR' && docker compose --env-file .env up -d ollama openclaw" >/dev/null
    echo "[compute] services updated: ollama, openclaw"
  else
    echo "[compute] docker not accessible in current shell; restart stack manually later"
  fi
fi
