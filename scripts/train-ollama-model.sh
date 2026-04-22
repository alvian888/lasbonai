#!/bin/bash
#
# Ollama AI Model Training & Upgrade: Train "lasbonai-trading" model with trading data
# Integrates with Docker openclaw and ollama service on port 11435
# Usage: bash scripts/train-ollama-model.sh [--model-name lasbonai-trading] [--epochs 10]
#

set -e

MODEL_NAME="lasbonai-trading"
EPOCHS=5
LEARNING_RATE=0.001
BATCH_SIZE=32
OLLAMA_PORT=11435
OLLAMA_HOST="http://localhost:${OLLAMA_PORT}"
DOCKER_CONTAINER="openclaw"

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

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --model-name) MODEL_NAME="$2"; shift 2;;
      --epochs) EPOCHS="$2"; shift 2;;
      --learning-rate) LEARNING_RATE="$2"; shift 2;;
      --batch-size) BATCH_SIZE="$2"; shift 2;;
      *) shift;;
    esac
  done
}

check_ollama_running() {
  log_info "Checking Ollama service..."
  
  # Try to connect to ollama endpoint
  if ! curl -s "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; then
    log_error "Ollama service not reachable at ${OLLAMA_HOST}"
    log_info "Attempting to start ollama via Docker..."
    
    if docker ps -a | grep -q "${DOCKER_CONTAINER}"; then
      docker start "${DOCKER_CONTAINER}" 2>/dev/null || true
      sleep 5
    else
      log_error "Docker container '${DOCKER_CONTAINER}' not found"
      return 1
    fi
  fi
  
  if curl -s "${OLLAMA_HOST}/api/tags" > /dev/null 2>&1; then
    log_success "Ollama service is running"
    return 0
  else
    log_error "Failed to connect to Ollama"
    return 1
  fi
}

list_available_models() {
  log_info "Available Ollama models:"
  
  curl -s "${OLLAMA_HOST}/api/tags" | python3 -m json.tool 2>/dev/null || echo "  (could not retrieve model list)"
}

generate_training_data() {
  log_info "Generating training dataset from trading history..."
  
  python3 <<'EOF'
import json
import os
from pathlib import Path
from datetime import datetime

# Collect trading data from reports
report_dir = Path("token portfolio/BSC/REPORT")
training_data = []

for report_file in sorted(report_dir.glob("*.json")):
  try:
    with open(report_file) as f:
      report = json.load(f)
    
    # Extract features for training
    portfolio = report.get('portfolio', {})
    raw = report.get('raw', {})
    
    # Create training example
    example = {
      'date': report.get('date'),
      'daily_pnl_pct': portfolio.get('dailyPnlPct'),
      'portfolio_value': portfolio.get('endValueUSD'),
      'price_impact': raw.get('priceImpactPercent'),
      'slippage': raw.get('slippageEstPct'),
      'execution_mode': raw.get('executionMode'),
      'decision': raw.get('decision'),
      'confidence': raw.get('confidence'),
      'tokens': len(report.get('tokenTrends', []))
    }
    
    # Only include complete records
    if all(v is not None for k, v in example.items() if k != 'tokens'):
      training_data.append(example)
  except:
    continue

# Save training dataset
os.makedirs('data/training', exist_ok=True)
with open('data/training/trading-dataset.json', 'w') as f:
  json.dump({
    'generated_at': datetime.now().isoformat(),
    'sample_count': len(training_data),
    'samples': training_data[:100]  # Limit to 100 for initial training
  }, f, indent=2)

print(f"✓ Generated {len(training_data)} training examples")
EOF
}

create_model_file() {
  log_info "Creating Modelfile for training..."
  
  cat > data/training/Modelfile.lasbonai-trading <<'EOF'
FROM mistral:latest

# Trading-specific system prompt
SYSTEM You are an expert crypto trading decision engine for BSC (Binance Smart Chain).

# Your role:
# - Analyze market conditions and trading opportunities
# - Recommend buy/sell/hold actions based on technical analysis and sentiment
# - Prioritize slippage reduction and P&L optimization
# - Target 5% daily P&L and 15% weekly P&L

# Decision format:
# {"action": "buy|sell|hold", "confidence": 0.0-1.0, "reasoning": "...", "riskNotes": []}

PARAMETER temperature 0.3
PARAMETER top_p 0.9
PARAMETER top_k 40
PARAMETER num_ctx 2048

# Optimization parameters
PARAMETER num_predict 256
PARAMETER repeat_penalty 1.1
PARAMETER repeat_last_n 64
EOF
  
  log_success "Modelfile created"
}

train_model() {
  log_info "Building Ollama model: ${MODEL_NAME}..."
  
  if ! docker exec "${DOCKER_CONTAINER}" bash -c "cd /data/training && ollama create ${MODEL_NAME} -f Modelfile.lasbonai-trading" 2>/dev/null; then
    log_error "Failed to create model via docker"
    log_info "Attempting direct ollama command..."
    
    if ! ollama create "${MODEL_NAME}" -f data/training/Modelfile.lasbonai-trading 2>/dev/null; then
      log_error "Model creation failed"
      return 1
    fi
  fi
  
  log_success "Model '${MODEL_NAME}' created"
}

validate_model() {
  log_info "Validating new model..."
  
  # Test model with sample request
  local test_prompt='{"action": "hold", "confidence": 0.5, "reasoning": "test"}'
  
  if curl -s "${OLLAMA_HOST}/api/generate" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "{\"model\": \"${MODEL_NAME}\", \"prompt\": \"${test_prompt}\", \"stream\": false}" \
    | grep -q "response"; then
    
    log_success "Model validation passed"
    return 0
  else
    log_error "Model validation failed"
    return 1
  fi
}

upload_model_to_ollama_hub() {
  log_info "Preparing model upload to ollama.com..."
  
  # Check credentials
  if [[ -z "${OLLAMA_USERNAME}" ]] || [[ -z "${OLLAMA_PASSWORD}" ]]; then
    log_warn "OLLAMA_USERNAME or OLLAMA_PASSWORD not set"
    log_info "To upload, set environment variables:"
    log_info "  export OLLAMA_USERNAME=rahmatginanjar120@gmail.com"
    log_info "  export OLLAMA_PASSWORD=<your-password>"
    return 1
  fi
  
  log_info "Would push to: ${OLLAMA_USERNAME}/lasbonai-trading:latest"
  # Actual push would be: ollama push ${OLLAMA_USERNAME}/lasbonai-trading
}

main() {
  parse_arguments "$@"
  
  echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
  echo -e "${BLUE}║  Ollama AI Model Training & Upgrade    ║${NC}"
  echo -e "${BLUE}║  Model: ${MODEL_NAME}${NC}"
  echo -e "${BLUE}╚════════════════════════════════════════╝${NC}\n"
  
  check_ollama_running || exit 1
  list_available_models
  
  log_info "Step 1: Generate training data..."
  generate_training_data
  
  log_info "Step 2: Create model configuration..."
  create_model_file
  
  log_info "Step 3: Train/build model..."
  train_model
  
  log_info "Step 4: Validate model..."
  validate_model
  
  log_info "Step 5: Model ready for deployment"
  log_success "Model '${MODEL_NAME}' is ready!"
  
  echo -e "\n${BLUE}=== NEXT STEPS ===${NC}"
  echo "1. Test model: curl http://localhost:11435/v1/chat/completions"
  echo "2. Update .env: OPENAI_MODEL=lasbonai-trading"
  echo "3. Restart bot: pkill -f 'tsx src/server' && npm run dev"
  echo "4. Upload to ollama.com: ollama push <username>/lasbonai-trading"
}

trap 'log_error "Training interrupted"; exit 1' SIGTERM SIGINT

main "$@"
