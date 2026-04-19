import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/* ───── Types ───── */

export interface PositionInfo {
  baseTokenBalance: number;
  baseTokenValueUsd: number;
  baseTokenPriceUsd: number;
  quoteTokenBalance: number;
  costBasisUsd: number;
  unrealizedPnlPct: number;
  lastTradeAction: "buy" | "sell" | null;
  lastTradeTimestamp: number;
}

interface TradeState {
  costBasisUsd: number;
  totalSoldUsd: number;
  totalBoughtTokens: number;
  totalSoldTokens: number;
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
  }
  state.lastTradeAction = action;
  state.lastTradeTimestamp = Date.now();
  await saveTradeState(state);
}

/* ───── Balance query via onchainos CLI ───── */

async function queryBalance(
  chainId: string,
  tokenAddress: string,
): Promise<{ balance: number; usdValue: number; priceUsd: number }> {
  const bin = process.env.ONCHAINOS_BIN || `${os.homedir()}/.local/bin/onchainos`;
  try {
    const { stdout } = await execFileAsync(bin, [
      "wallet", "balance",
      "--chain", chainId,
      "--token-address", tokenAddress,
      "--force",
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });

    const result = JSON.parse(stdout);
    const asset = result?.data?.details?.[0]?.tokenAssets?.[0];
    if (!asset) return { balance: 0, usdValue: 0, priceUsd: 0 };

    const balance = Number(asset.balance) || 0;
    const usdValue = Number(asset.usdValue) || 0;
    const priceUsd = Number(asset.tokenPrice) || (balance > 0 ? usdValue / balance : 0);

    return { balance, usdValue, priceUsd };
  } catch (err) {
    console.error(`[position-tracker] balance query failed: ${err instanceof Error ? err.message : err}`);
    return { balance: 0, usdValue: 0, priceUsd: 0 };
  }
}

/* ───── Public API ───── */

export async function getPositionInfo(
  chainId: string,
  baseTokenAddress: string,
  quoteTokenAddress: string,
): Promise<PositionInfo> {
  const [baseBalance, quoteBalance, tradeState] = await Promise.all([
    queryBalance(chainId, baseTokenAddress),
    queryBalance(chainId, quoteTokenAddress),
    loadTradeState(),
  ]);

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

  return {
    baseTokenBalance: baseBalance.balance,
    baseTokenValueUsd: baseBalance.usdValue,
    baseTokenPriceUsd: baseBalance.priceUsd,
    quoteTokenBalance: quoteBalance.balance,
    costBasisUsd: effectiveCostBasis,
    unrealizedPnlPct,
    lastTradeAction: tradeState.lastTradeAction,
    lastTradeTimestamp: tradeState.lastTradeTimestamp,
  };
}
