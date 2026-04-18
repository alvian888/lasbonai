#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_DIR="$(cd "$PROJECT_DIR/.." && pwd)"

echo "[compute] host cpu threads: $(nproc 2>/dev/null || echo unknown)"

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "[compute] host gpu:"
  nvidia-smi --query-gpu=name,driver_version,memory.total,utilization.gpu --format=csv,noheader || true
else
  echo "[compute] host gpu: nvidia-smi not available"
fi

echo "[compute] bot env profile keys:"
grep -E '^(BOT_UV_THREADPOOL_SIZE|BOT_GPU_ENABLED)=' "$PROJECT_DIR/.env" 2>/dev/null || echo "(not set)"

echo "[compute] root stack profile keys:"
grep -E '^(OPENCLAW_UV_THREADPOOL_SIZE|OLLAMA_NUM_PARALLEL|OLLAMA_MAX_LOADED_MODELS|OLLAMA_KEEP_ALIVE|OLLAMA_FLASH_ATTENTION)=' "$WORKSPACE_DIR/.env" 2>/dev/null || echo "(not set)"

if command -v docker >/dev/null 2>&1 && sg docker -c "docker ps >/dev/null 2>&1" >/dev/null 2>&1; then
  echo "[compute] container status:"
  sg docker -c "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -E 'NAMES|ollama|openclaw'"

  if sg docker -c "docker ps --format '{{.Names}}' | grep -Fx ollama" >/dev/null 2>&1; then
    echo "[compute] ollama container gpu check:"
    if ! sg docker -c "docker exec ollama nvidia-smi --query-gpu=name,utilization.gpu,memory.total --format=csv,noheader"; then
      echo "[compute] nvidia-smi is not present in ollama image; checking runtime bindings instead"
      sg docker -c "docker inspect ollama --format 'NVIDIA_VISIBLE_DEVICES={{range .Config.Env}}{{println .}}{{end}}' | grep NVIDIA_VISIBLE_DEVICES || true"
      sg docker -c "docker inspect ollama --format 'DeviceRequests={{json .HostConfig.DeviceRequests}}'"
      sg docker -c "docker inspect ollama --format 'Devices={{json .HostConfig.Devices}}'"
    fi
  fi
else
  echo "[compute] docker not accessible in current shell"
fi
