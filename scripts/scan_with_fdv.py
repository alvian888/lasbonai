import json
import subprocess
import urllib.request

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
    "100000",
    "--liquidity-min",
    "586",
    "--market-cap-min",
    "100000000",
    "--fdv-min",
    "1405622637",
]

raw = subprocess.run(cmd, capture_output=True, text=True, check=True)
data = (json.loads(raw.stdout).get("data") or [])
tokens = sorted(data, key=lambda x: float(x.get("price") or 0))[:10]

rows = []
for idx, token in enumerate(tokens, 1):
    address = token.get("tokenContractAddress")
    fdv = None
    market_cap = None
    try:
        with urllib.request.urlopen(f"https://api.dexscreener.com/latest/dex/tokens/{address}", timeout=20) as r:
            payload = json.load(r)
        pairs = payload.get("pairs") or []
        bsc_pairs = [p for p in pairs if (p.get("chainId") or "").lower() in ("bsc", "bnb")]
        if bsc_pairs:
            best = max(bsc_pairs, key=lambda p: float(((p.get("liquidity") or {}).get("usd") or 0)))
            fdv = best.get("fdv")
            market_cap = best.get("marketCap")
    except Exception:
        pass

    rows.append(
        {
            "rank": idx,
            "symbol": token.get("tokenSymbol"),
            "address": address,
            "price_usd": token.get("price"),
            "holders": token.get("holders"),
            "liquidity_usd": token.get("liquidity"),
            "market_cap_usd_okx": token.get("marketCap"),
            "fdv_usd_dexscreener": fdv,
            "market_cap_usd_dexscreener": market_cap,
        }
    )

print(json.dumps({"count": len(rows), "tokens": rows}, indent=2))
