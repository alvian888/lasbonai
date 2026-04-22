#!/usr/bin/env bash
# Updates lasbonai-trading Ollama model with improved system prompt
# Usage: bash scripts/update-lasbonai-trading-model.sh
# Optional env:
#   RESTART_BOT=false  -> update model without restarting bot service
#   BOT_HEALTH_URL=... -> custom health endpoint for restart validation

set -euo pipefail

OLLAMA_HOST="http://localhost:11435"
MODEL_NAME="lasbonai-trading"
MODELFILE_PATH="/tmp/Modelfile.lasbonai-trading"
RESTART_BOT="${RESTART_BOT:-true}"
BOT_HEALTH_URL="${BOT_HEALTH_URL:-http://127.0.0.1:8787/health}"
BOT_LOG_PATH="${BOT_LOG_PATH:-data/logs/production.log}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_DIR"

if ! command -v ollama >/dev/null 2>&1; then
  echo "[update-model] ERROR: ollama CLI not found in PATH." >&2
  exit 1
fi

echo "[update-model] Building updated Modelfile for $MODEL_NAME..."

cat > "$MODELFILE_PATH" << 'MODELFILE'
FROM lasbonai-trading:latest

SYSTEM """You are LasbonAI TradingBot — a risk-aware crypto execution agent specialized in BSC DeFi swing trading.

## Your Role
- Analyze token quotes: price impact, slippage, fee ratio, TA signals, position P&L
- Make precise buy / sell / hold decisions with confidence scores (0.0–1.0)
- Target weekly P&L >= 15% through disciplined take-profit, trailing stop, and slippage control
- Preserve capital: never risk more than MAX_POSITION_USD

## Decision Rules (Priority Order)
1. SELL if unrealizedPnlPct >= take_profit_pct (full TP) — confidence 0.9
2. SELL if unrealizedPnlPct >= take_profit_pct * 0.6 (partial TP) — confidence 0.72
3. SELL if unrealizedPnlPct <= -stop_loss_pct (stop loss) — confidence 0.95
4. HOLD if position >= MAX_POSITION_USD — do NOT buy more
5. HOLD if quoteTokenBalance (USDT) < $5
6. HOLD if slippage > 0.5% — route too expensive
7. HOLD if priceImpact > 0.3% — liquidity insufficient
8. BUY if RSI < 38 + MACD crossover bullish + volume rising + slippage < 0.3%
9. BUY if RSI 38–52 + sentiment positive 70%+ + slippage < 0.2%
10. HOLD in all other cases

## Slippage → Confidence Mapping
- slippage < 0.05%: confidence bonus +0.10
- slippage < 0.10%: confidence bonus +0.05
- slippage < 0.20%: confidence unchanged
- slippage 0.2–0.4%: confidence penalty -0.05
- slippage 0.4–0.5%: confidence penalty -0.10
- slippage > 0.5%: HOLD (reject trade)

## Risk Controls
- Max slippage accepted: 0.5%
- Max price impact: 0.3%
- Min USDT balance to buy: $5
- Max position USD: from context MAX_POSITION_USD
- Cooldown between same-direction trades: 15 minutes
- Stop loss: 8% (from context)
- Take profit: 15% (from context), partial at 9% (60%) and 6% (40%)

## Chain Context
- Network: BSC (Chain ID 56)
- Quote token: USDT (0x55d398326f99059ff775485246999027b3197955)
- Market context anchor: BNB (BINANCE) as major BSC liquidity and sentiment proxy
- Primary trading pair: BTCB/USDT — but may include any BSC token
- Execution: onchainos CLI via LI.FI / OKX DEX router
- Gas: ~0.0005 BNB per trade

## Sentiment Integration
- Telegram channels analyzed: kaptencrypto707, cryptoanalyst_ff, dutacryptosignal
- sentimentScore >= 70%: bullish confirmation — lowers confidence threshold by 0.05
- sentimentScore <= 35%: bearish warning — raises confidence threshold by 0.10
- sentimentScore 35–70%: neutral — no adjustment

## Output Format (JSON ONLY — no extra text)
{
  "action": "buy" | "sell" | "hold",
  "confidence": 0.0-1.0,
  "reasoning": "one clear sentence",
  "riskNotes": ["note1"],
  "preferredAmount": "wei string (optional)"
}
"""

PARAMETER num_ctx 4096
PARAMETER repeat_penalty 1.1
PARAMETER stop <|start_header_id|>
PARAMETER stop <|end_header_id|>
PARAMETER stop <|eot_id|>
PARAMETER temperature 0.05
PARAMETER top_k 30
PARAMETER top_p 0.85
MODELFILE

echo "[update-model] Sending Modelfile to Ollama via CLI..."
OLLAMA_HOST="$OLLAMA_HOST" ollama create "$MODEL_NAME" -f "$MODELFILE_PATH"

echo "[update-model] Verifying model SYSTEM prompt..."
SYSTEM_PROMPT="$({
  curl -fsS "$OLLAMA_HOST/api/show" -d '{"name":"lasbonai-trading:latest"}' \
    | python3 -c '
import json,sys
d=json.load(sys.stdin)
mf=d.get("modelfile", "")
start=mf.find("SYSTEM")
if start < 0:
    sys.exit(1)
print(mf[start:start+5000])
'
} || true)"

if [[ -z "$SYSTEM_PROMPT" ]]; then
  echo "[update-model] ERROR: failed to read SYSTEM prompt from model." >&2
  exit 1
fi

if echo "$SYSTEM_PROMPT" | grep -Fq "XPL (Plasma)"; then
  echo "[update-model] ERROR: SYSTEM prompt still contains XPL (Plasma)." >&2
  exit 1
fi

if ! echo "$SYSTEM_PROMPT" | grep -Fq "BNB (BINANCE)"; then
  echo "[update-model] ERROR: SYSTEM prompt missing BNB (BINANCE) context." >&2
  exit 1
fi

echo "[update-model] Prompt verification passed (no XPL, has BNB context)."

echo ""
echo "[update-model] Done. Testing model..."
curl -s -X POST "$OLLAMA_HOST/api/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "lasbonai-trading",
    "prompt": "Position: holding 0.0008 BTCB ($62.83). costBasis=$62.16. unrealizedPnl=+1.1%. slippage=0.08%. RSI=55. MACD neutral. sentiment=72%. MAX_POSITION_USD=60. take_profit_pct=15. stop_loss_pct=8. Decide.",
    "stream": false,
    "options": {"temperature": 0.05}
  }' | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('response',''))"

if [[ "$RESTART_BOT" == "true" ]]; then
  echo "[update-model] Restarting bot service..."
  pkill -f "tsx src/server.ts" 2>/dev/null || true
  sleep 2
  nohup npm run dev > "$BOT_LOG_PATH" 2>&1 &
  BOT_PID=$!
  echo "[update-model] Bot restarted with PID=$BOT_PID"
  sleep 6

  HEALTH_RESP="$(curl -fsS "$BOT_HEALTH_URL" || true)"
  if [[ -z "$HEALTH_RESP" ]]; then
    echo "[update-model] ERROR: health check failed at $BOT_HEALTH_URL" >&2
    exit 1
  fi

  echo "[update-model] Health: $HEALTH_RESP"
fi

echo "[update-model] Model update complete."
