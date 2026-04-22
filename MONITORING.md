# OKX Agentic Bot - Active Monitoring System

## 🔴 LIVE DEPLOYMENT STATUS

**Deployment Time:** 2026-04-20 06:53:01  
**Monitoring Process:** PID 491422 (bash ./scripts/monitor-bot.sh)  
**Bot Health:** ✅ OPERATIONAL  
**Validation Status:** ✅ All 9/9 Tests PASSING

---

## 📊 MONITORING CAPABILITIES

### 1️⃣ **Continuous Health Monitoring**
- **Interval:** Every 5 seconds
- **Health Check:** HTTP GET to `http://127.0.0.1:8787/health`
- **Success Response:** `{"ok":true,"dryRun":false,"model":"..."}`
- **Action on Failure:** Automatic restart + Telegram alert

### 2️⃣ **10-Minute Watchdog Timer**
- **Purpose:** Kill stuck processes that exceed 10 minutes in a cycle
- **Implementation:** Elapsed time tracking in monitor-bot.sh
- **Action on Timeout:** Kill process → Restart → Send alert
- **Alert Format:** Telegram message with elapsed time

### 3️⃣ **Error Detection & Alerting**
- **Error Patterns:** `error`, `exception`, `failed`, `fatal`
- **Source:** Bot process logs (`data/logs/bot-*.log`)
- **Scanning:** Last 100 lines of recent logs every cycle
- **Action:** Telegram alert sent immediately on error detection
- **No Silent Failures:** All errors logged and notified

### 4️⃣ **Auto-Recovery System**
- **Trigger Conditions:**
  - Bot process dies (kill -0 fails)
  - Health check returns non-200 HTTP code
  - Errors detected in logs
  - 10-minute watchdog timeout
- **Recovery Flow:**
  1. Stop existing process (SIGTERM, then SIGKILL)
  2. Wait 2 seconds
  3. Start new bot process
  4. Verify health check passes
  5. Resume monitoring

### 5️⃣ **Telegram Integration**
- **Bot Token:** `8502781876:AAH-zhd9w_w0kQFrx0OmKBpoKyWpfdrcRAI`
- **Chat ID:** `8706918319`
- **Alert Types:**
  - ✅ Startup confirmations
  - ⚠️ Restart notifications
  - ❌ Crash alerts
  - ⏱️ Watchdog timeout warnings
  - 🔍 Error detection alerts

---

## 🔧 HOW TO USE

### Start Monitoring (If Not Running)
```bash
npm run monitor:bot
# or
bash ./scripts/monitor-bot.sh
```

### View Live Monitoring Status
```bash
tail -f /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/monitor-*.log
```

### View Monitor Dashboard
```bash
/tmp/monitor-dashboard.sh
```

### Stop Monitoring
```bash
pkill -f "monitor-bot.sh"
```

---

## 📈 MONITORING LOGS LOCATION

**Monitor Logs:**
```
/home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/monitor-YYYYMMDD-HHMMSS.log
```

**Bot Logs:**
```
/home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/bot-TIMESTAMP.log
```

---

## 🎯 EXPECTED BEHAVIOR

### Normal Operation
```
[2026-04-20 06:53:01] OKX Agentic Bot Monitoring Started
[2026-04-20 06:53:01] ✅ Bot is already running and healthy
[2026-04-20 06:53:01] === Monitoring cycle started ===
[2026-04-20 06:53:06] ✅ Health check OK (cycle 1, elapsed: 5012ms)
[2026-04-20 06:53:11] ✅ Health check OK (cycle 2, elapsed: 10056ms)
...
```

### Error Detection
```
[2026-04-20 06:53:45] ⚠️ Errors detected in bot logs:
[2026-04-20 06:53:45]   Error: Connection timeout
[2026-04-20 06:53:45]   [Telegram Alert Sent]
```

### Process Crash & Recovery
```
[2026-04-20 06:54:00] ❌ Bot process (PID 12345) is not running
[2026-04-20 06:54:00] ⚠️ Restarting bot...
[2026-04-20 06:54:02] Bot started with PID 12346
[2026-04-20 06:54:05] ✅ Bot health check PASSED
[2026-04-20 06:54:05] === Monitoring cycle started ===
```

### Watchdog Timeout (10 minutes)
```
[2026-04-20 07:04:00] ⏱️ 10-minute watchdog triggered (elapsed: 600000ms)
[2026-04-20 07:04:00] ⚠️ Restarting bot...
[2026-04-20 07:04:02] Bot started with PID 12347
[2026-04-20 07:04:05] ✅ Bot health check PASSED
```

---

## 🚨 ALERTS SENT TO TELEGRAM

All alerts are sent to **@Epensakti** private chat via the **OKX_BOT**:

1. **✅ Startup Confirmation**
   - Sent when monitoring starts and bot is healthy
   - Timestamp included

2. **⚠️ Restart Notification**
   - Sent when bot is restarted (any reason)
   - Previous failure reason included

3. **❌ Crash Alert**
   - Sent when bot process dies unexpectedly
   - Timestamp and reason included

4. **⏱️ Watchdog Alert**
   - Sent when 10-minute timeout exceeded
   - Elapsed time shown

5. **🔍 Error Detection Alert**
   - Sent when errors found in logs
   - First 3 error lines included

---

## 🔐 CONFIGURATION

### Bot Health Endpoint
- **URL:** `http://127.0.0.1:8787/health`
- **Port:** 8787 (configurable via PORT env var)
- **Expected Response:** `{"ok":true,"dryRun":false,"model":"..."}`

### Monitor Configuration (in monitor-bot.sh)
- **Health Check Interval:** 5 seconds
- **Watchdog Timeout:** 10 minutes (600,000 ms)
- **Log Retention:** Latest monitor log in `data/logs/`
- **Max Log Lines Scanned:** 100 lines for errors

### Environment Variables
```
PORT=8787                          # Bot server port
TELEGRAM_BOT_TOKEN=...             # Telegram bot token
TELEGRAM_CHAT_ID=...               # Telegram chat ID
DRY_RUN=false                      # Live trading enabled
LIVE_STAGE=canary                  # Stage setting
```

---

## ✅ VALIDATION & TESTING

All bot functionality validated before monitoring activation:

- ✅ Build: TypeScript compilation SUCCESS
- ✅ Preflight: Dependencies and environment ready
- ✅ Health: Endpoint responding correctly
- ✅ Functional (Bullish): Trading decisions working
- ✅ Functional (Safety): Risk guards active
- ✅ Assertions: All validations passed
- ✅ Candidates: Token scanning operational
- ✅ Telegram: Notifications working

---

## 📝 MONITORING STATISTICS

**From Latest Monitoring Cycle:**
- Started: 2026-04-20 06:53:01
- Cycles Completed: 6+ (continuing)
- Errors Detected: 0
- Auto-Restarts: 0
- Health Check Success Rate: 100%

---

## 🛠️ TROUBLESHOOTING

### Monitor Not Running
```bash
# Check if monitor process exists
pgrep -a bash | grep monitor-bot

# Manually start
bash /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/scripts/monitor-bot.sh
```

### Bot Not Starting
```bash
# Check bot logs
tail -50 /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/bot-*.log

# Check if port 8787 is in use
lsof -i :8787

# Manually start bot for debugging
npm run dev
```

### Telegram Alerts Not Sending
```bash
# Verify bot token and chat ID in .env
grep TELEGRAM /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/.env

# Test Telegram connection
npm run telegram:test
```

---

## 🎯 NEXT STEPS

1. **Monitor Real Trading Cycles** - Watch for first 24-48 hours
2. **Verify Alert Responsiveness** - Confirm Telegram notifications arriving
3. **Check Daily P&L** - Validate >15% target with optimized thresholds
4. **Review Error Patterns** - Analyze any detected errors for fixes
5. **Enable Model Training** - Prepare "lasbonai-trading" model once stable

---

**Status:** LIVE PRODUCTION MONITORING  
**Last Updated:** 2026-04-20 06:53:01  
**Documentation:** Comprehensive monitoring deployed
