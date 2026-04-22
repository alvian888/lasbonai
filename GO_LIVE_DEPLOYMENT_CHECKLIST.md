# Production Go-Live Deployment Checklist

## 🎯 Pre-Deployment Phase (48 hours before)

### Code & Configuration Review
- [ ] PR reviewed and approved by at least 2 engineers
- [ ] All CI/CD checks passing
- [ ] No breaking changes detected
- [ ] Documentation complete and reviewed

### Environment Preparation
- [ ] Staging environment mirror of production ready
- [ ] Backup strategy verified (.env, config files)
- [ ] Rollback plan documented
- [ ] Communication plan to stakeholders confirmed

### Testing Completed
- [ ] Unit tests passing
- [ ] Integration tests in staging passing
- [ ] Manual smoke tests done
- [ ] Performance baseline established
- [ ] Failure scenarios tested

## 🔧 Deployment Phase (Go-Live Day)

### Pre-Deployment (06:00 WIB)
- [ ] All stakeholders notified
- [ ] Monitoring dashboards ready
- [ ] Backup of current `.env` taken
- [ ] Runbook reviewed with team
- [ ] Communication channels open (Telegram, Slack)

### Deployment Steps (06:30 WIB)
1. **Stop current bot process**
   ```bash
   pkill -f "tsx src/server.ts" || true
   sleep 3
   ```

2. **Enable linger for persistence**
   ```bash
   loginctl enable-linger $USER
   ```

3. **Run installer**
   ```bash
   cd /path/to/okx-agentic-bot
   ./scripts/install-production-systemd.sh
   ```
   - [ ] Installer completed without errors
   - [ ] Systemd units installed to ~/.config/systemd/user/

4. **Verify systemd units**
   ```bash
   systemctl --user daemon-reload
   systemctl --user status okx-bot.service
   systemctl --user status noc-probe-runner.timer
   ```
   - [ ] Both units loaded successfully
   - [ ] No error messages

5. **Start services**
   ```bash
   systemctl --user start okx-bot.service
   systemctl --user start noc-probe-runner.timer
   ```
   - [ ] Services started without errors

6. **Health checks (07:00 WIB)**
   ```bash
   # Check bot is running
   curl -sS http://localhost:8787/health
   # Expected: {"ok":true,"dryRun":false,"model":"lasbonai-trading"}
   
   # Check systemd status
   systemctl --user status okx-bot.service
   # Expected: active (running)
   
   # Check timer
   systemctl --user status noc-probe-runner.timer
   # Expected: active (waiting)
   ```
   - [ ] Health endpoint responding
   - [ ] Bot service active
   - [ ] Timer active and scheduled
   - [ ] No errors in logs

7. **Wait for first NOC probe** (07:05 WIB)
   ```bash
   journalctl --user -u noc-probe-runner.service -n 20
   ```
   - [ ] Probe completed successfully
   - [ ] Status recorded in latest.json

### Validation Phase (07:15 - 08:00 WIB)
- [ ] Bot trading activity normal
- [ ] Health checks passing every 5 min
- [ ] Telegram alerts working (test if status changes)
- [ ] No ERROR/FAIL in logs
- [ ] Memory usage stable (< 200M)
- [ ] CPU usage normal (< 50%)

### Post-Deployment (08:00 WIB)
- [ ] Stakeholder notification sent (deployment successful)
- [ ] Monitoring dashboard updated
- [ ] On-call engineer assigned
- [ ] Daily health check scheduled
- [ ] Documentation updated

## ✅ Post-Go-Live Monitoring (First 24 Hours)

### Hour 1 (08:00 - 09:00)
- [ ] Check every 15 min: service status
- [ ] Monitor: bot logs for errors
- [ ] Validate: NOC probes running every 5 min
- [ ] Alert: on Telegram if issues found

### Hours 2-6 (09:00 - 14:00)
- [ ] Check every 30 min: health endpoint
- [ ] Monitor: memory usage trend
- [ ] Review: alert log for any issues
- [ ] Validate: trading activity

### Hours 6-24 (14:00 - 08:00 next day)
- [ ] Check every 1 hour: service status
- [ ] Monitor: logs for anomalies
- [ ] Track: uptime percentage
- [ ] Alert: on critical errors

## 🛑 Rollback Plan (If Issues Found)

### Immediate Rollback (< 1 minute)
```bash
# Stop systemd services
systemctl --user stop okx-bot.service
systemctl --user stop noc-probe-runner.timer

# Kill any remaining processes
pkill -f "npm run dev" || true
pkill -f "tsx src/server.ts" || true
```

### Full Rollback (if needed)
```bash
# Remove systemd units
systemctl --user disable okx-bot.service
systemctl --user disable noc-probe-runner.timer

rm ~/.config/systemd/user/okx-bot.service
rm ~/.config/systemd/user/noc-probe-runner.service
rm ~/.config/systemd/user/noc-probe-runner.timer

systemctl --user daemon-reload

# Restart bot manually (old way)
cd /path/to/okx-agentic-bot
npm run dev 2>&1 &
```

### Documented Issues & Decisions
- [ ] Issue description: _____________
- [ ] Root cause: _____________
- [ ] Decision: Continue / Rollback
- [ ] Reasoning: _____________
- [ ] Escalation: _____________

## 📊 Go-Live Sign-Off

**Deployment Lead**: _________________ **Date**: _________

**Technical Review**: _________________ **Date**: _________

**Operations Lead**: _________________ **Date**: _________

**Business Owner**: _________________ **Date**: _________

## 📝 Post-Deployment Report

**Deployment Status**: ☐ Success ☐ Partial ☐ Failed

**Start Time**: _________ **End Time**: _________

**Issues Encountered**: 
- [ ] None
- [ ] Minor (resolved)
- [ ] Major (escalated)

**Details**: _______________________________

**Lessons Learned**: _______________________________

**Follow-up Actions**: _______________________________

**Next Review**: _________ (schedule weekly for first month)
