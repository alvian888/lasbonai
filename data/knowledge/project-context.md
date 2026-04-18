# OKX Agentic Trading Bot — Knowledge Base

## Identitas
- **Nama**: OKX Agentic Trading Bot (LasbonAI)
- **Owner**: lasbonai (Rahmat Ginanjar)
- **Wallet**: `0x29aa2b1b72c888cb20f3c78e2d21ba225481b8a4` (BSC)
- **Profit Wallet**: `0x6cbc6c32d1b4ad211a08d6b3b1849cdbbdb4c0bb`
- **Chain**: Binance Smart Chain (BSC, chainId 56)
- **URL**: https://agentbot.lawas.co (Cloudflare Tunnel → localhost:8787)

## Arsitektur Sistem

### Stack Teknologi
- **Runtime**: Node.js + TypeScript (ESM)
- **Server**: Express.js @ port 8787
- **AI**: OpenAI SDK → Ollama local (http://127.0.0.1:11435/v1)
- **Model**: `rahmatginanjar120/lasbonai:latest` (temperature 0.1)
- **DEX**: OKX DEX API untuk swap quotes & execution
- **Chain RPC**: BSC via viem
- **Notifikasi**: Telegram Bot
- **Monitoring**: MySQL untuk logging, Telegram alerts
- **PWA**: Progressive Web App dashboard

### Komponen Utama

1. **server.ts** — Express HTTP server, routes: `/health`, `/api/bot/run`
2. **bot.ts** — `AgenticTradingBot` orchestrator: get quotes → baseline strategy → AI decision → execute
3. **ai-agent.ts** — `AiTradeAgent`: LLM-powered trade decisions via Ollama
4. **baseline-strategy.ts** — Rule-based strategy: honeypot check, fee analysis, signal inference
5. **bsc-monitor.ts** — BSC token price monitor: real-time tracking, alerts, auto-execute
6. **scheduler.ts** — Periodic cycle runner (configurable interval)
7. **position-tracker.ts** — P&L tracking, cost basis, unrealized gains
8. **okx-client.ts** — OKX DEX API wrapper (quote, build swap, approve)
9. **candidate-scan.ts** — BEP-20 token candidate scanner
10. **telegram.ts** — Telegram notification formatting & sending
11. **post-session-learn.ts** — Post-session error analysis & learning

### Execution Providers
- **local-wallet** — Direct on-chain via private key + viem
- **okx-agentic-wallet** — OKX Wallet API
- **onchainos** — OnchainOS CLI bridge

## Portfolio (17 Token BSC)

### Token Aktif
| Symbol | Kategori | Holdings | Entry Price | Buy Zone | SL | T1 | T2 | T3 | Trail% |
|--------|----------|----------|-------------|----------|----|----|----|----|----|
| AXL | moonshot | 0.00052 | $0.049 | -3% | -5% | +15% | +30% | +50% | 8% |
| DOGE | swing | 0.00162 | $0.095 | -4% | -5% | +10% | +20% | +30% | 6% |
| TKO | hold | 308.38 | $0.061 | -3% | -5% | +10% | +20% | +30% | 6% |
| XPL | swing | 119.04 | $0.126 | -4% | -5% | +10% | +20% | +30% | 6% |
| LAWAS | moonshot | 199749 | $0.000028 | -3% | -5% | +15% | +30% | +50% | 8% |
| SAPI | moonshot | 1408 | $0.0047 | -3% | -5% | +15% | +30% | +50% | 8% |
| BTT | moonshot | 0.81 | $0.00000033 | -3% | -5% | +15% | +30% | +50% | 8% |
| FIL | swing | 15.16 | $1.00 | -4% | -5% | +10% | +20% | +30% | 6% |
| LTC | hold | 0.089 | $56.29 | -3% | -5% | +10% | +20% | +30% | 6% |
| LINK | swing | 0.526 | $9.59 | -4% | -5% | +10% | +20% | +30% | 6% |
| XRP | swing | 3.486 | $1.46 | -4% | -5% | +10% | +20% | +30% | 6% |
| ETH | hold | 0.000014 | $2420 | -3% | -5% | +10% | +20% | +30% | 6% |
| BNB | hold | 0.0057 | $622 | -3% | -5% | +10% | +20% | +30% | 6% |
| WBNB | hold | 0.004 | $636 | -3% | -5% | +10% | +20% | +30% | 6% |

### Stablecoin
| Symbol | Holdings |
|--------|----------|
| USDT | 149.70 |
| IDRX | 49500 |
| USDC | 1.00 |

## Strategi Trading

### Kategori & Parameter
1. **moonshot** — High-risk/high-reward tokens
   - Buy zone: -3% dari current
   - Stop-loss: -5%
   - Take profit: T1 +15%, T2 +30%, T3 +50%
   - Trailing stop: 8%

2. **swing** — Medium-term positions
   - Buy zone: -4% dari current
   - Stop-loss: -5%
   - Take profit: T1 +10%, T2 +20%, T3 +30%
   - Trailing stop: 6%

3. **hold** — Long-term holdings
   - Buy zone: -3% dari current
   - Stop-loss: -5%
   - Take profit: T1 +10%, T2 +20%, T3 +30%
   - Trailing stop: 6%

4. **stablecoin** — USDT, USDC, IDRX — no active trading

### Decision Flow
1. Bot mendapatkan buy/sell quotes dari OKX DEX
2. Baseline strategy evaluasi: honeypot check, fee analysis, signal inference
3. AI (Ollama) analisa dan beri keputusan: buy/sell/hold + confidence + reasoning
4. Jika baseline = hold ATAU AI fallback → gunakan baseline
5. Jika confidence < 0.65 → preview only (tidak execute)
6. Jika DRY_RUN = true → preview (tidak kirim on-chain)
7. Jika semua OK → execute swap via execution provider

### Risk Management
- Max confidence to execute: 0.65
- DCA buy amount: $15 USDT per auto-buy
- Auto-buy cooldown: 3 jam antar DCA per token
- Alert cooldown: 15 menit per alert type
- Sell portion: configurable percentage dari holdings
- Max buy/sell amount caps
- Honeypot & high-tax detection (>10% tax = blocked)

## Monitoring & Alerts

### BSC Monitor Features
- Real-time price via onchainos CLI
- Console dashboard warna-kode status
- Telegram alerts: buy zone, sell targets (T1/T2/T3), stop-loss, trailing stop
- Trailing stop tracking per token (peak price, dynamic stop)
- Auto-execute untuk token dengan `autoExecute: true`
- Volume monitoring: 5m, 1h, 4h, 24h
- Liquidity & market cap tracking
- Signal classification: STOP_LOSS, TRAILING_STOP, SELL_T1/T2/T3, BUY_ZONE, HOLD

### Signals
- `STOP_LOSS`: Price <= stopLoss → urgent sell
- `TRAILING_STOP`: Price <= dynamic trailing stop → sell to lock profit
- `SELL_T1/T2/T3`: Price >= target → partial/full sell
- `BUY_ZONE`: Price <= buyZone → DCA buy opportunity
- `HOLD`: No action needed

## Konfigurasi Environment

### Variabel Penting
- `PORT=8787` — server port
- `DRY_RUN=true` — mode simulasi (tidak execute real swap)
- `OPENAI_API_KEY=ollama` — key untuk Ollama
- `OPENAI_BASE_URL=http://127.0.0.1:11435/v1` — Ollama endpoint
- `OPENAI_MODEL=rahmatginanjar120/lasbonai:latest` — model AI
- `MAX_CONFIDENCE_TO_EXECUTE=0.65` — minimum confidence untuk real execution
- `SCHEDULE_ENABLED` — aktifkan scheduler
- `SCHEDULE_INTERVAL_MINUTES` — interval cycle
- `EXECUTION_PROVIDER` — local-wallet / okx-agentic-wallet / onchainos

## API Endpoints

### GET /health
Response: `{ ok: true, dryRun: true, model: "rahmatginanjar120/lasbonai:latest" }`

### POST /api/bot/run
Request body:
```json
{
  "chainId": "56",
  "walletAddress": "0x29aa...",
  "baseTokenAddress": "0x405f...",
  "quoteTokenAddress": "0x55d3...",
  "buyAmount": "1000000000000000000",
  "sellAmount": "1000000000000000000",
  "slippage": "0.005",
  "marketContext": "optional context string"
}
```
Response: BotRunResult with decision, quotes, execution status

### POST /api/chat (NEW)
Chat endpoint untuk interaksi langsung dengan AI assistant.
Kirim pertanyaan tentang portfolio, strategi, status bot, dll.

## Profit Management
- **Profit wallet**: Weekly withdrawal target
- **Modal awal tracking**: Reset setiap Senin / setelah withdrawal
- **IDRX→BNB gradual swap**: Automated chunk swapping strategy
- **USD to IDR rate**: Rp 16.800

## Catatan Teknis
- Semua harga dalam USD kecuali IDRX (IDR-pegged)
- Token address "native" = BNB (gas token)
- USDT address: `0x55d398326f99059ff775485246999027b3197955`
- PancakeSwap & OKX DEX deep-links tersedia untuk swap UI
- Honeypot detection aktif via OKX quote response
- Tax rate > 10% = trade blocked otomatis
