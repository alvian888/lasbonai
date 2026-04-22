#!/usr/bin/env python3
"""Deep historical ERC20 transfer tracer for a wallet on BSC.

Scans Transfer logs where the wallet appears as sender or recipient across
windowed block ranges, with RPC fallback support and JSON output.
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def normalize_wallet(wallet: str) -> str:
    wallet = wallet.strip().lower()
    if not wallet.startswith("0x") or len(wallet) != 42:
        raise ValueError("wallet must be a 0x-prefixed 40-hex address")
    int(wallet[2:], 16)
    return wallet


def rpc_call(endpoints: list[str], method: str, params: list[Any], timeout: int = 25) -> Any:
    last_error: Exception | None = None
    payload = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for endpoint in endpoints:
        try:
            req = urllib.request.Request(
                endpoint,
                data=payload,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                out = json.loads(resp.read())
            if "error" in out:
                last_error = RuntimeError(f"{endpoint}: {out['error']}")
                continue
            return out.get("result")
        except Exception as exc:
            last_error = exc
    if last_error is None:
        raise RuntimeError("no RPC endpoints configured")
    raise last_error


def count_hits_window(
    endpoints: list[str],
    start_block: int,
    end_block: int,
    wallet_topic: str,
    mode: str,
    fallback_chunk: int,
) -> tuple[int, str]:
    topics = [TRANSFER_TOPIC, wallet_topic] if mode == "from" else [TRANSFER_TOPIC, None, wallet_topic]
    params = [{"fromBlock": hex(start_block), "toBlock": hex(end_block), "topics": topics}]

    try:
        logs = rpc_call(endpoints, "eth_getLogs", params, timeout=45)
        return len(logs), "fast"
    except Exception:
        total = 0
        cursor = start_block
        while cursor <= end_block:
            to_block = min(end_block, cursor + fallback_chunk - 1)
            small_params = [{"fromBlock": hex(cursor), "toBlock": hex(to_block), "topics": topics}]
            try:
                logs = rpc_call(endpoints, "eth_getLogs", small_params, timeout=35)
                total += len(logs)
            except Exception:
                pass
            cursor = to_block + 1
        return total, "fallback"


def main() -> int:
    parser = argparse.ArgumentParser(description="Trace wallet ERC20 transfer history on BSC")
    parser.add_argument("--wallet", required=True, help="Wallet address (0x...) to trace")
    parser.add_argument(
        "--rpc",
        action="append",
        default=[],
        help="RPC endpoint(s); can be repeated. Defaults to 1rpc + bsc-dataseed",
    )
    parser.add_argument(
        "--window",
        type=int,
        default=2_000_000,
        help="Window size in blocks for each scan step (default: 2000000)",
    )
    parser.add_argument(
        "--max-back",
        type=int,
        default=30_000_000,
        help="Total lookback blocks to scan (default: 30000000)",
    )
    parser.add_argument(
        "--fallback-chunk",
        type=int,
        default=200_000,
        help="Chunk size when large eth_getLogs range fails (default: 200000)",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Optional output JSON path. Defaults to data/reports/wallet-trace-<wallet>-<ts>.json",
    )
    args = parser.parse_args()

    wallet = normalize_wallet(args.wallet)
    wallet_topic = "0x" + ("0" * 24) + wallet[2:]
    endpoints = args.rpc or ["https://1rpc.io/bnb", "https://bsc-dataseed.bnbchain.org"]

    latest_hex = rpc_call(endpoints, "eth_blockNumber", [])
    latest = int(latest_hex, 16)
    windows = max(1, args.max_back // args.window)

    started = time.time()
    results: list[dict[str, Any]] = []
    hit_window: dict[str, Any] | None = None

    for idx in range(windows):
        end_block = latest - (idx * args.window)
        start_block = max(1, end_block - args.window + 1)

        out_hits, out_mode = count_hits_window(
            endpoints,
            start_block,
            end_block,
            wallet_topic,
            "from",
            args.fallback_chunk,
        )
        in_hits, in_mode = count_hits_window(
            endpoints,
            start_block,
            end_block,
            wallet_topic,
            "to",
            args.fallback_chunk,
        )
        total = out_hits + in_hits

        window_summary = {
            "index": idx + 1,
            "startBlock": start_block,
            "endBlock": end_block,
            "outHits": out_hits,
            "inHits": in_hits,
            "total": total,
            "modeFrom": out_mode,
            "modeTo": in_mode,
        }
        results.append(window_summary)
        print(
            f"window {idx + 1:02d}: {start_block}-{end_block} "
            f"out={out_hits}({out_mode}) in={in_hits}({in_mode}) total={total}"
        )

        if total > 0 and hit_window is None:
            hit_window = window_summary
            break

    report = {
        "wallet": wallet,
        "rpcEndpoints": endpoints,
        "latestBlock": latest,
        "window": args.window,
        "maxBack": args.max_back,
        "windowsScanned": len(results),
        "hitFound": hit_window is not None,
        "hitWindow": hit_window,
        "results": results,
        "durationSeconds": round(time.time() - started, 2),
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    default_output = Path("data/reports") / f"wallet-trace-{wallet[2:10]}-{ts}.json"
    output_path = Path(args.output) if args.output else default_output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"report: {output_path}")
    if hit_window is None:
        print(f"NO_HITS_IN_LAST {args.max_back} BLOCKS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
