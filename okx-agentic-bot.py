#!/usr/bin/env python3
"""
OKX Agentic Bot — Unified Autostart Launcher
Starts all project services in correct order with health checks and graceful shutdown.

Services managed:
  1. Express API Server      (npm run dev)          — port 8787
  2. BSC Monitor Bot         (npm run bsc:monitor)  — price monitor + Telegram alerts
  3. Cloudflare Tunnel       (cloudflare:tunnel)     — public HTTPS endpoint (optional)

Usage:
   python3 okx-agentic-bot.py                 # start all services
  python3 okx-agentic-bot.py --no-tunnel      # skip cloudflare tunnel
  python3 okx-agentic-bot.py --no-bsc         # skip BSC monitor
  python3 okx-agentic-bot.py --once           # BSC monitor single run then exit
  python3 okx-agentic-bot.py --status         # check status of running services
  python3 okx-agentic-bot.py --stop           # stop all services gracefully
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Optional

PROJECT_DIR = Path(__file__).resolve().parent
LOG_DIR = PROJECT_DIR / "logs"
PID_FILE = PROJECT_DIR / "data" / "autostart.pid.json"
HEALTH_URL = "http://127.0.0.1:8787/health"
HEALTH_TIMEOUT = 30  # seconds
HEALTH_POLL_INTERVAL = 1  # seconds


def log(tag: str, msg: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{ts}] [{tag}] {msg}", flush=True)


def check_health(url: str = HEALTH_URL, timeout_sec: int = 3) -> bool:
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            if resp.status == 200:
                body = json.loads(resp.read())
                return body.get("ok", False)
    except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError):
        pass
    return False


def wait_for_health(url: str = HEALTH_URL, timeout: int = HEALTH_TIMEOUT) -> bool:
    log("health", f"waiting for {url} (max {timeout}s)")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if check_health(url):
            log("health", "service is healthy")
            return True
        time.sleep(HEALTH_POLL_INTERVAL)
    log("health", "timeout — service did not become healthy")
    return False


def is_process_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def save_pids(pids: dict) -> None:
    PID_FILE.parent.mkdir(parents=True, exist_ok=True)
    PID_FILE.write_text(json.dumps(pids, indent=2))


def load_pids() -> dict:
    if PID_FILE.exists():
        try:
            return json.loads(PID_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def clear_pids() -> None:
    if PID_FILE.exists():
        PID_FILE.unlink()


def run_npm_script(script_name: str, extra_args: Optional[list] = None, env_extra: Optional[dict] = None) -> subprocess.Popen:
    """Launch an npm script as a background process with logging."""
    log_file = LOG_DIR / f"{script_name.replace(':', '-')}.log"
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    cmd = ["npm", "run", script_name]
    if extra_args:
        cmd.extend(["--", *extra_args])

    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)

    log_handle = open(log_file, "a")
    proc = subprocess.Popen(
        cmd,
        cwd=str(PROJECT_DIR),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    log("launch", f"{script_name} started (PID {proc.pid}) → log: {log_file}")
    return proc


def run_shell_script(script_path: str, env_extra: Optional[dict] = None) -> subprocess.Popen:
    """Launch a shell script as a background process."""
    name = Path(script_path).stem
    log_file = LOG_DIR / f"{name}.log"
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)

    log_handle = open(log_file, "a")
    proc = subprocess.Popen(
        ["bash", script_path],
        cwd=str(PROJECT_DIR),
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    log("launch", f"{name} started (PID {proc.pid}) → log: {log_file}")
    return proc


# ─── Commands ────────────────────────────────────────────────────────


def cmd_start(args: argparse.Namespace) -> None:
    """Start all services in dependency order."""
    existing = load_pids()
    if existing.get("server_pid") and is_process_alive(existing["server_pid"]):
        if check_health():
            log("start", "server already running and healthy — skipping server launch")
            server_pid = existing["server_pid"]
        else:
            log("start", "stale server process detected — restarting")
            stop_pid(existing["server_pid"])
            server_pid = None
    else:
        server_pid = None

    pids = {}

    # --- 1. Compute profile apply (sync, fast) ---
    log("start", "applying compute profile...")
    try:
        subprocess.run(
            ["npm", "run", "compute:apply"],
            cwd=str(PROJECT_DIR),
            capture_output=True,
            timeout=30,
        )
        log("start", "compute profile applied")
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log("start", f"compute:apply skipped ({e})")

    # --- 2. Integrate local agent (sync, fast) ---
    log("start", "integrating local agent...")
    try:
        subprocess.run(
            ["npm", "run", "integrate:local-agent"],
            cwd=str(PROJECT_DIR),
            capture_output=True,
            timeout=30,
        )
        log("start", "local agent integrated")
    except (subprocess.TimeoutExpired, FileNotFoundError) as e:
        log("start", f"integrate:local-agent skipped ({e})")

    # --- 3. Express API Server ---
    if server_pid is None:
        threadpool = os.environ.get("BOT_UV_THREADPOOL_SIZE", str(os.cpu_count() or 4))
        server_script = os.environ.get("BOT_SERVER_SCRIPT", "start")
        if server_script == "start" and not (PROJECT_DIR / "dist" / "server.js").exists():
            log("start", "dist/server.js not found, falling back to npm run dev")
            server_script = "dev"

        server_proc = run_npm_script(server_script, env_extra={"UV_THREADPOOL_SIZE": threadpool})
        pids["server_pid"] = server_proc.pid

        if not wait_for_health():
            log("start", "WARNING: server health check failed — continuing anyway")
            log("start", f"check log: {LOG_DIR / f'{server_script}.log'}")
    else:
        pids["server_pid"] = server_pid
        log("start", f"reusing existing server (PID {server_pid})")

    # --- 4. BSC Monitor ---
    if not args.no_bsc:
        bsc_args = []
        if args.once:
            bsc_args.append("--once")

        bsc_proc = run_npm_script(
            "bsc:monitor",
            extra_args=bsc_args if bsc_args else None,
            env_extra={"BSC_MONITOR_DISABLE_INTERNAL_FILE_LOG": "1"},
        )
        pids["bsc_monitor_pid"] = bsc_proc.pid
    else:
        log("start", "BSC monitor skipped (--no-bsc)")

    # --- 5. Cloudflare Tunnel ---
    if not args.no_tunnel:
        tunnel_script = PROJECT_DIR / "scripts" / "cloudflare-tunnel-safe-start.sh"
        if tunnel_script.exists():
            tunnel_proc = run_shell_script(str(tunnel_script))
            pids["tunnel_pid"] = tunnel_proc.pid
        else:
            log("start", "cloudflare tunnel script not found — skipped")
    else:
        log("start", "cloudflare tunnel skipped (--no-tunnel)")

    save_pids(pids)

    log("start", "=" * 50)
    log("start", "All services launched successfully")
    log("start", f"  API Server  : http://127.0.0.1:8787  (PID {pids.get('server_pid', 'N/A')})")
    if "bsc_monitor_pid" in pids:
        log("start", f"  BSC Monitor : running               (PID {pids['bsc_monitor_pid']})")
    if "tunnel_pid" in pids:
        log("start", f"  CF Tunnel   : running               (PID {pids['tunnel_pid']})")
    log("start", f"  Logs        : {LOG_DIR}")
    log("start", f"  PID file    : {PID_FILE}")
    log("start", "=" * 50)


def stop_pid(pid: int) -> None:
    """Stop a process by PID, first SIGTERM then SIGKILL."""
    if not is_process_alive(pid):
        return
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
        log("stop", f"sent SIGTERM to process group of PID {pid}")
    except (OSError, ProcessLookupError):
        try:
            os.kill(pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            return

    # Wait up to 5 seconds for graceful shutdown
    for _ in range(10):
        if not is_process_alive(pid):
            return
        time.sleep(0.5)

    # Force kill
    try:
        os.killpg(os.getpgid(pid), signal.SIGKILL)
        log("stop", f"sent SIGKILL to process group of PID {pid}")
    except (OSError, ProcessLookupError):
        try:
            os.kill(pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            pass


def cmd_stop(_args: argparse.Namespace) -> None:
    """Stop all managed services."""
    pids = load_pids()
    if not pids:
        log("stop", "no running services found (PID file empty or missing)")
        return

    for name, pid in pids.items():
        label = name.replace("_pid", "").replace("_", " ")
        if is_process_alive(pid):
            log("stop", f"stopping {label} (PID {pid})...")
            stop_pid(pid)
            log("stop", f"{label} stopped")
        else:
            log("stop", f"{label} (PID {pid}) already stopped")

    clear_pids()
    log("stop", "all services stopped")


def cmd_status(_args: argparse.Namespace) -> None:
    """Show status of all managed services."""
    pids = load_pids()

    log("status", "=" * 50)

    # Server health
    healthy = check_health()
    server_pid = pids.get("server_pid")
    server_alive = server_pid and is_process_alive(server_pid)
    if healthy:
        log("status", f"API Server    : HEALTHY (PID {server_pid})")
    elif server_alive:
        log("status", f"API Server    : RUNNING but NOT HEALTHY (PID {server_pid})")
    else:
        log("status", f"API Server    : STOPPED")

    # BSC Monitor
    bsc_pid = pids.get("bsc_monitor_pid")
    if bsc_pid and is_process_alive(bsc_pid):
        log("status", f"BSC Monitor   : RUNNING (PID {bsc_pid})")
    else:
        log("status", f"BSC Monitor   : STOPPED")

    # Tunnel
    tunnel_pid = pids.get("tunnel_pid")
    if tunnel_pid and is_process_alive(tunnel_pid):
        log("status", f"CF Tunnel     : RUNNING (PID {tunnel_pid})")
    else:
        log("status", f"CF Tunnel     : STOPPED")

    log("status", "=" * 50)

    # Log file sizes
    if LOG_DIR.exists():
        log("status", "Recent logs:")
        for lf in sorted(LOG_DIR.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)[:5]:
            size_kb = lf.stat().st_size / 1024
            mtime = datetime.fromtimestamp(lf.stat().st_mtime).strftime("%H:%M:%S")
            log("status", f"  {lf.name:40s} {size_kb:>8.1f} KB  (modified {mtime})")


def cmd_restart(args: argparse.Namespace) -> None:
    """Stop all services then start them again."""
    log("restart", "stopping all services...")
    cmd_stop(args)
    time.sleep(2)
    log("restart", "starting all services...")
    cmd_start(args)


def cmd_metrics_report(_args: argparse.Namespace) -> None:
    """Show hard-fail metrics report with recovery stats from metrics JSON file."""
    metrics_file = PROJECT_DIR / "data" / "hard-fail-metrics.json"
    if not metrics_file.exists():
        if getattr(_args, "json", False):
            print(json.dumps({"error": "no metrics data yet"}), flush=True)
        else:
            log("metrics", "No metrics data yet (bot not running or no hard-fails recorded)")
        return
    try:
        data = json.loads(metrics_file.read_text())
        metrics = data.get('hardFailMetrics', {})
        blacklist = data.get('blacklistedTokens', [])
        recovered = [t for t, info in metrics.items() if info.get('lastSuccessAt') and info.get('count', 0) > 0 and t not in blacklist]
        failed_tokens = [(t, info) for t, info in sorted(metrics.items()) if info.get('count', 0) > 0]

        if getattr(_args, "json", False):
            out = {
                "exported_at": data.get("exportedAt", "unknown"),
                "cycle": data.get("cycle", None),
                "blacklist_threshold": data.get("blacklistThreshold", None),
                "blacklisted_tokens": blacklist,
                "recovered_tokens": recovered,
                "hard_fail_events": [
                    {
                        "token": t,
                        "count": info.get("count", 0),
                        "error_class": info.get("errorClass", "unknown"),
                        "last_success_at": info.get("lastSuccessAt"),
                        "blacklisted": t in blacklist,
                    }
                    for t, info in failed_tokens
                ],
            }
            print(json.dumps(out), flush=True)
            return

        log("metrics", f"=== Hard-Fail Metrics Report ({data.get('exportedAt', 'unknown')}) ===")
        log("metrics", f"Cycle: {data.get('cycle', '?')}")
        
        # Show hard-fail events
        if not metrics:
            log("metrics", "No hard-fail events recorded this cycle")
        else:
            if failed_tokens:
                log("metrics", f"Hard-fail events: {len(failed_tokens)} token(s)")
                for token, info in failed_tokens:
                    status = "❌ BLACKLISTED" if token in blacklist else "✅ recovered" if info.get('lastSuccessAt') else "⏳ pending"
                    log("metrics", f"  {token}: {info.get('count', 0)} failures ({info.get('errorClass', 'unknown')}) {status}")
        
        # Show blacklist
        if blacklist:
            log("metrics", f"Blacklisted tokens ({len(blacklist)}): {', '.join(blacklist)}")
        else:
            log("metrics", "No tokens currently auto-blacklisted")
        
        # Show recovery stats
        if recovered:
            log("metrics", f"Auto-recovered ({len(recovered)}): {', '.join(recovered)}")
        
        log("metrics", f"Blacklist threshold: {data.get('blacklistThreshold', '?')} hard-fails per cycle")
    except Exception as e:
        log("metrics", f"Error reading metrics: {e}")


def cmd_show_blacklist(_args: argparse.Namespace) -> None:
    """Show currently blacklisted tokens."""
    metrics_file = PROJECT_DIR / "data" / "hard-fail-metrics.json"
    if not metrics_file.exists():
        log("blacklist", "No metrics data yet")
        return
    try:
        data = json.loads(metrics_file.read_text())
        blacklist = data.get('blacklistedTokens', [])
        if blacklist:
            log("blacklist", f"Blacklisted tokens ({len(blacklist)}): {', '.join(blacklist)}")
        else:
            log("blacklist", "No tokens currently blacklisted")
    except Exception as e:
        log("blacklist", f"Error: {e}")


def cmd_reset_blacklist(args: argparse.Namespace) -> None:
    """Reset blacklist for a specific token (manual override)."""
    tokens = args.tokens if hasattr(args, 'tokens') and args.tokens else []
    if not tokens:
        log("blacklist", "Usage: python3 okx-agentic-bot.py reset-blacklist TOKEN [TOKEN2 ...]")
        return
    
    metrics_file = PROJECT_DIR / "data" / "hard-fail-metrics.json"
    if not metrics_file.exists():
        log("blacklist", "No metrics data yet")
        return
    
    try:
        data = json.loads(metrics_file.read_text())
        blacklist = data.get('blacklistedTokens', [])
        
        for token in tokens:
            if token in blacklist:
                blacklist.remove(token)
                log("blacklist", f"Removed {token} from blacklist")
            else:
                log("blacklist", f"{token} not in blacklist")
        
        # Update state file to persist the change (next cycle will reload)
        data['blacklistedTokens'] = blacklist
        metrics_file.write_text(json.dumps(data, indent=2))
        log("blacklist", "Blacklist updated. Changes will be applied on next cycle restart.")
    except Exception as e:
        log("blacklist", f"Error: {e}")


def cmd_health_report(_args: argparse.Namespace) -> None:
    """Show token health scores and risk levels."""
    metrics_file = PROJECT_DIR / "data" / "hard-fail-metrics.json"
    if not metrics_file.exists():
        log("health", "No metrics data yet (bot not running)")
        return
    try:
        data = json.loads(metrics_file.read_text())
        health_scores = data.get('tokenHealth', {})
        
        if not health_scores:
            log("health", "No health data available yet")
            return
        
        # Group by risk level
        by_risk = {"🟢 stable": [], "🟡 at-risk": [], "🔴 high-risk": []}
        for token, info in sorted(health_scores.items(), key=lambda x: x[1]['score'], reverse=True):
            risk = info['riskLevel']
            if risk in by_risk:
                by_risk[risk].append((token, info))

        total = len(health_scores)
        n_stable = len(by_risk["🟢 stable"])
        n_at_risk = len(by_risk["🟡 at-risk"])
        n_high_risk = len(by_risk["🔴 high-risk"])

        if getattr(_args, "json", False):
            out = {
                "exported_at": data.get("exportedAt", "unknown"),
                "total_tokens": total,
                "stable_count": n_stable,
                "at_risk_count": n_at_risk,
                "high_risk_count": n_high_risk,
                "high_risk_tokens": [t for t, _ in by_risk["🔴 high-risk"]],
                "all_tokens": [
                    {
                        "symbol": token,
                        "score": info["score"],
                        "success_rate": info["successRate"],
                        "multiplier": info["multiplier"],
                        "risk_level": info["riskLevel"],
                    }
                    for token, info in sorted(health_scores.items(), key=lambda x: x[1]["score"], reverse=True)
                ],
            }
            print(json.dumps(out), flush=True)
            return

        log("health", f"=== Token Health Report ({data.get('exportedAt', 'unknown')}) ===")

        # Display stable tokens
        if by_risk["🟢 stable"]:
            log("health", f"🟢 Stable ({len(by_risk['🟢 stable'])})")
            for token, info in by_risk["🟢 stable"]:
                log("health", f"  {token}: {info['score']}/100 | Success: {info['successRate']}% | Size: {float(info['multiplier'])*100:.0f}%")

        # Display at-risk tokens
        if by_risk["🟡 at-risk"]:
            log("health", f"🟡 At-Risk ({len(by_risk['🟡 at-risk'])})")
            for token, info in by_risk["🟡 at-risk"]:
                log("health", f"  {token}: {info['score']}/100 | Success: {info['successRate']}% | Size: {float(info['multiplier'])*100:.0f}%")

        # Display high-risk tokens
        if by_risk["🔴 high-risk"]:
            log("health", f"🔴 High-Risk ({len(by_risk['🔴 high-risk'])})")
            for token, info in by_risk["🔴 high-risk"]:
                log("health", f"  {token}: {info['score']}/100 | Success: {info['successRate']}% | Size: {float(info['multiplier'])*100:.0f}%")

        log("health", f"Total: {total} tokens | Stable: {n_stable} | At-Risk: {n_at_risk} | High-Risk: {n_high_risk}")
    except Exception as e:
        log("health", f"Error: {e}")


def cmd_pnl_report(_args: argparse.Namespace) -> None:
    """Show latest PnL status from runtime state + monitor log snapshot."""
    state_file = PROJECT_DIR / "data" / "bsc-monitor-state.json"
    log_file = LOG_DIR / "bsc-monitor.log"

    cycle = "?"
    pending_profit = 0.0
    modal_awal = 0.0
    baseline_reason = "unknown"

    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
            cycle = state.get("cycleCount", "?")
            profit = state.get("profitTracker", {})
            pending_profit = float(profit.get("accumulatedProfitUSDT", 0) or 0)
            baseline = state.get("capitalBaseline", {})
            modal_awal = float(baseline.get("modalAwal", 0) or 0)
            baseline_reason = str(baseline.get("setReason", "unknown"))
        except Exception as e:
            log("pnl", f"Warning: cannot parse state file: {e}")

    latest_total_line = None
    latest_modal_line = None
    if log_file.exists():
        try:
            lines = log_file.read_text(errors="ignore").splitlines()
            for line in reversed(lines[-1200:]):
                if latest_total_line is None and "TOTAL" in line and "cost:" in line:
                    latest_total_line = line.strip()
                if latest_modal_line is None and "Modal:" in line and "P&L:" in line:
                    latest_modal_line = line.strip()
                if latest_total_line and latest_modal_line:
                    break
        except Exception as e:
            log("pnl", f"Warning: cannot parse monitor log: {e}")

    log("pnl", "=== Live PnL Status ===")
    log("pnl", f"Cycle: {cycle}")
    if modal_awal > 0:
        log("pnl", f"Modal baseline (USD): ${modal_awal:.2f} ({baseline_reason})")
    else:
        log("pnl", "Modal baseline: N/A")
    log("pnl", f"Pending profit (USDT): ${pending_profit:.2f}")

    if latest_total_line:
        log("pnl", f"Latest TOTAL: {latest_total_line}")
    else:
        log("pnl", "Latest TOTAL: not found in log yet")

    if latest_modal_line:
        log("pnl", f"Latest Modal/P&L: {latest_modal_line}")
    else:
        log("pnl", "Latest Modal/P&L: not found in log yet")


def _strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", text)


def _extract_between(text: str, start: str, end: str) -> str:
    start_idx = text.find(start)
    if start_idx == -1:
        return ""
    start_idx += len(start)
    end_idx = text.find(end, start_idx)
    if end_idx == -1:
        return text[start_idx:].strip()
    return text[start_idx:end_idx].strip()


def _parse_total_line(line: str) -> dict:
    result = {
        "total_change_pct": "na",
        "total_value_idr": "na",
        "total_cost_idr": "na",
    }
    if not line or "cost:" not in line:
        return result

    clean_line = _strip_ansi(line)
    body = clean_line.replace("TOTAL", "").strip()
    cost_idx = body.find("cost:")
    if cost_idx == -1:
        return result

    left = body[:cost_idx].strip()
    right = body[cost_idx + len("cost:"):].strip()
    left_parts = left.split()
    if len(left_parts) >= 2:
        result["total_change_pct"] = left_parts[0]
        result["total_value_idr"] = left_parts[-1]
    result["total_cost_idr"] = right
    return result


def _parse_modal_line(line: str) -> dict:
    result = {
        "modal_idr": "na",
        "pnl_pct": "na",
        "target_pct": "na",
        "target_progress_pct": "na",
    }
    if not line:
        return result

    result["modal_idr"] = _extract_between(line, "Modal:", "|") or "na"
    result["pnl_pct"] = _extract_between(line, "P&L:", "|") or "na"
    result["target_pct"] = _extract_between(line, "Target:", "[") or "na"
    progress = _extract_between(line, "]", "║") or _extract_between(line, "]", "|")
    result["target_progress_pct"] = progress or "na"
    return result


def cmd_pnl_brief(_args: argparse.Namespace) -> None:
    """Show a one-line compact PnL status for shell scripts and quick checks."""
    state_file = PROJECT_DIR / "data" / "bsc-monitor-state.json"
    log_file = LOG_DIR / "bsc-monitor.log"

    cycle = "?"
    pending_profit = 0.0
    if state_file.exists():
        try:
            state = json.loads(state_file.read_text())
            cycle = state.get("cycleCount", "?")
            profit = state.get("profitTracker", {})
            pending_profit = float(profit.get("accumulatedProfitUSDT", 0) or 0)
        except Exception:
            pass

    latest_total_line = "TOTAL unavailable"
    latest_modal_line = "Modal/P&L unavailable"
    if log_file.exists():
        try:
            lines = log_file.read_text(errors="ignore").splitlines()
            for line in reversed(lines[-1200:]):
                if latest_total_line == "TOTAL unavailable" and "TOTAL" in line and "cost:" in line:
                    latest_total_line = line.strip()
                if latest_modal_line == "Modal/P&L unavailable" and "Modal:" in line and "P&L:" in line:
                    latest_modal_line = line.strip()
                if latest_total_line != "TOTAL unavailable" and latest_modal_line != "Modal/P&L unavailable":
                    break
        except Exception:
            pass

    total_fields = _parse_total_line(latest_total_line)
    modal_fields = _parse_modal_line(latest_modal_line)

    data = {
        "cycle": cycle,
        "pending_usdt": round(pending_profit, 2),
        "total_change_pct": total_fields["total_change_pct"],
        "total_value_idr": total_fields["total_value_idr"],
        "total_cost_idr": total_fields["total_cost_idr"],
        "modal_idr": modal_fields["modal_idr"],
        "pnl_pct": modal_fields["pnl_pct"],
        "target_pct": modal_fields["target_pct"],
        "target_progress_pct": modal_fields["target_progress_pct"],
    }

    if getattr(_args, "json", False):
        clean = {k: _strip_ansi(str(v)) if isinstance(v, str) else v for k, v in data.items()}
        print(json.dumps(clean), flush=True)
    else:
        print(
            " | ".join(f"{k}={_strip_ansi(str(v))}" for k, v in data.items()),
            flush=True,
        )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="OKX Agentic Bot — Unified Autostart Launcher",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command")

    # Default (no subcommand) = start
    start_p = sub.add_parser("start", help="Start all services")
    start_p.add_argument("--no-tunnel", action="store_true", help="Skip Cloudflare tunnel")
    start_p.add_argument("--no-bsc", action="store_true", help="Skip BSC monitor")
    start_p.add_argument("--once", action="store_true", help="BSC monitor runs once then exits")

    sub.add_parser("stop", help="Stop all managed services")
    sub.add_parser("status", help="Show service status")

    restart_p = sub.add_parser("restart", help="Restart all services")
    restart_p.add_argument("--no-tunnel", action="store_true", help="Skip Cloudflare tunnel")
    restart_p.add_argument("--no-bsc", action="store_true", help="Skip BSC monitor")
    restart_p.add_argument("--once", action="store_true", help="BSC monitor runs once then exits")

    # Admin metrics commands
    metrics_p = sub.add_parser("metrics-report", help="Show hard-fail metrics report")
    metrics_p.add_argument("--json", action="store_true", help="Output as JSON")
    health_p = sub.add_parser("health-report", help="Show token health scores and risk levels")
    health_p.add_argument("--json", action="store_true", help="Output as JSON")
    sub.add_parser("pnl-report", help="Show live PnL status snapshot")
    pnl_brief_p = sub.add_parser("pnl-brief", help="Show one-line compact PnL status")
    pnl_brief_p.add_argument("--json", action="store_true", help="Output as JSON")
    sub.add_parser("show-blacklist", help="Show blacklisted tokens")
    reset_bl_p = sub.add_parser("reset-blacklist", help="Remove token from blacklist")
    reset_bl_p.add_argument("tokens", nargs="*", help="Token symbol(s) to remove from blacklist")

    # Support flat flags (no subcommand = start)
    parser.add_argument("--no-tunnel", action="store_true", help="Skip Cloudflare tunnel")
    parser.add_argument("--no-bsc", action="store_true", help="Skip BSC monitor")
    parser.add_argument("--once", action="store_true", help="BSC monitor runs once then exits")
    parser.add_argument("--status", action="store_true", help="Shortcut for 'status' command")
    parser.add_argument("--stop", action="store_true", help="Shortcut for 'stop' command")
    parser.add_argument("--restart", action="store_true", help="Shortcut for 'restart' command")

    args = parser.parse_args()

    # Handle flat flag shortcuts
    if args.status:
        cmd_status(args)
    elif args.stop:
        cmd_stop(args)
    elif args.restart:
        cmd_restart(args)
    elif args.command == "stop":
        cmd_stop(args)
    elif args.command == "status":
        cmd_status(args)
    elif args.command == "restart":
        cmd_restart(args)
    elif args.command == "metrics-report":
        cmd_metrics_report(args)
    elif args.command == "health-report":
        cmd_health_report(args)
    elif args.command == "pnl-report":
        cmd_pnl_report(args)
    elif args.command == "pnl-brief":
        cmd_pnl_brief(args)
    elif args.command == "show-blacklist":
        cmd_show_blacklist(args)
    elif args.command == "reset-blacklist":
        cmd_reset_blacklist(args)
    elif args.command == "start" or args.command is None:
        cmd_start(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
