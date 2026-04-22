# Production Operations Manual

## 📘 Table of Contents
1. [Daily Operations](#daily-operations)
2. [Service Management](#service-management)
3. [Troubleshooting](#troubleshooting)
4. [Emergency Procedures](#emergency-procedures)
5. [Performance Tuning](#performance-tuning)

## Daily Operations

### Morning Startup (09:00 WIB)

**Automated**: Services should start automatically via systemd user linger.

**Manual Verification**:
```bash
# 1. Login as user if needed
sudo -u lasbonai bash

# 2. Check service status
systemctl --user is-active okx-bot.service
# Expected: active

# 3. Check timer
systemctl --user is-active noc-probe-runner.timer
# Expected: active

# 4. Health check
curl -sS http://localhost:8787/health
# Expected: {"ok":true,...}
```

### Continuous Monitoring (Every 5 minutes automated)

NOC probe runs every 5 minutes automatically. Check status:
```bash
tail -f /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/noc-runner.log
```

Expected output:
```
[noc-runner] status=PASS prev=PASS alert=false snapshot=...
```

### End of Day (18:00 WIB)

**Automated**: Services continue running 24/7.

**Manual Checks**:
```bash
# 1. Check daily stats
journalctl --user -u okx-bot.service --since today | grep -i error | wc -l
# Should be low/zero

# 2. Check memory usage
systemctl --user status okx-bot.service --no-pager | grep Memory

# 3. Backup logs if needed
tar -czf /backups/logs-$(date +%Y%m%d).tar.gz \
  /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/
```

## Service Management

### Starting Services
```bash
# Start bot service
systemctl --user start okx-bot.service

# Start probe timer
systemctl --user start noc-probe-runner.timer

# Start both
systemctl --user start okx-bot.service noc-probe-runner.timer
```

### Stopping Services
```bash
# Stop bot service (graceful)
systemctl --user stop okx-bot.service

# Stop probe timer
systemctl --user stop noc-probe-runner.timer

# Force stop (if necessary)
systemctl --user kill -s SIGKILL okx-bot.service
```

### Restarting Services
```bash
# Restart bot service
systemctl --user restart okx-bot.service

# Restart with delay
systemctl --user restart okx-bot.service
sleep 5
systemctl --user status okx-bot.service

# Emergency restart
systemctl --user stop okx-bot.service
sleep 3
systemctl --user start okx-bot.service
```

### Checking Service Status
```bash
# Full status
systemctl --user status okx-bot.service -l

# Brief status
systemctl --user is-active okx-bot.service

# Timeline
journalctl --user -u okx-bot.service --no-pager | tail -20

# Real-time logs
journalctl --user -u okx-bot.service -f
```

## Troubleshooting

### Issue: Bot Service Not Running

**Symptoms**: Health check fails, no response on port 8787

**Diagnosis**:
```bash
systemctl --user status okx-bot.service
journalctl --user -u okx-bot.service -n 50
```

**Solutions**:
```bash
# 1. Check if process exists
ps aux | grep "npm run dev"

# 2. Check port availability
netstat -tlnp | grep 8787

# 3. Check .env file
ls -la /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/.env

# 4. Restart service
systemctl --user restart okx-bot.service

# 5. Manual start for testing
cd /home/lasbonai/Desktop/lasbonai/okx-agentic-bot
npm run dev
```

### Issue: NOC Probe Not Running

**Symptoms**: Timer active but no probe output, alerts not sent

**Diagnosis**:
```bash
systemctl --user status noc-probe-runner.timer
systemctl --user list-timers | grep noc
journalctl --user -u noc-probe-runner.service -n 50
```

**Solutions**:
```bash
# 1. Manually trigger probe
systemctl --user start noc-probe-runner.service

# 2. Check probe output
cat /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/noc-runner.log | tail -20

# 3. Restart timer
systemctl --user restart noc-probe-runner.timer

# 4. Check if it runs next time
sleep 60 && systemctl --user status noc-probe-runner.service
```

### Issue: High Memory Usage (> 300M)

**Symptoms**: Memory keeps growing, bot slows down

**Diagnosis**:
```bash
systemctl --user status okx-bot.service --no-pager | grep Memory
ps aux | grep "npm run dev"
```

**Solutions**:
```bash
# 1. Graceful restart
systemctl --user restart okx-bot.service

# 2. Check for memory leaks in logs
grep -i "memory\|leak" /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/production.log

# 3. Monitor for recurrence
watch -n 5 'systemctl --user status okx-bot.service --no-pager | grep Memory'

# 4. If persists, escalate for code review
```

### Issue: Telegram Alerts Not Working

**Symptoms**: Status changes but no Telegram message

**Diagnosis**:
```bash
# 1. Check env vars
grep TELEGRAM /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/.env

# 2. Check alert log
tail -20 /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/logs/noc-alert.log

# 3. Test curl to Telegram API
curl -X POST https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage \
  -H "Content-Type: application/json" \
  -d "{\"chat_id\": ${TELEGRAM_CHAT_ID}, \"text\": \"Test message\"}"
```

**Solutions**:
```bash
# 1. Verify credentials in .env
vi /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/.env
# Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID

# 2. Restart NOC service to reload env
systemctl --user restart noc-probe-runner.service

# 3. Manually trigger alert
systemctl --user start noc-probe-runner.service
```

## Emergency Procedures

### Complete System Failure

**Step 1: Assess Damage**
```bash
# Check all services
systemctl --user status okx-bot.service
systemctl --user status noc-probe-runner.timer

# Check logs for errors
journalctl --user -u okx-bot.service -p err

# Check disk space
df -h /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/
```

**Step 2: Immediate Mitigation**
```bash
# Stop everything
systemctl --user stop okx-bot.service noc-probe-runner.timer

# Clear any stuck processes
pkill -f "npm run dev" || true
pkill -f "tsx src/server.ts" || true

# Wait for cleanup
sleep 5
```

**Step 3: Recovery**
```bash
# Restore from backup if corrupted
# (specific to your backup location)

# Restart services
systemctl --user start okx-bot.service
systemctl --user start noc-probe-runner.timer

# Verify recovery
sleep 10
curl -sS http://localhost:8787/health
```

### Data Loss Recovery

**If Latest Probe Data Lost**:
```bash
# Check backup snapshots
ls -ltr /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/reports/noc-probe/

# Restore if available
cp /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/reports/noc-probe/noc-probe-*.json \
   /home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/reports/noc-probe/latest.json

# Re-run probe
systemctl --user start noc-probe-runner.service
```

## Performance Tuning

### Optimize Memory Usage
```bash
# 1. Monitor current usage
watch -n 5 'systemctl --user status okx-bot.service --no-pager | grep Memory'

# 2. If consistently high (> 400M):
# - Review code for memory leaks
# - Increase Node.js heap limit (if needed):
export NODE_OPTIONS="--max-old-space-size=512"
systemctl --user restart okx-bot.service

# 3. Monitor again
```

### Optimize Probe Frequency
```bash
# If 5-minute probe is too frequent:
# Edit timer file:
vi ~/.config/systemd/user/noc-probe-runner.timer

# Change OnBootSec and OnUnitActiveSec to desired interval
# Example: OnUnitActiveSec=10min

# Reload and restart
systemctl --user daemon-reload
systemctl --user restart noc-probe-runner.timer
```

### Performance Baseline
```bash
# Establish baseline metrics
systemctl --user show okx-bot.service -p MemoryCurrent,CPUUsageNSec,ActiveEnterTimestamp

# Store for comparison
echo "Baseline: $(date)" >> /tmp/perf-baseline.txt
systemctl --user show okx-bot.service -p MemoryCurrent >> /tmp/perf-baseline.txt
```

---

**Last Updated**: 2026-04-22  
**Version**: 1.0  
**Maintained By**: Operations Team  
**Emergency Contact**: On-call engineer (Telegram: @Epensakti)
