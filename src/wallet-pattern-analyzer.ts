/**
 * WalletPatternAnalyzer — BSC On-Chain Trading Pattern Intelligence
 *
 * Discovers wallets that achieved >15% PnL on high-liquidity BSC token pairs
 * by decoding PancakeSwap V2 Swap events via BSC RPC eth_getLogs.
 *
 * Output (WalletPatternSignal) is injected into the AI agent's market context
 * to improve entry/exit timing decisions.
 */

import { writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

// ---------- Tracer-report integration ----------
interface TracerReport {
  wallet: string;
  hitFound: boolean;
  windowsScanned: number;
  maxBack: number;
  latestBlock: number;
  hitWindow: null | { start: number; end: number };
}

let _tracerReportCache: TracerReport | null | "not-loaded" = "not-loaded";

async function loadTracerReport(walletAddr: string): Promise<TracerReport | null> {
  if (_tracerReportCache !== "not-loaded") return _tracerReportCache;
  try {
    const dir = "data/reports";
    const prefix = `wallet-trace-${walletAddr.toLowerCase().replace("0x", "").slice(0, 8)}`;
    const files = existsSync(dir)
      ? (await readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort((a, b) => a.localeCompare(b))
      : [];
    if (files.length === 0) { _tracerReportCache = null; return null; }
    const latest = files.at(-1) as string;
    const raw = JSON.parse(await readFile(join(dir, latest), "utf8")) as TracerReport;
    _tracerReportCache = raw;
    return raw;
  } catch {
    _tracerReportCache = null;
    return null;
  }
}
// -----------------------------------------------

const DEFAULT_RPC_ENDPOINTS = [
  "https://1rpc.io/bnb",
  "https://bsc-dataseed.bnbchain.org",
  "https://bsc-dataseed2.bnbchain.org",
  "https://bsc-dataseed3.bnbchain.org",
];

const WALLET_PATTERN_RPC_ENDPOINTS = (
  config.WALLET_PATTERN_RPC_URLS || DEFAULT_RPC_ENDPOINTS.join(",")
)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const TRACKED_WALLET = (config.WALLET_PATTERN_TRACK_WALLET || "").trim().toLowerCase();
// Eagerly warm the cache at module load so first contextSummary is annotated
if (TRACKED_WALLET) void loadTracerReport(TRACKED_WALLET);

// PancakeSwap V2 Swap event topic
// Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)
const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

const CACHE_FILE = "data/wallet-patterns.json";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — refresh every 30 min
const CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours — serve stale until this age

// Known DEX router / aggregator addresses to exclude from wallet analysis
// These appear as `to` in swap events but are not real trader wallets
const KNOWN_AGGREGATORS = new Set([
  "0x10ed43c718714eb63d5aa57b78b54704e256024e", // PancakeSwap V2 Router
  "0x13f4ea83d0bd40e75c8222255bc855a974568dd4", // PancakeSwap V3 SmartRouter
  "0x05ff2b0db69458a0750badebc4f9e13add608c7f", // PancakeSwap V1 Router
  "0x1111111254eeb25477b68fb85ed929f73a960582", // 1inch V5
  "0x1111111254fb6c44bac0bed2854e76f90643097d", // 1inch V4
  "0xdef1c0ded9bec7f1a1670819833240f027b25eff", // 0x Exchange Proxy
  "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae", // LiFi Diamond
  "0x2c8d0af2a5c47b5e9aab4e22c2a0b14c47f4d814", // OKX DEX proxy
  "0x0000000000000000000000000000000000000000", // null address
]);

// Filter out wallets that trade too frequently (likely bots/aggregators)
const MAX_TRADES_PER_WALLET = 40;

// Minimum USD volume per swap to filter dust/noise
const MIN_SWAP_USD = 50;

export interface WalletPatternSignal {
  scannedAt: number;
  windowBlocks: number;
  totalSwaps: number;
  profitableWallets: number;
  avgPnlPct: number;
  avgHoldMinutes: number;
  marketBias: "bullish" | "bearish" | "neutral";
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  buyCount: number;
  sellCount: number;
  topWalletSummary: string;
  contextSummary: string;
}

interface RawSwapLog {
  blockNumber: string;
  transactionHash: string;
  topics: string[];
  data: string;
}

interface DecodedSwap {
  blockNumber: number;
  txHash: string;
  wallet: string;
  type: "buy" | "sell";
  baseAmountRaw: bigint;
  quoteAmountRaw: bigint;
  impliedPriceUsd: number;
  quoteUsd: number;
}

interface WalletSession {
  wallet: string;
  buys: DecodedSwap[];
  sells: DecodedSwap[];
  avgBuyPrice: number;
  avgSellPrice: number;
  pnlPct: number;
  holdBlocks: number;
}

// ─── BSC RPC ───────────────────────────────────────────────────────────────
async function rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let lastError = "Unknown RPC failure";

  for (const rpc of WALLET_PATTERN_RPC_ENDPOINTS) {
    try {
      const resp = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      const json = (await resp.json()) as { result?: T; error?: { message?: string } };
      if (json.error?.message) {
        lastError = `${rpc}: ${json.error.message}`;
        continue;
      }
      if (json.result === undefined) {
        lastError = `${rpc}: empty result`;
        continue;
      }
      return json.result;
    } catch (err) {
      lastError = `${rpc}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  throw new Error(`RPC error: ${lastError}`);
}

async function getLatestBlock(): Promise<number> {
  const hex = await rpcCall<string>("eth_blockNumber", []);
  return parseInt(hex, 16);
}

/** Call token0() on pair to determine ordering */
async function getPairToken0(pairAddress: string): Promise<string> {
  const result = await rpcCall<string>("eth_call", [
    { to: pairAddress, data: "0x0dfe1681" }, // token0()
    "latest",
  ]);
  return "0x" + result.slice(-40).toLowerCase();
}

// ─── DexScreener ──────────────────────────────────────────────────────────
interface DexPairInfo {
  pairAddress: string;
  priceUsd: number;
  liquidityUsd: number;
  token0IsBase: boolean;
}

const USDT_BSC = "0x55d398326f99059ff775485246999027b3197955";

async function hasV2SwapEvents(pairAddress: string, latestBlock: number, checkBlocks = 2000): Promise<boolean> {
  try {
    // Check last 500 blocks first (fast probe)
    const fromBlock = Math.max(0, latestBlock - 500);
    const logs = await rpcCall<RawSwapLog[]>("eth_getLogs", [
      {
        address: pairAddress,
        topics: [SWAP_TOPIC],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + latestBlock.toString(16),
      },
    ]);
    if (Array.isArray(logs) && logs.length > 0) return true;
    // Try wider window if fast probe returned nothing
    const fromBlock2 = Math.max(0, latestBlock - checkBlocks);
    const logs2 = await rpcCall<RawSwapLog[]>("eth_getLogs", [
      {
        address: pairAddress,
        topics: [SWAP_TOPIC],
        fromBlock: "0x" + fromBlock2.toString(16),
        toBlock: "0x" + fromBlock.toString(16),
      },
    ]);
    return Array.isArray(logs2) && logs2.length > 0;
  } catch {
    return false;
  }
}

async function fetchDexScreenerTopPair(tokenAddress: string): Promise<DexPairInfo | null> {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "okx-agentic-bot/1.0" },
      signal: AbortSignal.timeout(12_000),
    });
    const data = (await resp.json()) as {
      pairs?: Array<{
        chainId: string;
        pairAddress: string;
        priceUsd: string;
        liquidity?: { usd?: number };
        dexId: string;
        baseToken: { address: string };
        quoteToken?: { address?: string };
      }>;
    };

    const pairs = (data.pairs ?? [])
      .filter((p) => p.chainId === "bsc" && (p.dexId === "pancakeswap" || p.dexId === "pancakeswap-v2"))
      .filter((p) => {
        const base = p.baseToken?.address?.toLowerCase() ?? "";
        const quote = p.quoteToken?.address?.toLowerCase() ?? "";
        const token = tokenAddress.toLowerCase();
        return (base === token && quote === USDT_BSC) || (base === USDT_BSC && quote === token);
      })
      .filter((p) => (p.liquidity?.usd ?? 0) >= 100_000)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    if (!pairs.length) return null;

    // Get current block once for all probes
    let latestBlock = 0;
    try {
      const blockHex = await rpcCall<string>("eth_blockNumber", []);
      latestBlock = parseInt(blockHex, 16);
    } catch {
      // can't probe — fall through to pick top by liquidity
    }

    // Find first pair that actually has V2 swap events
    let selectedPair = pairs[0];
    if (latestBlock > 0) {
      const probeCandidates = pairs.slice(0, Math.min(pairs.length, 20));
      for (const candidate of probeCandidates) {
        const addr = candidate.pairAddress.toLowerCase();
        const hasSwaps = await hasV2SwapEvents(addr, latestBlock);
        if (hasSwaps) {
          selectedPair = candidate;
          break;
        }
      }
    }

    const pair = selectedPair;
    const liquidityUsd = pair.liquidity?.usd ?? 0;

    const pairAddress = pair.pairAddress.toLowerCase();

    // Determine token0 order via on-chain call
    let token0IsBase: boolean;
    try {
      const token0 = await getPairToken0(pairAddress);
      token0IsBase = token0 === tokenAddress.toLowerCase();
    } catch {
      // fallback: compare addresses numerically (lower = token0)
      token0IsBase = tokenAddress.toLowerCase() < "0x55d398326f99059ff775485246999027b3197955";
    }

    return {
      pairAddress,
      priceUsd: parseFloat(pair.priceUsd) || 0,
      liquidityUsd,
      token0IsBase,
    };
  } catch {
    return null;
  }
}

// ─── Log fetching ─────────────────────────────────────────────────────────
async function fetchSwapLogs(pairAddress: string, fromBlock: number, toBlock: number): Promise<RawSwapLog[]> {
  try {
    const logs = await rpcCall<RawSwapLog[]>("eth_getLogs", [
      {
        address: pairAddress,
        topics: [SWAP_TOPIC],
        fromBlock: "0x" + fromBlock.toString(16),
        toBlock: "0x" + toBlock.toString(16),
      },
    ]);
    return Array.isArray(logs) ? logs : [];
  } catch {
    return [];
  }
}

async function fetchSwapLogsChunked(
  pairAddress: string,
  fromBlock: number,
  toBlock: number,
  chunkSize = 500,
  maxEvents = 1200
): Promise<RawSwapLog[]> {
  const all: RawSwapLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    const chunk = await fetchSwapLogs(pairAddress, start, end);
    all.push(...chunk);
    if (all.length >= maxEvents) break;
  }
  return all.slice(0, maxEvents);
}

// ─── Decoding ─────────────────────────────────────────────────────────────
function hexToAddress(topicHex: string): string {
  return ("0x" + topicHex.slice(-40)).toLowerCase();
}

function decodeSwapLog(log: RawSwapLog, token0IsBase: boolean): DecodedSwap | null {
  try {
    if (log.topics.length < 3) return null;

    const toAddr = hexToAddress(log.topics[2]);
    if (KNOWN_AGGREGATORS.has(toAddr)) return null;

    const rawData = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
    if (rawData.length < 256) return null; // 4 × 64 hex chars needed

    const amount0In = BigInt("0x" + rawData.slice(0, 64));
    const amount1In = BigInt("0x" + rawData.slice(64, 128));
    const amount0Out = BigInt("0x" + rawData.slice(128, 192));
    const amount1Out = BigInt("0x" + rawData.slice(192, 256));

    // Map to base/quote based on token0 ordering
    // base = BTCB, quote = USDT (18 decimals each)
    let baseIn: bigint, quoteIn: bigint, baseOut: bigint, quoteOut: bigint;
    if (token0IsBase) {
      baseIn = amount0In; quoteIn = amount1In;
      baseOut = amount0Out; quoteOut = amount1Out;
    } else {
      baseIn = amount1In; quoteIn = amount0In;
      baseOut = amount1Out; quoteOut = amount0Out;
    }

    let type: "buy" | "sell";
    let baseAmount: bigint;
    let quoteAmount: bigint;

    if (quoteIn > 0n && baseOut > 0n) {
      // Sent quote (USDT), received base (BTCB) → BUY
      type = "buy";
      baseAmount = baseOut;
      quoteAmount = quoteIn;
    } else if (baseIn > 0n && quoteOut > 0n) {
      // Sent base (BTCB), received quote (USDT) → SELL
      type = "sell";
      baseAmount = baseIn;
      quoteAmount = quoteOut;
    } else {
      return null; // flash swap or zero amounts
    }

    if (baseAmount === 0n) return null;

    const baseF = Number(baseAmount) / 1e18;
    const quoteF = Number(quoteAmount) / 1e18;
    const impliedPrice = baseF > 0 ? quoteF / baseF : 0;

    if (quoteF < MIN_SWAP_USD) return null; // skip dust swaps

    return {
      blockNumber: parseInt(log.blockNumber, 16),
      txHash: log.transactionHash,
      wallet: toAddr,
      type,
      baseAmountRaw: baseAmount,
      quoteAmountRaw: quoteAmount,
      impliedPriceUsd: impliedPrice,
      quoteUsd: quoteF,
    };
  } catch {
    return null;
  }
}

// ─── Session building ─────────────────────────────────────────────────────
function buildWalletSessions(swaps: DecodedSwap[], minPnlPct: number): WalletSession[] {
  const byWallet = new Map<string, DecodedSwap[]>();
  for (const swap of swaps) {
    const arr = byWallet.get(swap.wallet) ?? [];
    arr.push(swap);
    byWallet.set(swap.wallet, arr);
  }

  const sessions: WalletSession[] = [];
  for (const [wallet, trades] of byWallet) {
    if (trades.length > MAX_TRADES_PER_WALLET) continue; // likely bot
    if (trades.length < 2) continue;

    const buys = trades.filter((t) => t.type === "buy");
    const sells = trades.filter((t) => t.type === "sell");
    if (buys.length === 0 || sells.length === 0) continue;

    const avgBuyPrice = buys.reduce((s, t) => s + t.impliedPriceUsd, 0) / buys.length;
    const avgSellPrice = sells.reduce((s, t) => s + t.impliedPriceUsd, 0) / sells.length;
    if (avgBuyPrice <= 0) continue;

    const pnlPct = ((avgSellPrice - avgBuyPrice) / avgBuyPrice) * 100;
    if (pnlPct < minPnlPct) continue;

    const minBuyBlock = Math.min(...buys.map((b) => b.blockNumber));
    const maxSellBlock = Math.max(...sells.map((s) => s.blockNumber));

    sessions.push({
      wallet,
      buys,
      sells,
      avgBuyPrice,
      avgSellPrice,
      pnlPct,
      holdBlocks: Math.max(0, maxSellBlock - minBuyBlock),
    });
  }

  return sessions.sort((a, b) => b.pnlPct - a.pnlPct);
}

// ─── Signal builder ───────────────────────────────────────────────────────
function buildSignal(params: {
  swaps: DecodedSwap[];
  sessions: WalletSession[];
  windowBlocks: number;
  minPnlPct: number;
}): WalletPatternSignal {
  const { swaps, sessions, windowBlocks } = params;

  const buys = swaps.filter((s) => s.type === "buy");
  const sells = swaps.filter((s) => s.type === "sell");
  const buyVolumeUsd = buys.reduce((s, t) => s + t.quoteUsd, 0);
  const sellVolumeUsd = sells.reduce((s, t) => s + t.quoteUsd, 0);

  const totalVolume = buyVolumeUsd + sellVolumeUsd;
  const buyRatio = totalVolume > 0 ? buyVolumeUsd / totalVolume : 0.5;
  let marketBias: "bullish" | "bearish" | "neutral" = "neutral";
  if (buyRatio > 0.58) marketBias = "bullish";
  else if (buyRatio < 0.42) marketBias = "bearish";

  const avgPnlPct = sessions.length > 0
    ? sessions.reduce((s, w) => s + w.pnlPct, 0) / sessions.length
    : 0;

  // BSC block time ~3 seconds
  const avgHoldMinutes = sessions.length > 0
    ? (sessions.reduce((s, w) => s + w.holdBlocks, 0) / sessions.length * 3) / 60
    : 0;

  const windowMinutes = Math.round((windowBlocks * 3) / 60);

  // Top wallets summary
  const top3 = sessions.slice(0, 3);
  const topWalletSummary = top3.length > 0
    ? top3.map((w) =>
        `${w.wallet.slice(0, 10)}.. PnL=+${w.pnlPct.toFixed(1)}% ` +
        `(buy@$${w.avgBuyPrice.toFixed(1)} sell@$${w.avgSellPrice.toFixed(1)} hold=${Math.round(w.holdBlocks * 3 / 60)}min)`
      ).join("; ")
    : "none";

  // Build context summary for AI injection
  const parts: string[] = [];
  parts.push(`[OnChainIntel ${new Date().toISOString().slice(0, 16)}Z]`);
  parts.push(`Window: last ${windowBlocks} blocks (~${windowMinutes}min), ${swaps.length} swaps decoded`);
  parts.push(`Market bias: ${marketBias.toUpperCase()} | Buy vol $${buyVolumeUsd.toFixed(0)} | Sell vol $${sellVolumeUsd.toFixed(0)} | Buy ratio ${(buyRatio * 100).toFixed(0)}%`);

  if (sessions.length > 0) {
    parts.push(`Profitable wallets (>15% PnL): ${sessions.length} found | Avg PnL: +${avgPnlPct.toFixed(1)}% | Avg hold: ${avgHoldMinutes.toFixed(0)}min`);
    parts.push(`Top performers: ${topWalletSummary}`);
    if (marketBias === "bullish") {
      parts.push("Signal: Smart money showing profitable longs — consider buy bias.");
    } else if (marketBias === "bearish") {
      parts.push("Signal: Smart money exiting — consider sell bias or reduce exposure.");
    }
  } else {
    parts.push("No wallets with >15% PnL found in this window — market ranging or insufficient data.");
  }

  if (TRACKED_WALLET && /^0x[a-f0-9]{40}$/i.test(TRACKED_WALLET)) {
    const trackedTrades = swaps.filter((swap) => swap.wallet === TRACKED_WALLET);
    if (trackedTrades.length === 0) {
      const report = _tracerReportCache && _tracerReportCache !== "not-loaded" ? _tracerReportCache : null;
      if (report && !report.hitFound) {
        parts.push(
          `Tracked wallet ${TRACKED_WALLET.slice(0, 10)}.. HISTORICALLY_INACTIVE` +
          ` (0 ERC20 transfers in last ${(report.maxBack / 1_000_000).toFixed(0)}M blocks / ~${(report.maxBack * 3 / 86400 / 365).toFixed(1)}yr BSC history).` +
          ` Ignore wallet-copy signal bias for this token.`
        );
      } else if (report?.hitFound) {
        parts.push(
          `Tracked wallet ${TRACKED_WALLET.slice(0, 10)}.. active in history` +
          ` (hitWindow blk ${report.hitWindow?.start ?? "?"} – ${report.hitWindow?.end ?? "?"})` +
          ` but no swaps decoded in this window.`
        );
      } else {
        parts.push(`Tracked wallet ${TRACKED_WALLET.slice(0, 10)}.. has no decoded swaps in this window.`);
      }
    } else {
      const trackedBuys = trackedTrades.filter((swap) => swap.type === "buy");
      const trackedSells = trackedTrades.filter((swap) => swap.type === "sell");
      const avgTrackedBuy = trackedBuys.length > 0
        ? trackedBuys.reduce((sum, swap) => sum + swap.impliedPriceUsd, 0) / trackedBuys.length
        : 0;
      const avgTrackedSell = trackedSells.length > 0
        ? trackedSells.reduce((sum, swap) => sum + swap.impliedPriceUsd, 0) / trackedSells.length
        : 0;
      const trackedPnlPct = avgTrackedBuy > 0 && avgTrackedSell > 0
        ? ((avgTrackedSell - avgTrackedBuy) / avgTrackedBuy) * 100
        : 0;
      parts.push(
        `Tracked wallet ${TRACKED_WALLET.slice(0, 10)}.. swaps=${trackedTrades.length} ` +
        `buys=${trackedBuys.length} sells=${trackedSells.length} estPnL=${trackedPnlPct >= 0 ? "+" : ""}${trackedPnlPct.toFixed(1)}%`
      );
    }
  }

  return {
    scannedAt: Date.now(),
    windowBlocks,
    totalSwaps: swaps.length,
    profitableWallets: sessions.length,
    avgPnlPct,
    avgHoldMinutes,
    marketBias,
    buyVolumeUsd,
    sellVolumeUsd,
    buyCount: buys.length,
    sellCount: sells.length,
    topWalletSummary,
    contextSummary: parts.join(" | "),
  };
}

function buildFallbackSignal(reason: string): WalletPatternSignal {
  return {
    scannedAt: Date.now(),
    windowBlocks: 0,
    totalSwaps: 0,
    profitableWallets: 0,
    avgPnlPct: 0,
    avgHoldMinutes: 0,
    marketBias: "neutral",
    buyVolumeUsd: 0,
    sellVolumeUsd: 0,
    buyCount: 0,
    sellCount: 0,
    topWalletSummary: "n/a",
    contextSummary: `[OnChainIntel] Unavailable: ${reason}`,
  };
}

// ─── Cache helpers ────────────────────────────────────────────────────────
async function saveCache(signal: WalletPatternSignal): Promise<void> {
  try {
    await writeFile(CACHE_FILE, JSON.stringify(signal, null, 2), "utf-8");
  } catch {
    // non-fatal
  }
}

async function readCache(): Promise<WalletPatternSignal | null> {
  if (!existsSync(CACHE_FILE)) return null;
  try {
    const raw = await readFile(CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw) as WalletPatternSignal;
    return typeof parsed.scannedAt === "number" ? parsed : null;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Run a full on-chain wallet pattern analysis scan.
 * Fetches PancakeSwap V2 Swap events, decodes them, identifies profitable
 * wallets (PnL > minPnlPct), and caches the result.
 *
 * @param baseTokenAddress  BSC ERC20 address of the base token to analyze (e.g. BTCB)
 * @param minPnlPct         Minimum PnL % threshold for "profitable" wallets (default: 15)
 * @param lookbackBlocks    Number of recent blocks to scan (default: 2000 ≈ 100 min)
 */
export async function analyzeWalletPatterns(
  baseTokenAddress: string,
  minPnlPct = 15,
  lookbackBlocks = 2000
): Promise<WalletPatternSignal> {
  console.log(`[wallet-pattern] Starting scan: token=${baseTokenAddress.slice(0, 10)}.. lookback=${lookbackBlocks} blocks minPnl=${minPnlPct}%`);
  const start = Date.now();

  // Check fresh cache
  const cached = await readCache();
  if (cached && Date.now() - cached.scannedAt < CACHE_TTL_MS) {
    console.log(`[wallet-pattern] Returning fresh cache (age=${Math.round((Date.now() - cached.scannedAt) / 60000)}min)`);
    return cached;
  }

  try {
    // 1. Find the top PancakeSwap pair for this token
    const pairInfo = await fetchDexScreenerTopPair(baseTokenAddress);
    if (!pairInfo) {
      const fb = buildFallbackSignal("No high-liquidity PancakeSwap pair found on DexScreener");
      await saveCache(fb);
      return fb;
    }
    console.log(`[wallet-pattern] Pair: ${pairInfo.pairAddress} liq=$${pairInfo.liquidityUsd.toFixed(0)} price=$${pairInfo.priceUsd} token0IsBase=${pairInfo.token0IsBase}`);

    // 2. Get current block and compute range
    const latestBlock = await getLatestBlock();
    const fromBlock = latestBlock - lookbackBlocks;

    // 3. Fetch Swap event logs in chunks
    const rawLogs = await fetchSwapLogsChunked(pairInfo.pairAddress, fromBlock, latestBlock);
    console.log(`[wallet-pattern] Fetched ${rawLogs.length} raw swap logs`);

    // 4. Decode logs into typed swaps
    const decodedSwaps = rawLogs
      .map((log) => decodeSwapLog(log, pairInfo.token0IsBase))
      .filter((s): s is DecodedSwap => s !== null);
    console.log(`[wallet-pattern] Decoded ${decodedSwaps.length} valid swaps`);

    // 5. Build wallet sessions and filter profitable ones
    const profitableSessions = buildWalletSessions(decodedSwaps, minPnlPct);
    console.log(`[wallet-pattern] Found ${profitableSessions.length} wallets with >${minPnlPct}% PnL`);

    // 6. Build and cache signal
    const signal = buildSignal({
      swaps: decodedSwaps,
      sessions: profitableSessions,
      windowBlocks: lookbackBlocks,
      minPnlPct,
    });

    await saveCache(signal);
    console.log(`[wallet-pattern] Analysis complete in ${Date.now() - start}ms | marketBias=${signal.marketBias} profitable=${signal.profitableWallets}`);
    return signal;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[wallet-pattern] Analysis failed: ${message}`);
    const fb = buildFallbackSignal(message.slice(0, 120));
    await saveCache(fb);
    return fb;
  }
}

/**
 * Get the last cached wallet pattern signal without running a new scan.
 * Returns null if no cache exists or cache is too old (>2h).
 */
export async function getWalletPatternSignal(): Promise<WalletPatternSignal | null> {
  const cached = await readCache();
  if (!cached) return null;
  if (Date.now() - cached.scannedAt > CACHE_MAX_AGE_MS) return null;
  return cached;
}
