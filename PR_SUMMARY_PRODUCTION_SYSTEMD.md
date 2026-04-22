## Title
Production systemd deployment for OKX bot + NOC probe timer

## Summary
This PR introduces a production-grade user-level systemd deployment flow for the OKX Agentic Bot and stabilizes NOC probe runner behavior so WARN state does not mark the service as failed.

## Changes
- Add installer: `scripts/install-production-systemd.sh`
- Add NOC runner script: `scripts/noc-probe-runner.sh`
- Add systemd unit templates:
  - `scripts/systemd/okx-bot.service`
  - `scripts/systemd/noc-probe-runner.service`
  - `scripts/systemd/noc-probe-runner.timer`
- Stabilize NOC runner exit behavior:
  - Return non-zero only for `FAIL`
  - Return zero for `PASS` and `WARN`

## Why
- Ensure bot persistence via systemd user service
- Ensure NOC probes run every 5 minutes automatically
- Prevent false-negative systemd failures when probe overall status is WARN

## Verification
- `okx-bot.service` is active (running)
- `noc-probe-runner.timer` is active (waiting), triggers every 5 minutes
- `noc-probe-runner.service` finishes with `status=0/SUCCESS` on WARN
- Health endpoint responds: `{"ok":true,"dryRun":false,"model":"lasbonai-trading"}`

## Operations Notes
- Requires user linger enabled (`loginctl enable-linger <user>`) for boot persistence
- Logs:
  - `data/logs/production.log`
  - `data/logs/production-error.log`
  - `data/logs/noc-runner.log`
  - `data/logs/noc-alert.log`

## Rollback
- Stop services:
  - `systemctl --user stop okx-bot.service`
  - `systemctl --user stop noc-probe-runner.timer`
- Disable units if needed:
  - `systemctl --user disable okx-bot.service noc-probe-runner.timer`
