#!/usr/bin/env python3
"""
LI.FI Swap Executor — Manual approval, one token at a time
Usage: python3 scripts/lifi-swap.py --token <symbol> --contract <addr>
"""
import sys, json, subprocess, urllib.request, time, argparse

WALLET   = "0x29aa2b1b72c888cb20f3c78e2d21ba225481b8a4"
USDT     = "0x55d398326f99059fF775485246999027B3197955"
LIFI     = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"
ONCHAINOS= "/home/lasbonai/.local/bin/onchainos"
AMOUNT   = "500000000000000000"  # 0.5 USDT in wei
RPC      = "https://bsc-dataseed.bnbchain.org"

def rpc_call(method, params):
    data = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode()
    req  = urllib.request.Request(RPC, data=data, headers={"Content-Type":"application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=10).read())

def get_lifi_quote(to_token):
    url = (
        f"https://li.quest/v1/quote"
        f"?fromChain=56&toChain=56"
        f"&fromToken={USDT}&toToken={to_token}"
        f"&fromAmount={AMOUNT}&fromAddress={WALLET}"
        f"&slippage=0.01"
    )
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    })
    r   = json.loads(urllib.request.urlopen(req, timeout=15).read())
    return r

def wei_to_human(amount_str, decimals):
    try:
        return int(amount_str) / (10 ** decimals)
    except:
        return 0

def execute_swap(tx_req, gas_limit_override=None):
    to_addr  = tx_req["to"]
    calldata = tx_req["data"]
    value    = int(tx_req.get("value","0x0"), 16)
    gas      = gas_limit_override or str(int(tx_req.get("gasLimit","0x80000"), 16))

    cmd = [
        ONCHAINOS, "wallet", "contract-call",
        "--to",         to_addr,
        "--chain",      "56",
        "--input-data", calldata,
        "--gas-limit",  str(gas),
        "--amt",        str(value),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    try:
        return json.loads(result.stdout)
    except:
        return {"ok": False, "error": result.stdout + result.stderr}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--token",    required=True, help="Token symbol e.g. BTCB")
    parser.add_argument("--contract", required=True, help="Token contract address")
    parser.add_argument("--decimals", type=int, default=18, help="Token decimals (default 18)")
    args = parser.parse_args()

    print(f"\n{'='*55}")
    print(f"  LI.FI SWAP  →  0.5 USDT  →  {args.token}")
    print(f"  Contract: {args.contract}")
    print(f"{'='*55}")

    print("⏳ Fetching LI.FI quote...")
    try:
        quote = get_lifi_quote(args.contract)
    except Exception as e:
        print(f"❌ Quote failed: {e}")
        sys.exit(1)

    if "transactionRequest" not in quote:
        print(f"❌ No transactionRequest in response: {json.dumps(quote)[:300]}")
        sys.exit(1)

    tx_req   = quote["transactionRequest"]
    estimate = quote.get("estimate", {})
    tool     = quote.get("toolDetails", {}).get("name", quote.get("tool","?"))

    to_amount     = estimate.get("toAmount", "0")
    to_amount_min = estimate.get("toAmountMin", "0")
    duration_s    = estimate.get("executionDuration", 0)
    gas_limit     = int(tx_req.get("gasLimit","0x80000"), 16)
    gas_price_wei = int(tx_req.get("gasPrice","0x2faf080"), 16)
    gas_cost_bnb  = gas_limit * gas_price_wei / 1e18
    fee_usd       = float(estimate.get("feeCosts", [{}])[0].get("amountUSD", "0")) if estimate.get("feeCosts") else 0

    out_human     = wei_to_human(to_amount, args.decimals)
    out_min_human = wei_to_human(to_amount_min, args.decimals)

    print(f"\n  Router  : {tx_req.get('to')}")
    print(f"  DEX via : {tool}")
    print(f"  Output  : {out_human:.8f} {args.token}")
    print(f"  Min out : {out_min_human:.8f} {args.token}  (1% slippage)")
    print(f"  Rate    : {out_human/0.5:.6f} {args.token}/USDT")
    print(f"  Gas est : {gas_limit:,} units  ({gas_cost_bnb*1e9/1e9:.6f} BNB)")
    print(f"  LI.FI fee: ${fee_usd:.4f}")
    print(f"  Duration: {duration_s}s")
    print()

    ans = input("  [A]pprove / [S]kip / [St]op  → ").strip().lower()
    if ans == "stop" or ans == "st":
        print("🛑 Stopped.")
        sys.exit(0)
    if ans != "a" and ans != "approve":
        print("⏭  Skipped.")
        sys.exit(2)

    print("⚡ Executing swap NOW...")
    t0     = time.time()
    result = execute_swap(tx_req, gas_limit_override=gas_limit + 50000)
    elapsed= time.time() - t0

    if result.get("ok"):
        tx_hash = result.get("data", {}).get("txHash", "?")
        print(f"\n✅ SUCCESS  ({elapsed:.1f}s)")
        print(f"   TX: {tx_hash}")
        print(f"   BSCScan: https://bscscan.com/tx/{tx_hash}")
    else:
        print(f"\n❌ FAILED: {json.dumps(result)[:400]}")
        sys.exit(1)

if __name__ == "__main__":
    main()
