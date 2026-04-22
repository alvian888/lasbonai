import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";

const execFileAsync = promisify(execFile);

/* ───── Direct BSC RPC balance query (bypass onchainos CLI) ───── */

const BSC_RPC_ENDPOINTS = [
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed2.bnbchain.org",
  "https://bsc-dataseed3.bnbchain.org",
  "https://bsc-dataseed4.bnbchain.org",
];

const ERC20_BALANCE_OF_SELECTOR = "0x70a08231";

async function queryBalanceDirectRpc(
  tokenAddress: string,
  walletAddress: string,
): Promise<{ balance: number; rawBalance: bigint } | null> {
  const paddedWallet = walletAddress.toLowerCase().replace("0x", "").padStart(64, "0");
  const callData = `${ERC20_BALANCE_OF_SELECTOR}${paddedWallet}`;

  for (const rpc of BSC_RPC_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_call",
          params: [{ to: tokenAddress, data: callData }, "latest"],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const json = await response.json() as { result?: string; error?: unknown };
      if (json.result && json.result !== "0x") {
        const rawBalance = BigInt(json.result);
        // Assume 18 decimals for BSC tokens (XPL, USDT-BEP20)
        const balance = Number(rawBalance) / 1e18;
        return { balance, rawBalance };
      }
      return { balance: 0, rawBalance: 0n };
    } catch {
      continue; // Try next RPC endpoint
    }
  }
  return null; // All RPCs failed
}

async function queryTokenPriceFromDex(
  tokenAddress: string,
  chainId: string,
): Promise<number> {
  const usdtAddress = "0x55d398326f99059ff775485246999027b3197955";
  const oneToken = "1000000000000000000"; // 1 token in wei

  // PRIMARY: Use onchainos CLI quote (reliable, bypasses DNS issues)
  try {
    const bin = process.env.ONCHAINOS_BIN || `${os.homedir()}/.local/bin/onchainos`;
    const router = (config.ONCHAINOS_ROUTER_PREFERENCE || "").trim().toLowerCase();
    const baseArgs = [
      "swap", "quote",
      "--from", tokenAddress,
      "--to", usdtAddress,
      "--amount", oneToken,
      "--chain", chainId,
    ];
    const args = (!router || router === "auto") ? baseArgs : [...baseArgs, "--router", router];

    let stdout = "";
    try {
      ({ stdout } = await execFileAsync(bin, args, { maxBuffer: 10 * 1024 * 1024, timeout: 15_000 }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const unsupported = msg.includes("unexpected argument '--router'") || msg.toLowerCase().includes("unknown option '--router'");
      if (!unsupported) throw err;
      ({ stdout } = await execFileAsync(bin, baseArgs, { maxBuffer: 10 * 1024 * 1024, timeout: 15_000 }));
    }

    const result = JSON.parse(stdout) as { data?: Array<{ toTokenAmount?: string }> };
    const outAmount = result.data?.[0]?.toTokenAmount;
    if (outAmount) {
      return Number(outAmount) / 1e18;
    }
  } catch { /* fall through to direct API */ }

  // FALLBACK: Direct OKX DEX API (may fail due to ISP DNS hijacking)
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const url = `https://web3.okx.com/api/v5/dex/aggregator/quote?chainId=${chainId}&fromTokenAddress=${tokenAddress}&toTokenAddress=${usdtAddress}&amount=${oneToken}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const json = await response.json() as { data?: Array<{ toTokenAmount?: string }> };
    const outAmount = json.data?.[0]?.toTokenAmount;
    if (outAmount) {
      return Number(outAmount) / 1e18;
    }
  } catch { /* ignore */ }
  return 0;
}

/* ───── Types ───── */

export interface PositionInfo {
  baseTokenBalance: number;
  baseTokenRawBalance: bigint;
  baseTokenValueUsd: number;
  baseTokenPriceUsd: number;
  quoteTokenBalance: number;
  costBasisUsd: number;
  unrealizedPnlPct: number;
  peakPnlPct: number;
  lastTradeAction: "buy" | "sell" | null;
  lastTradeTimestamp: number;
}

interface TradeState {
  costBasisUsd: number;
  totalSoldUsd: number;
  totalBoughtTokens: number;
  totalSoldTokens: number;
  peakPnlPct: number;
  lastTradeAction: "buy" | "sell" | null;
  lastTradeTimestamp: number;
}

/* ───── Trade state persistence ───── */

const STATE_FILE = path.join(process.cwd(), "data", "trade-state.json");

async function loadTradeState(): Promise<TradeState> {
  try {
    const raw = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {
      costBasisUsd: 0,
      totalSoldUsd: 0,
      totalBoughtTokens: 0,
      totalSoldTokens: 0,
      peakPnlPct: 0,
      lastTradeAction: null,
      lastTradeTimestamp: 0,
    };
  }
}

async function saveTradeState(state: TradeState): Promise<void> {
  await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

export async function recordTrade(
  action: "buy" | "sell",
  amountUsd: number,
  tokenAmount: number,
): Promise<void> {
  const state = await loadTradeState();
  if (action === "buy") {
    state.costBasisUsd += amountUsd;
    state.totalBoughtTokens += tokenAmount;
  } else {
    // Reduce cost basis proportionally to the fraction of holdings sold
    const tokensHeld = state.totalBoughtTokens - state.totalSoldTokens;
    if (tokensHeld > 0) {
      const proportion = Math.min(tokenAmount / tokensHeld, 1);
      state.costBasisUsd = Math.max(0, state.costBasisUsd * (1 - proportion));
    }
    state.totalSoldUsd += amountUsd;
    state.totalSoldTokens += tokenAmount;
    // Reset peak P&L after sell (new position baseline)
    state.peakPnlPct = 0;
  }
  state.lastTradeAction = action;
  state.lastTradeTimestamp = Date.now();
  await saveTradeState(state);
}

/* ───── Balance query: Direct RPC (primary) + onchainos CLI (fallback) ───── */

const BALANCE_CACHE: Map<string, { balance: number; rawBalance: bigint; usdValue: number; priceUsd: number; timestamp: number }> = new Map();
const CACHE_TTL_MS = 15_000;  // 15s cache for faster cycles

async function queryBalance(
  chainId: string,
  tokenAddress: string,
): Promise<{ balance: number; rawBalance: bigint; usdValue: number; priceUsd: number }> {
  const cacheKey = `${chainId}:${tokenAddress}`;
  const cached = BALANCE_CACHE.get(cacheKey);
  
  // Return cached value if still fresh
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return { balance: cached.balance, rawBalance: cached.rawBalance, usdValue: cached.usdValue, priceUsd: cached.priceUsd };
  }

  // Prune stale entries when cache grows to prevent unbounded memory use
  if (BALANCE_CACHE.size > 100) {
    const now = Date.now();
    for (const [k, v] of BALANCE_CACHE) {
      if (now - v.timestamp >= CACHE_TTL_MS * 4) BALANCE_CACHE.delete(k);
    }
  }

  const walletAddress = config.EXECUTION_WALLET_ADDRESS;

  // PRIMARY: Direct BSC RPC call (sub-100ms, no CLI overhead)
  if (walletAddress && chainId === "56") {
    const directResult = await queryBalanceDirectRpc(tokenAddress, walletAddress);
    if (directResult !== null) {
      // Get price estimate
      let priceUsd = 0;
      // USDT is $1
      if (tokenAddress.toLowerCase() === "0x55d398326f99059ff775485246999027b3197955") {
        priceUsd = 1;
      } else if (directResult.balance > 0) {
        priceUsd = await queryTokenPriceFromDex(tokenAddress, chainId);
      }
      const usdValue = directResult.balance * priceUsd;
      BALANCE_CACHE.set(cacheKey, { balance: directResult.balance, rawBalance: directResult.rawBalance, usdValue, priceUsd, timestamp: Date.now() });
      return { balance: directResult.balance, rawBalance: directResult.rawBalance, usdValue, priceUsd };
    }
    console.warn(`[position-tracker] Direct RPC failed for ${tokenAddress}, trying onchainos CLI...`);
  }

  // FALLBACK: onchainos CLI (slow, unreliable RPC)
  const bin = process.env.ONCHAINOS_BIN || `${os.homedir()}/.local/bin/onchainos`;
  
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { stdout } = await execFileAsync(bin, [
        "wallet", "balance",
        "--chain", chainId,
        "--token-address", tokenAddress,
        "--force",
      ], { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });

      const result = JSON.parse(stdout);
      const asset = result?.data?.details?.[0]?.tokenAssets?.[0];
      if (!asset) {
        return { balance: 0, rawBalance: 0n, usdValue: 0, priceUsd: 0 };
      }

      const balance = Number(asset.balance) || 0;
      const usdValue = Number(asset.usdValue) || 0;
      const priceUsd = Number(asset.tokenPrice) || (balance > 0 ? usdValue / balance : 0);
      const rawBalance = BigInt(Math.floor(balance * 1e18));

      BALANCE_CACHE.set(cacheKey, { balance, rawBalance, usdValue, priceUsd, timestamp: Date.now() });
      return { balance, rawBalance, usdValue, priceUsd };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[position-tracker] onchainos query failed (attempt ${attempt + 1}/2): ${msg}`);
      if (attempt < 1) await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  // All methods exhausted: use stale cache if available
  if (cached) {
    console.error(`[position-tracker] All balance methods failed. Using stale cache for ${cacheKey} (${Math.round((Date.now() - cached.timestamp) / 1000)}s old)`);
    return { balance: cached.balance, rawBalance: cached.rawBalance, usdValue: cached.usdValue, priceUsd: cached.priceUsd };
  }

  console.error(`[position-tracker] All balance queries failed for ${tokenAddress}`);
  return { balance: 0, rawBalance: 0n, usdValue: 0, priceUsd: 0 };
}

/* ───── Public API ───── */

export async function getPositionInfo(
  chainId: string,
  baseTokenAddress: string,
  quoteTokenAddress: string,
): Promise<PositionInfo> {
  const isMainPair =
    baseTokenAddress.toLowerCase() === (config.DEFAULT_BASE_TOKEN_ADDRESS || "").toLowerCase();

  const [baseBalance, quoteBalance, tradeState] = await Promise.all([
    queryBalance(chainId, baseTokenAddress),
    queryBalance(chainId, quoteTokenAddress),
    loadTradeState(),
  ]);

  // For non-main pairs (sentiment trades), return position info without touching trade state
  if (!isMainPair) {
    return {
      baseTokenBalance: baseBalance.balance,
      baseTokenRawBalance: baseBalance.rawBalance,
      baseTokenValueUsd: baseBalance.usdValue,
      baseTokenPriceUsd: baseBalance.priceUsd,
      quoteTokenBalance: quoteBalance.balance,
      costBasisUsd: 0,
      unrealizedPnlPct: 0,
      peakPnlPct: 0,
      lastTradeAction: null,
      lastTradeTimestamp: 0,
    };
  }

  const costBasis = tradeState.costBasisUsd;

  // Auto-seed cost basis for pre-existing positions not acquired through the bot
  if (costBasis === 0 && baseBalance.balance > 0 && baseBalance.usdValue > 0) {
    const seededCost = baseBalance.usdValue;
    tradeState.costBasisUsd = seededCost;
    tradeState.totalBoughtTokens = baseBalance.balance;
    await saveTradeState(tradeState);
    console.log(`[position-tracker] Auto-seeded costBasis=$${seededCost.toFixed(2)} for ${baseBalance.balance.toFixed(2)} pre-existing tokens`);
  }

  const effectiveCostBasis = tradeState.costBasisUsd;
  const unrealizedPnlPct = effectiveCostBasis > 0
    ? ((baseBalance.usdValue - effectiveCostBasis) / effectiveCostBasis) * 100
    : 0;

  // Update peak P&L for trailing stop (only when in profit)
  if (unrealizedPnlPct > (tradeState.peakPnlPct ?? 0)) {
    tradeState.peakPnlPct = unrealizedPnlPct;
    await saveTradeState(tradeState);
  }

  return {
    baseTokenBalance: baseBalance.balance,
    baseTokenRawBalance: baseBalance.rawBalance,
    baseTokenValueUsd: baseBalance.usdValue,
    baseTokenPriceUsd: baseBalance.priceUsd,
    quoteTokenBalance: quoteBalance.balance,
    costBasisUsd: effectiveCostBasis,
    unrealizedPnlPct,
    peakPnlPct: tradeState.peakPnlPct ?? 0,
    lastTradeAction: tradeState.lastTradeAction,
    lastTradeTimestamp: tradeState.lastTradeTimestamp,
  };
}
