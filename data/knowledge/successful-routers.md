# Successful DEX Routers & Aggregators

## Verified Working Swaps

### OpenOcean (RECOMMENDED for low-liquidity tokens)
- **Router**: `0x6352a56caadC4F1E25CD6c75970Fa768A3304e64`
- **API**: `https://open-api.openocean.finance/v4/56/swap`
- **Quote API**: `https://open-api.openocean.finance/v4/56/quote`
- **No API key required**
- **Supports**: ERC20→ERC20 (WBNB, USDT, etc.)
- **Approval**: Standard ERC20 approve to router address
- **Execution**: Call router with `data` from swap API response

#### Success Record
| Date | Pair | Amount In | Amount Out | Pool Used |
|------|------|-----------|------------|-----------|
| 2026-04-20 | WBNB → LAWAS | 0.0244700845 WBNB | 528,516.78 LAWAS | PCS Infinity CL via SushiSwap V3 |

---

### 0x Protocol (via OKX Wallet frontend)
- **Router**: `0x0000000000001ff3684f28c67538d4d072c22734` (0x Exchange Proxy)
- **Settlement**: `0xc2eff1f1ce35d395408a34ad881dbcd978f40b89`
- **API**: Requires API key for BSC (not free)
- **Routes through**: PancakeSwap Infinity CL Vault (`0x238a358808379702088667322f80ac48bad5e6c4`)

#### Reference TX
- Hash: `0x13678ca93d61892b0b63ddf8e8afeb873128b47356709c8e6400744954ea5c2f`
- Pair: USDT → LAWAS
- Amount: 1 USDT → 35,398.58 LAWAS
- Function: `multiplexBatchSellTokenForToken` (0x2213bc0b)

---

### OKX DEX Aggregator (Primary for major pairs)
- **Router**: `0x2c34A2Fb1d0b4f55de51E1d0bDEfaDDce6b7cDD6`
- **API**: `https://web3.okx.com/api/v6/dex/aggregator/`
- **Best for**: Major tokens (BTCB, ETH, BNB, USDT)
- **Limitation**: Does NOT index low-liquidity/new tokens

---

### PancakeSwap V2
- **Router**: `0x10ED43C718714eb63d5aA57B78B54704E256024E`
- **Best for**: Tokens with V2 liquidity pools
- **Limitation**: Pair must exist on V2, not V3/Infinity

---

### PancakeSwap V3 SmartRouter (Direct Fallback for BTT)
- **Router**: `0x13f4EA83D0bd40E75C8222255bc855a974568Dd4`
- **Method**: `exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))`
- **Best for**: Direct CL/V3 pool execution when aggregator quote is broken

#### Success Record
| Date | Pair | Amount In | Amount Out | Pool Used |
|------|------|-----------|------------|-----------|
| 2026-04-20 | USDT → BTT | 1 USDT | 3,076,437.961240 BTT | PCS V3 pool `0xe4e695fa53598da586f798a9844a3b03d86f421e` (fee 2500) |
| 2026-04-20 | USDT → BTT | 0.1 USDT | 309,491.861327 BTT | onchainos route (router `0x3156020dff8d99af1ddc523ebdfb1ad2018554a0`) |
| 2026-04-20 | USDT → BTT | 0.1 USDT | 309,150.549878 BTT | onchainos route (tx `0x5447494b9aa2ff29d0eae857d5445e3f174f906b1c61353537832ff871836767`) |

---

### LiFi Router `0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae` ✅ VERIFIED

- **Router**: `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`
- **API**: `https://li.quest/v1/quote` (requires `User-Agent: Mozilla/5.0` header from python urllib)
- **Quote params**: `fromChain`, `toChain`, `fromToken`, `toToken`, `fromAmount`, `fromAddress`, `slippage`
- **Execution**: `onchainos wallet contract-call --to <router> --input-data <tx.data> --gas-limit <gasLimit+50000> --force`
- **Approval**: Standard ERC20 approve to LiFi router before first swap
- **Quote TTL**: Short (~20-30s) — fetch & execute immediately in same script
- **Supports**: Cross-DEX routing on BSC (Kyberswap, Uniswap, etc.)
- **Function selector**: `0x5fd9ae2e`

#### Success Record
| Date | Pair | Amount In | Amount Out | Router Used | TxHash |
|------|------|-----------|------------|-------------|--------|
| 2026-04-20 | IDRX → UNI | 100,000 IDRX | 1.7724899 UNI | LiFi via Kyberswap | `0x334484e97e53241b967aa173e4df783954d904cfe488a5d14bb48565fe4a60a3` |

#### Reference TX (Learned from external wallet)
- Hash: `0xe011793f9456f28f690e33747eba217a580bb1db99871c315201faf8a879de2d`
- From wallet: `0x6cbc6c32d1b4ad211a08d6b3b1849cdbbdb4c0bb`
- Pair: IDRX → UNI (1,000 IDRX → 0.01759 UNI)
- Gas used: 331,223

#### Approve TxHash (IDRX unlimited to LiFi router)
- `0x9d19741c9debf7d0ede3c75024a1fc0fca10f9908e77d9890a0afbf4a7d1d255`

---

### Router `0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae` (Reference Path for BTT)
- **Router**: `0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae`
- **Function selector**: `0x5fd9ae2e`
- **Observed path**: `USDT -> BUSD -> BTT` (multi-hop)

#### Reference TX
- Hash: `0xd39d4fd0ebadb1b38ceab652d597e3b68fd78d223f0b875d565d6090cb472c8c`
- Status: SUCCESS
- From wallet: `0x6cbc6c32d1b4ad211a08d6b3b1849cdbbdb4c0bb`
- Input: `0.1 USDT`
- Output: `308,057.683694439341925523 BTT`
- Effective rate: `3,080,576.8369443934 BTT / USDT`
- Gas used: `340,505`
- Notable transfers:
	- Router fee skim: `0.00003 USDT`
	- BTT internal fee/skim: `306.452278293350012093 BTT`

#### Lesson
- For BTT swaps, successful routes may go through **multi-hop stable path** (`USDT->BUSD->BTT`) instead of direct CL pool only.
- Keep direct PCS V3 fallback active, but retain this tx as alternate routing reference when liquidity is fragmented.
- Some fallback submissions can return a tx hash that is not found on-chain (phantom hash). Always verify broadcast (`eth_getTransactionByHash`) before treating execution as sent.

---

## Failed Routers & Lessons

| Router | Issue | Lesson |
|--------|-------|--------|
| KyberSwap (`0x6131B5fae19EA4f9D964eAc0408E4408b66337b5`) | TRANSFER_FROM_FAILED | Needs approval to **executor** (`0x63242a4ea82847b20e506b63b0e2e2eff0cc6cb0`), not just router |
| SushiSwap API | 404/Down | API endpoints frequently unavailable |
| 0x API (direct) | No Route | Requires paid API key for BSC chain |
| OpenOcean (USDT→BTT) | Input scaling bug (`inAmount` inflated to 1e36) | Detect amount anomaly and fallback to direct PCS V3 route |

---

## Key Pools (LAWAS)
- **PancakeSwap Infinity CL Vault**: `0x238a358808379702088667322f80ac48bad5e6c4`
- **SushiSwap V3 WBNB/LAWAS**: `0x0e87d1a868ecadd9a16aaf8d3c64ed3fdf57792f` (fee=500)
- **Factory (SushiSwap V3 BSC)**: `0x126555dd55a39328f69400d6ae4f782bd4c34abb`

---

## Approval Status (Wallet: 0x29aa2b1b72c888cb20f3c78e2d21ba225481b8a4)

| Token | Spender | Status |
|-------|---------|--------|
| WBNB | OKX DEX (`0x2c34A2Fb...`) | UNLIMITED |
| WBNB | PancakeSwap V2 (`0x10ED43C7...`) | UNLIMITED |
| WBNB | PancakeSwap V3 (`0x13f4EA83...`) | UNLIMITED |
| WBNB | KyberSwap Router (`0x6131B5fa...`) | UNLIMITED |
| WBNB | KyberSwap Executor (`0x63242a4e...`) | UNLIMITED |
| WBNB | OpenOcean (`0x6352a56c...`) | UNLIMITED |
| WBNB | SushiSwap (`0xac4c6e21...`) | UNLIMITED |

---

## Swap Strategy Decision Tree

```
Token swap needed?
├── Major token (BTCB, ETH, BNB, USDT)?
│   └── Use OKX DEX Aggregator (fastest, best rates)
├── Low-liquidity / new token?
│   ├── 1st try: OpenOcean (free API, indexes CL pools)
│   ├── 2nd try: Check if V2 pair exists → PancakeSwap V2 direct
│   └── 3rd try: 0x Protocol (if have API key)
└── If all fail: Check which pool has liquidity on-chain
```
