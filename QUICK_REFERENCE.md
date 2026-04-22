# 🚀 OKX BOT QUICK REFERENCE - LIVE MONITORING ACTIVE

## ⚡ STATUS RIGHT NOW
- ✅ **Bot Running:** `http://127.0.0.1:8787/health`
- ✅ **Monitor Active:** PID 491422
- ✅ **Validation:** 7/7 tests PASSING
- ✅ **Live Trading:** DRY_RUN=false (ACTIVE)
- ✅ **Telegram Alerts:** CONFIGURED

---

## 📋 QUICK COMMANDS

### View Monitoring in Real-Time
```bash
tail -f data/logs/monitor-*.log
```

### View Bot Logs
```bash
tail -f data/logs/bot-*.log
```

### Check Bot Health
```bash
curl http://127.0.0.1:8787/health
```

### Stop Monitor & Bot
```bash
pkill -f "monitor-bot.sh"
```

### Start Monitor (Fresh)
```bash
npm run monitor:bot
```

### Run Full Validation
```bash
npm run validate:full
```

### Quick Validation
```bash
npm run validate:quick
```

---

## 📊 MONITORING FEATURES ENABLED

| Feature | Status | Details |
|---------|--------|---------|
| **Health Check** | ✅ | Every 5 seconds via HTTP GET |
| **10-Min Watchdog** | ✅ | Kills stuck processes automatically |
| **Error Detection** | ✅ | Scans logs for error patterns every cycle |
| **Auto-Restart** | ✅ | On process crash or health failure |
| **Telegram Alerts** | ✅ | Immediate notification on issues |
| **Log Rotation** | ✅ | Timestamped logs in `data/logs/` |
| **Cycle Tracking** | ✅ | Elapsed time monitoring per cycle |

---

## 🔔 WHAT GETS ALERTED

### Immediate Alert Triggers
1. **Bot Process Dies** → Restart + Alert
2. **Health Check Fails** → Restart + Alert  
3. **Errors in Logs** → Alert + Continue
4. **10-Min Timeout** → Kill + Restart + Alert

### Telegram Chat Location
- **Bot:** OKX_BOT (@OKXONE_BOT)
- **Recipient:** Epensakti (Private Chat)
- **Response Time:** <1 second from detection

---

## 📈 TRADING STATUS

**Current Configuration:**
- **Pair:** XPL/USDT on BNB Chain (chainId 56)
- **Wallet:** 0x29aa2b1b72c888cb20f3c78e2d21ba225481b8a4
- **Balance:** 186.25 USDT
- **Mode:** LIVE (DRY_RUN=false)
- **Stage:** canary
- **Max Position:** $150 USD
- **Min Notional:** $50 USD
- **Target Slippage:** 0.3%
- **P&L Target:** >15% daily/weekly

**Trading Logic:**
1. Every 5 minutes: Run sentiment analysis
2. Get trading candidates from scanning
3. Evaluate baseline strategy (risk guards)
4. Get AI decision from Ollama model
5. Merge decisions with confidence weighting
6. Execute trade if confidence ≥0.75
7. Send Telegram notification

---

## 🔐 ENVIRONMENT VERIFICATION

```bash
# Check key configs
echo "Live Mode:" && grep "^DRY_RUN=" .env
echo "Model:" && grep "^OPENAI_MODEL=" .env  
echo "Stage:" && grep "^LIVE_STAGE=" .env
echo "Port:" && grep "^PORT=" .env
echo "Bot Token:" && grep "^TELEGRAM_BOT_TOKEN=" .env
```

---

## 🛠️ IF SOMETHING BREAKS

### Bot Crashes?
- Monitor auto-restarts it
- Telegram alert sent within 5 seconds
- Check: `tail -50 data/logs/bot-*.log`

### Monitor Crashes?
- Start manually: `npm run monitor:bot`
- Check: `ps aux | grep monitor-bot`

### Telegram Alerts Not Arriving?
- Run: `npm run telegram:test`
- Check .env has TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
- Verify bot token is still valid in Telegram

### Health Check Failing?
- Check if port 8787 is open: `lsof -i :8787`
- Check bot process: `ps aux | grep -E "npm|tsx"`
- Check logs: `tail -20 data/logs/bot-*.log`

---

## 📍 KEY FILE LOCATIONS

```
Project Root: /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/

Monitor Script:
  └─ scripts/monitor-bot.sh

Logs:
  ├─ data/logs/monitor-YYYYMMDD-HHMMSS.log  (Monitor activity)
  └─ data/logs/bot-TIMESTAMP.log             (Bot output)

Configuration:
  ├─ .env                                    (Credentials & settings)
  ├─ tsconfig.json                           (TypeScript config)
  └─ package.json                            (Scripts & deps)

Trading Data:
  ├─ data/trade-state.json                   (Trade history)
  ├─ data/bep20-candidates.latest.json      (Token candidates)
  └─ data/telegram-sentiment.json            (Sentiment data)

Monitoring:
  └─ MONITORING.md                           (Full documentation)
```

---

## ✨ WHAT'S NEW (Latest Deployment)

✅ **Active Monitoring System**
- Continuous health checking every 5 seconds
- Automatic error detection and alerting
- 10-minute watchdog with auto-restart
- Telegram integration for immediate alerts
- Process crash recovery in <5 seconds

✅ **Error Detection**
- Scans bot logs for error patterns
- Searches: "error", "exception", "failed", "fatal"
- Alerts sent immediately upon detection
- No silent failures

✅ **Auto-Recovery**
- Process crash → Auto-restart
- Health failure → Auto-restart
- Error detected → Alert + Continue
- Watchdog timeout → Kill + Restart

---

## 🎯 NEXT MONITORING STEPS

1. **Watch First 24 Hours**
   - Monitor for stability
   - Check Telegram alerts working
   - Verify no false positives

2. **Track P&L**
   - Check daily results in trade-state.json
   - Validate >15% weekly target
   - Correlate with slippage metrics

3. **Log Analysis**
   - Review error patterns if any
   - Identify optimization opportunities
   - Note recurring issues

4. **Model Training (Next Phase)**
   - Export trade history as training data
   - Create "lasbonai-trading" Ollama model
   - Test with smaller positions first

---

**Last Updated:** 2026-04-20 06:53:01  
**Status:** 🟢 LIVE PRODUCTION MONITORING  
**Uptime:** Continuous with auto-recovery
