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
        server_proc = run_npm_script("dev", env_extra={"UV_THREADPOOL_SIZE": threadpool})
        pids["server_pid"] = server_proc.pid

        if not wait_for_health():
            log("start", "WARNING: server health check failed — continuing anyway")
            log("start", f"check log: {LOG_DIR / 'dev.log'}")
    else:
        pids["server_pid"] = server_pid
        log("start", f"reusing existing server (PID {server_pid})")

    # --- 4. BSC Monitor ---
    if not args.no_bsc:
        bsc_args = []
        if args.once:
            bsc_args.append("--once")

        bsc_proc = run_npm_script("bsc:monitor", extra_args=bsc_args if bsc_args else None)
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
    elif args.command == "start" or args.command is None:
        cmd_start(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
