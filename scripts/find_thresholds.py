import json
import subprocess

holders_candidates = [500000, 450000, 400000, 350000, 300000, 250000, 200000, 150000, 100000]
mc_candidates = [585676099, 500000000, 450000000, 400000000, 350000000, 300000000, 250000000, 200000000, 150000000, 100000000]
liq_min = 586
fdv_min = 1405622637

best = None
for holders_min in holders_candidates:
    for market_cap_min in mc_candidates:
        cmd = [
            "/home/lasbonai/.local/bin/onchainos",
            "token",
            "hot-tokens",
            "--ranking-type",
            "4",
            "--chain",
            "bnb",
            "--rank-by",
            "1",
            "--time-frame",
            "4",
            "--risk-filter",
            "false",
            "--stable-token-filter",
            "false",
            "--holders-min",
            str(holders_min),
            "--liquidity-min",
            str(liq_min),
            "--market-cap-min",
            str(market_cap_min),
            "--fdv-min",
            str(fdv_min),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            continue
        data = json.loads(proc.stdout).get("data") or []
        if len(data) >= 10:
            best = {
                "holders_min": holders_min,
                "market_cap_min": market_cap_min,
                "count": len(data),
            }
            break
    if best:
        break

print(json.dumps({"best": best}, indent=2))
