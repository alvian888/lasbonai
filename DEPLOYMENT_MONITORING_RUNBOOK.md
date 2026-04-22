# Production Systemd Deployment — Continuous Monitoring Runbook

## 📊 Daily Operational Checklist

### Morning (09:00 WIB)
```bash
#!/bin/bash
# File: scripts/daily-health-check.sh

cd /home/lasbonai/Desktop/lasbonai/okx-agentic-bot

echo "=== Daily Health Check $(date '+%Y-%m-%d %H:%M:%S') ==="

# 1. Check bot service
echo "1️⃣ Bot Service Status:"
systemctl --user is-active okx-bot.service || echo "⚠️ Bot not running!"

# 2. Check timer
echo "2️⃣ NOC Timer Status:"
systemctl --user is-active noc-probe-runner.timer || echo "⚠️ Timer not running!"

# 3. Check memory usage
echo "3️⃣ Bot Memory Usage:"
systemctl --user status okx-bot.service --no-pager | grep Memory

# 4. Latest NOC status
echo "4️⃣ Latest NOC Probe:"
python3 - <<'PY'
import json
from pathlib import Path
p = Path('data/reports/noc-probe/latest.json')
if p.exists():
    d = json.loads(p.read_text())
    print(f"   Status: {d.get('overall')}")
    print(f"   Time: {d.get('timestamp')}")
    print(f"   Counts: {d.get('counts')}")
else:
    print("   ⚠️ No probe data found")
PY

# 5. Health endpoint
echo "5️⃣ Health Endpoint:"
curl -fsS http://localhost:8787/health && echo || echo "⚠️ Endpoint unreachable"

# 6. Recent errors in logs
echo "6️⃣ Recent Errors (last 24h):"
find data/logs -name "*.log" -mtime -1 -exec grep -l "ERROR\|FAIL" {} \; 2>/dev/null | wc -l

echo "✅ Daily check complete"
```

### 5-Minute Cycle Monitoring (Automated)
The NOC timer automatically runs probe every 5 minutes. Monitor output:

```bash
# Watch NOC runner logs in real-time
journalctl --user -u noc-probe-runner.service -f --lines=50

# Watch bot logs for anomalies
journalctl --user -u okx-bot.service -f --lines=50
```

### Weekly (Every Monday 09:00)
```bash
echo "=== Weekly Performance Review ==="

# 1. Uptime check
systemctl --user show okx-bot.service -p ActiveEnterTimestamp

# 2. Memory peak
systemctl --user status okx-bot.service --no-pager | grep "peak"

# 3. Restart count
journalctl --user -u okx-bot.service | grep "Started\|Restarted" | wc -l

# 4. NOC probe summary (7 days)
find data/reports/noc-probe -name "*.json" -mtime -7 | wc -l
echo "snapshots in past 7 days"

# 5. Alert frequency
grep -c "Status changed" data/logs/noc-alert.log 2>/dev/null || echo "0 alerts"
```

## 🚨 Incident Response

### Bot Not Running
```bash
# 1. Check status
systemctl --user status okx-bot.service

# 2. View recent errors
journalctl --user -u okx-bot.service -n 50

# 3. Manual restart
systemctl --user restart okx-bot.service

# 4. Verify health
sleep 5
curl -sS http://localhost:8787/health
```

### NOC Timer Not Triggering
```bash
# 1. Check timer status
systemctl --user status noc-probe-runner.timer

# 2. List next triggers
systemctl --user list-timers

# 3. Manually trigger probe
systemctl --user start noc-probe-runner.service

# 4. Check probe logs
journalctl --user -u noc-probe-runner.service -n 50
```

### High Memory Usage
```bash
# 1. Check memory
systemctl --user status okx-bot.service --no-pager | grep Memory

# 2. If > 500M, restart bot
if [ $(systemctl --user show -p MemoryCurrent okx-bot.service | cut -d= -f2) -gt 500000000 ]; then
  echo "Memory high, restarting..."
  systemctl --user restart okx-bot.service
fi
```

### Telegram Alerts Not Working
```bash
# 1. Check env vars
grep TELEGRAM ~/.env || echo "TELEGRAM vars not set"

# 2. Test Telegram API manually
curl -X POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": ${TELEGRAM_CHAT_ID}, \"text\": \"Test message\"}"
```

## 📈 Metrics to Track

### Daily
- Bot uptime %
- NOC probe last run time
- Health endpoint response time
- Memory usage trend

### Weekly
- Restart count
- Average response time
- Alert frequency
- Error rate

### Monthly
- Total uptime %
- Peak memory usage
- Total probe runs
- Total alerts sent

## 🔍 Log Locations
```
Bot service:        journalctl --user -u okx-bot.service
NOC probe:          journalctl --user -u noc-probe-runner.service
BOT logs:           data/logs/production.log
BOT errors:         data/logs/production-error.log
NOC runner:         data/logs/noc-runner.log
NOC alerts:         data/logs/noc-alert.log
NOC snapshots:      data/reports/noc-probe/*.json
```

## 🎯 SLA Targets
- Bot uptime: 99.5% (target)
- NOC probe success rate: 99%
- Alert delivery: < 30 seconds
- Health check response: < 100ms

## ⚙️ Maintenance Tasks

### Monthly
1. Review and archive old logs (> 30 days)
2. Audit NOC probe snapshots
3. Check disk usage for logs
4. Update systemd units if needed

### Quarterly
1. Load test with increased probe frequency
2. Test failover scenarios
3. Review and update runbook
4. Verify Telegram alerting still works

### Annually
1. Full operational audit
2. Security review of systemd units
3. Performance baseline update
4. Disaster recovery drill

## 📞 Escalation
1. **Minor Issues**: Check logs, restart service
2. **Service Down**: Page on-call engineer
3. **Repeated Failures**: Escalate to platform team
4. **Data Loss**: Activate disaster recovery plan
