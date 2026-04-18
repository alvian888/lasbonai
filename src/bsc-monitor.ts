/**
 * LasbonBSCbot — BSC Token Price Monitor & Alert Bot
 * Monitors: AXL, DOGE, TKO, XPL, LAWAS, SAPI, BNB
 * 
 * Features:
 * - Real-time price tracking via onchainos CLI
 * - P&L calculation from entry prices
 * - Buy/Sell zone alerts via Telegram
 * - Configurable intervals and thresholds
 * - Console dashboard with color-coded status
 * 
 * Usage: npx tsx src/bsc-monitor.ts [--interval 60] [--no-telegram]
 */

import { execSync, exec as execCb } from "child_process";
import { promisify } from "util";
const execAsync = promisify(execCb);
async function execWithTimeout(cmd: string, timeoutMs = 8000): Promise<string> {
  try {
    const { stdout } = await Promise.race([
      execAsync(cmd),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("cmd_timeout")), timeoutMs)),
    ]);
    return stdout;
  } catch (e: any) {
    if (e.message === "cmd_timeout") return "";
    if (e.stdout) return e.stdout; // CLI exited non-zero but has JSON output
    return "";
  }
}
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, appendFileSync } from "fs";
import { config, hasTelegramConfig } from "./config.js";
import mysql from "mysql2/promise";

// ─── Token Configuration ───────────────────────────────────────────
interface TokenConfig {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  holdings: number;       // current token balance
  entryPrice: number;     // USD price when we bought
  entryCost: number;      // USD spent to buy
  buyZone: number;        // buy alert below this price
  sellTarget: number;     // sell alert above this price (+10%)
  stopLoss: number;       // stop-loss alert below this price (-5%)
  sellTarget1: number;    // partial sell at +3%
  sellTarget2: number;    // partial sell at +7%
  sellTarget3: number;    // final sell at +12%
  trailingStopPct: number; // trailing stop-loss % from peak (e.g. 4 = -4%)
  autoExecute: boolean;   // enable auto-swap on stop-loss/sell
  category: "swing" | "hold" | "moonshot" | "stablecoin" | "seed";
}

// Trailing stop state per token
interface TrailingState {
  peakPrice: number;      // highest price since entry
  trailingStop: number;   // dynamic stop = peak × (1 - trailingPct/100)
  sold1: boolean;         // already sold at target1
  sold2: boolean;         // already sold at target2
  sold3: boolean;         // already sold at target3
}

let trailingStates: Record<string, TrailingState> = {};

// USDT address for selling tokens to
const USDT_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";
const WALLET_ADDRESS = "0x29aa2b1b72c888cb20f3c78e2d21ba225481b8a4";

// ─── PancakeSwap deep-link helper ─────────────────────────────────
function pancakeUrl(inputAddress: string, outputAddress: string): string {
  const inp = inputAddress === "native" ? "BNB" : inputAddress;
  const out = outputAddress === "native" ? "BNB" : outputAddress;
  return `https://pancakeswap.finance/swap?chain=bsc&inputCurrency=${inp}&outputCurrency=${out}`;
}

// ─── OKX DEX deep-link helper ─────────────────────────────────────
function okxSwapUrl(inputAddress: string, outputAddress: string): string {
  const inp = inputAddress === "native" ? "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" : inputAddress;
  const out = outputAddress === "native" ? "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" : outputAddress;
  return `https://web3.okx.com/dex-swap#inputChain=56&inputCurrency=${inp}&outputCurrency=${out}`;
}
const PROFIT_WALLET = "0x6cbc6c32d1b4ad211a08d6b3b1849cdbbdb4c0bb"; // Weekly profit withdrawal target

// Profit tracker for weekly withdrawals
interface ProfitTracker {
  accumulatedProfitUSDT: number;  // USDT profit from sells, pending withdrawal
  totalWithdrawn: number;         // lifetime USDT sent to profit wallet
  lastWithdrawalTime: number;     // unix ms of last withdrawal
  withdrawalHistory: { date: string; amount: number; txHash: string }[];
}

let profitTracker: ProfitTracker = {
  accumulatedProfitUSDT: 0,
  totalWithdrawn: 0,
  lastWithdrawalTime: Date.now(),
  withdrawalHistory: [],
};

// Modal Awal (Initial Capital Baseline)
// Reset setiap: (1) setelah profit withdrawal, (2) setiap hari Senin
interface CapitalBaseline {
  modalAwal: number;        // total portfolio value USD saat baseline di-set
  setAt: number;            // unix ms kapan baseline di-set
  setReason: string;        // "withdrawal" | "monday-reset" | "initial"
  lastMondayReset: string;  // YYYY-MM-DD tanggal Senin terakhir reset
}

let capitalBaseline: CapitalBaseline = {
  modalAwal: 0,
  setAt: Date.now(),
  setReason: "initial",
  lastMondayReset: "",
};

// ─── Seed Swap State (zero-balance tokens >1 day → auto buy 1 USDT) ──
interface SeedSwapEntry {
  zeroBalanceSince: number;   // unix ms when balance first seen as 0
  swapExecutedAt?: number;    // unix ms when seed swap was executed (one-shot)
}
let seedSwapState: Record<string, SeedSwapEntry> = {};
const SEED_SWAP_DELAY_MS = 24 * 60 * 60 * 1000; // 1 day
const SEED_SWAP_AMOUNT_USDT = 1;

const TOKENS: TokenConfig[] = [
  // ─── DUST / NEAR-ZERO TOKENS ─────────────────────────────────────
  {
    symbol: "AXL",
    name: "Axelar",
    address: "0x8b1f4432f943c465a973fedc6d7aa50fc96f1f65",
    decimals: 6,
    holdings: 0.00052,
    entryPrice: 0.04913,
    entryCost: 0,
    buyZone: 0.05610,          // -5% from current
    sellTarget: 0.09946,       // +50%
    stopLoss: 0.05434,         // -8% from entry
    sellTarget1: 0.07631,      // +15%
    sellTarget2: 0.08624,      // +30%
    sellTarget3: 0.09946,      // +50%
    trailingStopPct: 8,
    autoExecute: true,
    category: "moonshot",
  },

  // ─── SWING TOKENS (active trading, +15% T1) ─────────────────────
  {
    symbol: "DOGE",
    name: "Dogecoin",
    address: "0xba2ae424d960c26247dd6c32edc70b295c744c43",
    decimals: 8,
    holdings: 10.3116,         // on-chain: 10.31157
    entryPrice: 0.09700,       // weighted avg from 1 USDT swap
    entryCost: 1.00,
    buyZone: 0.09215,          // -5% from entry
    sellTarget: 0.13580,       // +40%
    stopLoss: 0.08924,         // -8% from entry
    sellTarget1: 0.11155,      // +15%
    sellTarget2: 0.12125,      // +25%
    sellTarget3: 0.13580,      // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },
  {
    symbol: "TKO",
    name: "Tokocrypto",
    address: "0x9f589e3eabe42ebc94a44727b3f3531c0c877809",
    decimals: 18,
    holdings: 308.38,          // on-chain: 308.382
    entryPrice: 0.06141,
    entryCost: 18.94,
    buyZone: 0.05834,          // -5% from entry
    sellTarget: 0.07983,       // +30%
    stopLoss: 0.05650,         // -8% from entry
    sellTarget1: 0.07062,      // +15% (close! currently +12.3%)
    sellTarget2: 0.07369,      // +20%
    sellTarget3: 0.07983,      // +30%
    trailingStopPct: 6,
    autoExecute: true,
    category: "hold",
  },
  {
    symbol: "XPL",
    name: "Plasma",
    address: "0x405fbc9004d857903bfd6b3357792d71a50726b0",
    decimals: 18,
    holdings: 49.108,          // on-chain: 49.108 (partial sold from 119.04)
    entryPrice: 0.12631,
    entryCost: 6.20,           // proportional: 49.108/119.04 × 15.04
    buyZone: 0.12000,          // -5% from entry
    sellTarget: 0.17683,       // +40%
    stopLoss: 0.11621,         // -8% from entry
    sellTarget1: 0.14526,      // +15%
    sellTarget2: 0.15789,      // +25%
    sellTarget3: 0.17683,      // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },
  {
    symbol: "FIL",
    name: "Filecoin",
    address: "0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153",
    decimals: 18,
    holdings: 15.163,          // on-chain: 15.163
    entryPrice: 1.0003,
    entryCost: 15.13,
    buyZone: 0.9503,           // -5% from entry
    sellTarget: 1.4004,        // +40%
    stopLoss: 0.9203,          // -8% from entry
    sellTarget1: 1.1503,       // +15%
    sellTarget2: 1.2504,       // +25%
    sellTarget3: 1.4004,       // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },
  {
    symbol: "XRP",
    name: "XRP",
    address: "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE",
    decimals: 18,
    holdings: 3.486,           // on-chain: 3.486
    entryPrice: 1.455,
    entryCost: 5.16,
    buyZone: 1.382,            // -5% from entry
    sellTarget: 2.037,         // +40%
    stopLoss: 1.339,           // -8% from entry
    sellTarget1: 1.673,        // +15%
    sellTarget2: 1.819,        // +25%
    sellTarget3: 2.037,        // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },
  {
    symbol: "ADA",
    name: "Binance-Peg Cardano",
    address: "0x3ee2200efb3400fabb9aacf31297cbdd1d435d47",
    decimals: 18,
    holdings: 3.922,           // on-chain: 3.922
    entryPrice: 0.2547,        // swap price
    entryCost: 1.00,
    buyZone: 0.2420,           // -5% from entry
    sellTarget: 0.3566,        // +40%
    stopLoss: 0.2343,          // -8% from entry
    sellTarget1: 0.2929,       // +15%
    sellTarget2: 0.3184,       // +25%
    sellTarget3: 0.3566,       // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },
  {
    symbol: "CAKE",
    name: "PancakeSwap Token",
    address: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
    decimals: 18,
    holdings: 0.641,           // on-chain: 0.641
    entryPrice: 1.560,         // swap price
    entryCost: 1.00,
    buyZone: 1.482,            // -5% from entry
    sellTarget: 2.184,         // +40%
    stopLoss: 1.435,           // -8% from entry
    sellTarget1: 1.794,        // +15%
    sellTarget2: 1.950,        // +25%
    sellTarget3: 2.184,        // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },
  {
    symbol: "GMT",
    name: "GMT Token",
    address: "0x7Ddc52c4De30e94Be3A6A0A2b259b2850f421989",
    decimals: 18,
    holdings: 3.315,           // on-chain: 3.315
    entryPrice: 0.3016,        // swap price
    entryCost: 1.00,
    buyZone: 0.2865,           // -5% from entry
    sellTarget: 0.4222,        // +40%
    stopLoss: 0.2775,          // -8% from entry
    sellTarget1: 0.3468,       // +15%
    sellTarget2: 0.3770,       // +25%
    sellTarget3: 0.4222,       // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },
  {
    symbol: "TWT",
    name: "Trust Wallet Token",
    address: "0x4B0F1812e5Df2A09796481Ff14017e6005508003",
    decimals: 18,
    holdings: 2.372,           // on-chain: 2.372
    entryPrice: 0.4230,        // swap price
    entryCost: 1.00,
    buyZone: 0.4019,           // -5% from entry
    sellTarget: 0.5922,        // +40%
    stopLoss: 0.3892,          // -8% from entry
    sellTarget1: 0.4865,       // +15%
    sellTarget2: 0.5288,       // +25%
    sellTarget3: 0.5922,       // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },

  // ─── HOLD TOKENS (long-term, wider targets) ──────────────────────
  {
    symbol: "LTC",
    name: "Litecoin",
    address: "0x4338665CBB7B2485A8855A139b75D5e34AB0DB94",
    decimals: 18,
    holdings: 0.0894,          // on-chain: 0.0894
    entryPrice: 56.29,
    entryCost: 5.07,
    buyZone: 53.48,            // -5% from entry
    sellTarget: 78.81,         // +40%
    stopLoss: 51.79,           // -8% from entry
    sellTarget1: 64.73,        // +15%
    sellTarget2: 70.36,        // +25%
    sellTarget3: 78.81,        // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "hold",
  },
  {
    symbol: "BNB",
    name: "BNB Native",
    address: "native",
    decimals: 18,
    holdings: 0.004729,        // on-chain: 0.004729 (gas spent from 0.01670)
    entryPrice: 622.80,
    entryCost: 2.94,           // proportional: 0.004729 × 622.80
    buyZone: 591.66,           // -5% from entry
    sellTarget: 871.92,        // +40%
    stopLoss: 572.98,          // -8% from entry
    sellTarget1: 716.22,       // +15%
    sellTarget2: 778.50,       // +25%
    sellTarget3: 871.92,       // +40%
    trailingStopPct: 6,
    autoExecute: false,        // keep for gas
    category: "hold",
  },
  {
    symbol: "WBNB",
    name: "Wrapped BNB",
    address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
    decimals: 18,
    holdings: 0.02286,         // on-chain: 0.02286 (accumulated from swaps)
    entryPrice: 636.00,        // weighted avg of all WBNB acquisitions
    entryCost: 14.54,          // 2.54 + 5.00 + ~7.00 from IDRX/XPL
    buyZone: 604.20,           // -5% from entry
    sellTarget: 890.40,        // +40%
    stopLoss: 585.12,          // -8% from entry
    sellTarget1: 731.40,       // +15%
    sellTarget2: 795.00,       // +25%
    sellTarget3: 890.40,       // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "hold",
  },
  {
    symbol: "BCH",
    name: "Binance-Peg Bitcoin Cash",
    address: "0x8fF795a6F4D97E7887C79beA79aba5cc76444aDf",
    decimals: 18,
    holdings: 0.002214,        // on-chain: 0.002214
    entryPrice: 449.23,        // swap price
    entryCost: 1.00,
    buyZone: 426.77,           // -5% from entry
    sellTarget: 629.00,        // +40%
    stopLoss: 413.29,          // -8% from entry
    sellTarget1: 516.61,       // +15%
    sellTarget2: 561.54,       // +25%
    sellTarget3: 629.00,       // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "hold",
  },
  {
    symbol: "ETH",
    name: "Binance-Peg Ethereum",
    address: "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
    decimals: 18,
    holdings: 0.0000138,       // on-chain: 0.0000138 (dust)
    entryPrice: 2420.36,
    entryCost: 0.03,
    buyZone: 2299.34,          // -5% from entry
    sellTarget: 3388.50,       // +40%
    stopLoss: 2226.73,         // -8% from entry
    sellTarget1: 2783.41,      // +15%
    sellTarget2: 3025.45,      // +25%
    sellTarget3: 3388.50,      // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "hold",
  },

  // ─── MOONSHOT TOKENS (high risk, wider trailing) ─────────────────
  {
    symbol: "LAWAS",
    name: "LAWAS",
    address: "0xc6e6b78a08613768572255bc859204542346b879",
    decimals: 18,
    holdings: 199749.54,       // on-chain: 199749.54
    entryPrice: 0.00002815,
    entryCost: 5.63,
    buyZone: 0.00002674,       // -5% from entry
    sellTarget: 0.00004223,    // +50%
    stopLoss: 0.00002590,      // -8% from entry
    sellTarget1: 0.00003237,   // +15%
    sellTarget2: 0.00003660,   // +30%
    sellTarget3: 0.00004223,   // +50%
    trailingStopPct: 8,
    autoExecute: true,
    category: "moonshot",
  },
  {
    symbol: "SAPI",
    name: "SAPI",
    address: "0x1ae102c0c30d604e7089fb210dd4b42c01287f32",
    decimals: 18,
    holdings: 1408.23,         // on-chain: 1408.23
    entryPrice: 0.004687,
    entryCost: 6.63,
    buyZone: 0.004453,         // -5% from entry
    sellTarget: 0.007031,      // +50%
    stopLoss: 0.004312,        // -8% from entry
    sellTarget1: 0.005390,     // +15%
    sellTarget2: 0.006093,     // +30%
    sellTarget3: 0.007031,     // +50%
    trailingStopPct: 8,
    autoExecute: true,
    category: "moonshot",
  },
  {
    symbol: "BTT",
    name: "BitTorrent",
    address: "0x352Cb5E19b12FC216548a2677bD0fce83BaE434B",
    decimals: 18,
    holdings: 3058194,         // on-chain: 3058194
    entryPrice: 0.000000327,   // from 1 USDT swap
    entryCost: 1.00,
    buyZone: 0.000000311,      // -5% from entry
    sellTarget: 0.000000491,   // +50%
    stopLoss: 0.000000301,     // -8% from entry
    sellTarget1: 0.000000376,  // +15%
    sellTarget2: 0.000000425,  // +30%
    sellTarget3: 0.000000491,  // +50%
    trailingStopPct: 8,
    autoExecute: true,
    category: "moonshot",
  },
  {
    symbol: "AI",
    name: "Flourishing AI Token",
    address: "0xa9b038285f43cd6fe9e16b4c80b4b9bccd3c161b",
    decimals: 18,
    holdings: 364.038,         // on-chain: 364.038
    entryPrice: 0.002780,      // swap price
    entryCost: 1.00,
    buyZone: 0.002641,         // -5% from entry
    sellTarget: 0.004170,      // +50%
    stopLoss: 0.002558,        // -8% from entry
    sellTarget1: 0.003197,     // +15%
    sellTarget2: 0.003614,     // +30%
    sellTarget3: 0.004170,     // +50%
    trailingStopPct: 8,
    autoExecute: true,
    category: "moonshot",
  },
  {
    symbol: "RIO",
    name: "Realio Network",
    address: "0x8c49a510756224e887b3d99d00d959f2d86dda1c",
    decimals: 18,
    holdings: 1485.78,         // on-chain: 1485.78
    entryPrice: 0.000692,      // swap price
    entryCost: 1.00,
    buyZone: 0.000657,         // -5% from entry
    sellTarget: 0.001038,      // +50%
    stopLoss: 0.000637,        // -8% from entry
    sellTarget1: 0.000796,     // +15%
    sellTarget2: 0.000900,     // +30%
    sellTarget3: 0.001038,     // +50%
    trailingStopPct: 8,
    autoExecute: true,
    category: "moonshot",
  },

  // ─── LINK — fully sold, keep tracking for re-entry ───────────────
  {
    symbol: "LINK",
    name: "Chainlink",
    address: "0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD",
    decimals: 18,
    holdings: 0,               // on-chain: ~0 (fully sold)
    entryPrice: 9.502,         // current price for re-entry tracking
    entryCost: 0,              // realized — no open cost
    buyZone: 9.027,            // -5% for re-entry
    sellTarget: 13.303,        // +40%
    stopLoss: 8.742,           // -8%
    sellTarget1: 10.927,       // +15%
    sellTarget2: 11.878,       // +25%
    sellTarget3: 13.303,       // +40%
    trailingStopPct: 6,
    autoExecute: true,
    category: "swing",
  },
];

// ─── State Tracking ────────────────────────────────────────────────
interface PriceSnapshot {
  symbol: string;
  price: number;
  change1H: number;
  change4H: number;
  change24H: number;
  volume24H: number;
  volume1H: number;      // volume last 1 hour (USD)
  volume4H: number;      // volume last 4 hours (USD)
  volume5M: number;      // volume last 5 min (USD)
  liquidity: number;
  txs24H: number;
  txs1H: number;         // transactions last 1 hour
  txs4H: number;         // transactions last 4 hours
  txs5M: number;         // transactions last 5 min (block activity proxy)
  tradeNum: number;      // total trade count
  high24H: number;
  low24H: number;
  marketCap: number;     // market cap (USD)
  circSupply: number;    // circulating supply
  holders: number;       // unique holder count
  timestamp: number;
}

interface AlertState {
  lastBuyAlert: number;
  lastSellAlert: number;
  lastStopLossAlert: number;
  lastPumpAlert: number;
  lastDumpAlert: number;
  lastAutoBuy: number;    // cooldown for autonomous DCA buys
}

const ONCHAINOS = "/home/lasbonai/.local/bin/onchainos";
const STATE_FILE = "/home/lasbonai/Desktop/lasbonai/okx-agentic-bot/data/bsc-monitor-state.json";
const LOG_FILE = "/home/lasbonai/Desktop/lasbonai/okx-agentic-bot/logs/bsc-monitor.log";
const PORTFOLIO_DIR = "/home/lasbonai/Desktop/lasbonai/okx-agentic-bot/token portfolio/BSC";
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;      // 15 min cooldown per alert type
const AUTO_BUY_COOLDOWN_MS = 3 * 60 * 60 * 1000; // 3 hours between auto-DCA buys per token
const DCA_BUY_USD = 15;                             // USDT to spend per auto DCA buy (was $5)
const USD_TO_IDR = 16_800; // 1 USD = Rp 16.800

// ─── Shared Signal Helper ───────────────────────────────────────────
function getSignal(token: TokenConfig, snap: PriceSnapshot): string {
  if (token.category === "stablecoin") return "STABLE";
  const ts = trailingStates[token.symbol];
  if (snap.price <= token.stopLoss) return "STOP_LOSS";
  if (ts?.trailingStop && ts.trailingStop > token.stopLoss && snap.price <= ts.trailingStop) return "TRAILING_STOP";
  if (snap.price >= token.sellTarget3) return "SELL_T3";
  if (snap.price >= token.sellTarget2) return "SELL_T2";
  if (snap.price >= token.sellTarget1) return "SELL_T1";
  if (snap.price <= token.buyZone) return "BUY";
  return "HOLD";
}

// ─── MySQL Connection Pool (token_info DB) ─────────────────────────
const mysqlPool = mysql.createPool({
  host: "127.0.0.1",
  port: 3306,
  user: "token",
  password: "intelijen",
  database: "token_info",
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
});

async function uploadSnapshotToMySQL(token: TokenConfig, snap: PriceSnapshot) {
  const tableName = `${token.symbol}_BSC`;
  const pnlPct = ((snap.price - token.entryPrice) / token.entryPrice) * 100;
  const currentValue = snap.price * token.holdings;
  const pnlUSD = currentValue - token.entryCost;
  const now = new Date();
  const signal = getSignal(token, snap);

  const sql = `INSERT INTO \`${tableName}\` (
    symbol, name, chain, chain_id, address, decimals, category,
    timestamp, timestamp_unix, price_usd, price_idr,
    change_1h, change_4h, change_24h, range24h_high, range24h_low,
    market_volume24h_usd, market_volume24h_idr, market_liquidity_usd, market_liquidity_idr, market_txs24h,
    portfolio_holdings, portfolio_entryPrice, portfolio_entryCost_usd, portfolio_entryCost_idr,
    portfolio_currentValue_usd, portfolio_currentValue_idr, portfolio_pnl_usd, portfolio_pnl_idr, portfolio_pnl_pct,
    zones_buyZone, zones_sellTarget1, zones_sellTarget2, zones_sellTarget3, zones_stopLoss, zones_trailingStop, zones_trailingStopPct,
    \`signal\`, source_file
  ) VALUES (?, ?, 'BSC', 56, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const params = [
    token.symbol, token.name, token.address, token.decimals, token.category,
    now.toISOString().replace("T", " ").replace("Z", ""), snap.timestamp, snap.price, snap.price * USD_TO_IDR,
    snap.change1H, snap.change4H, snap.change24H, snap.high24H, snap.low24H,
    snap.volume24H, snap.volume24H * USD_TO_IDR, snap.liquidity, snap.liquidity * USD_TO_IDR, snap.txs24H,
    token.holdings, token.entryPrice, token.entryCost, token.entryCost * USD_TO_IDR,
    currentValue, currentValue * USD_TO_IDR, pnlUSD, pnlUSD * USD_TO_IDR, parseFloat(pnlPct.toFixed(2)),
    token.buyZone, token.sellTarget1, token.sellTarget2, token.sellTarget3, token.stopLoss,
    trailingStates[token.symbol]?.trailingStop ?? 0, token.trailingStopPct,
    signal, `auto_${token.symbol}_${now.toISOString()}`
  ];

  try {
    await mysqlPool.execute(sql, params);
  } catch (e: any) {
    log(`⚠ MySQL upload ${token.symbol}: ${e.message?.split("\n")[0]}`);
  }
}

let alertStates: Record<string, AlertState> = {};
let priceHistory: Record<string, PriceSnapshot[]> = {};
let cycleCount = 0;

// ─── Buy/Sell Pressure Cache ───────────────────────────────────────
interface BuySellEntry {
  buyPct: number;    // % of trades that were buys (0-100)
  sellPct: number;
  buyCount: number;
  sellCount: number;
  updatedAtCycle: number;
}
const buyPressureCache = new Map<string, BuySellEntry>();
const BUY_PRESSURE_INTERVAL = 5; // refresh every 5 cycles per token

async function fetchBuySellPressure(token: TokenConfig): Promise<void> {
  // Skip stablecoins and tokens with no address
  if (token.category === "stablecoin") return;
  const addr = token.address === "native" ? WBNB_ADDRESS : token.address;
  try {
    const out = await execWithTimeout(
      `${ONCHAINOS} token trades --address ${addr} --chain 56 --limit 50 2>/dev/null`,
      8000
    );
    if (!out) return;
    const json = JSON.parse(out);
    if (!json.ok || !Array.isArray(json.data)) return;
    const trades: Array<{ side?: string; type?: string }> = json.data;
    if (trades.length === 0) return;
    let buyCount = 0;
    let sellCount = 0;
    for (const t of trades) {
      const side = (t.side ?? t.type ?? "").toLowerCase();
      if (side === "buy") buyCount++;
      else if (side === "sell") sellCount++;
    }
    const total = buyCount + sellCount;
    if (total === 0) return;
    buyPressureCache.set(token.symbol, {
      buyPct: (buyCount / total) * 100,
      sellPct: (sellCount / total) * 100,
      buyCount,
      sellCount,
      updatedAtCycle: cycleCount,
    });
  } catch {
    // silently skip — not critical
  }
}

// ─── Swap Route Cache (best route for selling token → BNB) ─────────
interface SwapRouteEntry {
  routeSummary: string;   // e.g. "TOKEN → WBNB via PancakeSwap V3"
  priceImpact: string;    // e.g. "0.45%"
  updatedAtCycle: number;
}
const swapRouteCache = new Map<string, SwapRouteEntry>();
const SWAP_ROUTE_INTERVAL = 10; // cache refresh every 10 cycles

async function fetchSwapRouteForToken(token: TokenConfig, snap: PriceSnapshot): Promise<void> {
  if (token.category === "stablecoin" || token.holdings <= 0) return;
  const addr = token.address === "native" ? WBNB_ADDRESS : token.address;
  // Only try for non-native tokens
  if (token.address === "native") return;
  // Sell 10% position as representative amount for quote
  const sampleAmount = token.holdings * 0.1;
  if (sampleAmount <= 0) return;
  try {
    // Convert holdings to token units (assumes 18 dec — adjust via --decimals if needed)
    const out = await execWithTimeout(
      `${ONCHAINOS} swap quote --from-token ${addr} --to-token ${WBNB_ADDRESS} --amount ${sampleAmount} --chain 56 2>/dev/null`,
      8000
    );
    if (!out) return;
    const json = JSON.parse(out);
    if (!json.ok || !json.data) return;
    const d = json.data;
    // Extract route path and price impact from response
    const routePath: string[] = d.routerResult?.quoteCompareList?.[0]?.routeList?.[0]?.subRouterList
      ?.map((sr: any) => sr.dexProtocol?.map((dp: any) => dp.dexName).join("+"))
      .filter(Boolean) ?? [];
    const routeSummary = routePath.length > 0
      ? `${token.symbol} → BNB via ${routePath.join(" → ")}`
      : d.routerResult?.quoteCompareList?.[0]?.dexName ?? "unknown";
    const priceImpact = d.priceImpactPercentage ?? d.routerResult?.quoteCompareList?.[0]?.priceImpactPercentage ?? "?";
    swapRouteCache.set(token.symbol, {
      routeSummary,
      priceImpact: `${parseFloat(priceImpact as string) >= 0 ? "" : ""}${parseFloat(priceImpact as string).toFixed(2)}%`,
      updatedAtCycle: cycleCount,
    });
  } catch {
    // silently skip
  }
}

// ─── Liquidity Pool Cache ──────────────────────────────────────────
interface LiquidityPoolEntry {
  topPool: string;       // e.g. "TOKEN/WBNB PancakeSwap V3"
  poolLiquidityUSD: number;
  updatedAtCycle: number;
}
const liquidityPoolCache = new Map<string, LiquidityPoolEntry>();
const LIQUIDITY_POOL_INTERVAL = 30; // refresh every 30 cycles (~30 min)

async function fetchLiquidityPool(token: TokenConfig): Promise<void> {
  if (token.category === "stablecoin" || token.address === "native") return;
  try {
    const out = await execWithTimeout(
      `${ONCHAINOS} token liquidity --address ${token.address} --chain 56 --limit 1 2>/dev/null`,
      8000
    );
    if (!out) return;
    const json = JSON.parse(out);
    if (!json.ok || !Array.isArray(json.data) || json.data.length === 0) return;
    const pool = json.data[0];
    const dex = pool.dexName ?? pool.exchangeName ?? "unknown DEX";
    const pair = pool.tokenPair ?? pool.pair ?? `${token.symbol}/WBNB`;
    const liqUSD = parseFloat(pool.liquidityUsd ?? pool.liquidity ?? "0");
    liquidityPoolCache.set(token.symbol, {
      topPool: `${pair} (${dex})`,
      poolLiquidityUSD: liqUSD,
      updatedAtCycle: cycleCount,
    });
  } catch {
    // silently skip
  }
}

// Initialize trailing states
for (const t of TOKENS) {
  trailingStates[t.symbol] = {
    peakPrice: t.entryPrice,
    trailingStop: t.entryPrice * (1 - t.trailingStopPct / 100),
    sold1: false,
    sold2: false,
    sold3: false,
  };
}

// ─── CLI Args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const intervalSec = parseInt(args.find((a, i) => args[i - 1] === "--interval") ?? "60", 10);
const noTelegram = args.includes("--no-telegram");
const onceMode = args.includes("--once");

// ─── Utilities ─────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
};

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    const dir = LOG_FILE.substring(0, LOG_FILE.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n");
  } catch { /* ignore */ }
}

function formatUSD(n: number): string {
  if (Math.abs(n) < 0.01) return n.toExponential(4);
  return "$" + n.toFixed(4);
}

function formatIDR(usd: number): string {
  const idr = usd * USD_TO_IDR;
  if (idr >= 1_000_000) return `Rp${(idr / 1_000_000).toFixed(1)}jt`;
  if (idr >= 1_000) return `Rp${(idr / 1_000).toFixed(1)}rb`;
  return `Rp${Math.round(idr)}`;
}

function formatPrice(n: number): string {
  if (n < 0.0001) return n.toExponential(4);
  if (n < 0.01) return n.toFixed(6);
  if (n < 1) return n.toFixed(5);
  return n.toFixed(4);
}

function pctColor(pct: number): string {
  if (pct > 5) return C.green + C.bold;
  if (pct > 0) return C.green;
  if (pct < -5) return C.red + C.bold;
  if (pct < 0) return C.red;
  return C.dim;
}

// ─── Token Portfolio JSON Snapshot ─────────────────────────────────
function saveTokenSnapshot(token: TokenConfig, snap: PriceSnapshot) {
  try {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, "0");
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const yyyy = now.getFullYear();
    const hh = String(now.getHours()).padStart(2, "0");
    const mi = String(now.getMinutes()).padStart(2, "0");
    const ss = String(now.getSeconds()).padStart(2, "0");

    const fileName = `${token.symbol}_${dd}${mm}${yyyy}_${hh}${mi}${ss}.json`;
    const dir = `${PORTFOLIO_DIR}/${token.symbol}`;
    mkdirSync(dir, { recursive: true });

    const pnlPct = ((snap.price - token.entryPrice) / token.entryPrice) * 100;
    const currentValue = snap.price * token.holdings;
    const pnlUSD = currentValue - token.entryCost;

    const data = {
      symbol: token.symbol,
      name: token.name,
      chain: "BSC",
      chainId: 56,
      address: token.address,
      decimals: token.decimals,
      category: token.category,
      timestamp: now.toISOString(),
      timestampUnix: snap.timestamp,
      price: {
        usd: snap.price,
        idr: snap.price * USD_TO_IDR,
      },
      change: {
        "1h": snap.change1H,
        "4h": snap.change4H,
        "24h": snap.change24H,
      },
      range24h: {
        high: snap.high24H,
        low: snap.low24H,
      },
      market: {
        volume24h_usd: snap.volume24H,
        volume24h_idr: snap.volume24H * USD_TO_IDR,
        liquidity_usd: snap.liquidity,
        liquidity_idr: snap.liquidity * USD_TO_IDR,
        txs24h: snap.txs24H,
      },
      portfolio: {
        holdings: token.holdings,
        entryPrice: token.entryPrice,
        entryCost_usd: token.entryCost,
        entryCost_idr: token.entryCost * USD_TO_IDR,
        currentValue_usd: currentValue,
        currentValue_idr: currentValue * USD_TO_IDR,
        pnl_usd: pnlUSD,
        pnl_idr: pnlUSD * USD_TO_IDR,
        pnl_pct: parseFloat(pnlPct.toFixed(2)),
      },
      zones: {
        buyZone: token.buyZone,
        sellTarget1: token.sellTarget1,
        sellTarget2: token.sellTarget2,
        sellTarget3: token.sellTarget3,
        stopLoss: token.stopLoss,
        trailingStop: trailingStates[token.symbol]?.trailingStop ?? 0,
        trailingStopPct: token.trailingStopPct,
      },
      signal: getSignal(token, snap),
    };

    writeFileSync(`${dir}/${fileName}`, JSON.stringify(data, null, 2));

    // Keep only the 10 newest JSON files, delete older ones
    const MAX_SNAPSHOTS = 10;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse(); // newest first (filenames contain date_time)
    if (files.length > MAX_SNAPSHOTS) {
      for (const old of files.slice(MAX_SNAPSHOTS)) {
        try { unlinkSync(`${dir}/${old}`); } catch {}
      }
    }
  } catch (e: any) {
    log(`⚠ Failed to save snapshot ${token.symbol}: ${e.message?.split("\n")[0]}`);
  }
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
      alertStates = data.alertStates ?? {};
      priceHistory = data.priceHistory ?? {};
      cycleCount = data.cycleCount ?? 0;
      // Restore trailing states
      if (data.trailingStates) {
        for (const sym of Object.keys(data.trailingStates)) {
          if (trailingStates[sym]) {
            Object.assign(trailingStates[sym], data.trailingStates[sym]);
          }
        }
      }
      // Restore profit tracker
      if (data.profitTracker) {
        Object.assign(profitTracker, data.profitTracker);
      }
      // Restore capital baseline (modal awal)
      if (data.capitalBaseline) {
        Object.assign(capitalBaseline, data.capitalBaseline);
      }
      // Restore seed swap state
      if (data.seedSwapState) {
        seedSwapState = data.seedSwapState;
      }
      // Restore hourly report cycle
      if (data.lastHourlyReportCycle != null) {
        lastHourlyReportCycle = data.lastHourlyReportCycle;
      }
    }
  } catch { /* fresh start */ }
}

function saveState() {
  try {
    const dir = STATE_FILE.substring(0, STATE_FILE.lastIndexOf("/"));
    mkdirSync(dir, { recursive: true });
    // Keep only last 1440 snapshots per token (24h at 1min intervals)
    for (const sym of Object.keys(priceHistory)) {
      if (priceHistory[sym].length > 1440) {
        priceHistory[sym] = priceHistory[sym].slice(-1440);
      }
    }
    writeFileSync(STATE_FILE, JSON.stringify({ alertStates, priceHistory, cycleCount, trailingStates, profitTracker, capitalBaseline, seedSwapState, lastHourlyReportCycle }, null, 2));
  } catch { /* ignore */ }
}

// ─── Price Fetching ────────────────────────────────────────────────
const WBNB_ADDRESS = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

async function fetchPriceInfo(token: TokenConfig): Promise<PriceSnapshot | null> {
  try {
    // BNB native uses WBNB address for price lookup (same price)
    const priceAddress = token.address === "native" ? WBNB_ADDRESS : token.address;
    const out = await execWithTimeout(
      `${ONCHAINOS} token price-info --address ${priceAddress} --chain 56 2>/dev/null`,
      20000
    );
    if (!out) return null;
    const json = JSON.parse(out);
    if (!json.ok || !json.data?.[0]) return null;

    const d = json.data[0];
    return {
      symbol: token.symbol,
      price: parseFloat(d.price),
      change1H: parseFloat(d.priceChange1H ?? "0"),
      change4H: parseFloat(d.priceChange4H ?? "0"),
      change24H: parseFloat(d.priceChange24H ?? "0"),
      volume24H: parseFloat(d.volume24H ?? "0"),
      volume1H: parseFloat(d.volume1H ?? "0"),
      volume4H: parseFloat(d.volume4H ?? "0"),
      volume5M: parseFloat(d.volume5M ?? "0"),
      liquidity: parseFloat(d.liquidity ?? "0"),
      txs24H: parseInt(d.txs24H ?? "0", 10),
      txs1H: parseInt(d.txs1H ?? "0", 10),
      txs4H: parseInt(d.txs4H ?? "0", 10),
      txs5M: parseInt(d.txs5M ?? "0", 10),
      tradeNum: parseInt(d.tradeNum ?? "0", 10),
      high24H: parseFloat(d.maxPrice ?? "0"),
      low24H: parseFloat(d.minPrice ?? "0"),
      marketCap: parseFloat(d.marketCap ?? "0"),
      circSupply: parseFloat(d.circSupply ?? "0"),
      holders: parseInt(d.holders ?? "0", 10),
      timestamp: Date.now(),
    };
  } catch (e: any) {
    log(`⚠ Failed to fetch ${token.symbol}: ${e.message?.split("\n")[0]}`);
    return null;
  }
}

// ─── Telegram Alerts ───────────────────────────────────────────────
async function sendTelegram(message: string) {
  if (noTelegram || !hasTelegramConfig()) return;

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log(`⚠ Telegram send failed: HTTP ${resp.status} — ${body.slice(0, 200)}`);
    }
  } catch (e: any) {
    log(`⚠ Telegram error: ${e.message}`);
  }
}

async function sendTelegramWithButton(message: string, btnText: string, btnUrl: string) {
  if (noTelegram || !hasTelegramConfig()) return;

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[{ text: btnText, url: btnUrl }]],
          },
        }),
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log(`⚠ Telegram send failed: HTTP ${resp.status} — ${body.slice(0, 200)}`);
    }
  } catch (e: any) {
    log(`⚠ Telegram error: ${e.message}`);
  }
}

async function sendTelegramWith2Buttons(
  message: string,
  btn1Text: string, btn1Url: string,
  btn2Text: string, btn2Url: string,
) {
  if (noTelegram || !hasTelegramConfig()) return;

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [{ text: btn1Text, url: btn1Url }],
              [{ text: btn2Text, url: btn2Url }],
            ],
          },
        }),
      }
    );
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log(`⚠ Telegram send failed: HTTP ${resp.status} — ${body.slice(0, 200)}`);
    }
  } catch (e: any) {
    log(`⚠ Telegram error: ${e.message}`);
  }
}

// ─── Seed Swap Execution (zero-balance tokens >1 day → auto buy 1 USDT) ──
async function executeSeedSwaps(): Promise<void> {
  const now = Date.now();
  const seedTokens = TOKENS.filter((t) => t.category === "seed");

  for (const token of seedTokens) {
    const onChainBal = getOnChainBalance(token.address) ?? token.holdings;

    // If token has balance, clear zero-balance tracking
    if (onChainBal > 0) {
      if (seedSwapState[token.symbol]) {
        delete seedSwapState[token.symbol];
      }
      continue;
    }

    // Token has 0 balance — track when first seen
    if (!seedSwapState[token.symbol]) {
      seedSwapState[token.symbol] = { zeroBalanceSince: now };
      log(`🌱 SEED: ${token.symbol} balance=0, tracking started`);
      continue;
    }

    const entry = seedSwapState[token.symbol];

    // Already executed seed swap — skip
    if (entry.swapExecutedAt) continue;

    // Check if >1 day has passed
    const elapsed = now - entry.zeroBalanceSince;
    if (elapsed < SEED_SWAP_DELAY_MS) continue;

    const daysZero = (elapsed / (24 * 60 * 60 * 1000)).toFixed(1);
    log(`🌱 SEED SWAP: ${token.symbol} has been 0 for ${daysZero}d — buying ${SEED_SWAP_AMOUNT_USDT} USDT worth`);

    const success = await executeBuy(token, SEED_SWAP_AMOUNT_USDT, `SEED SWAP: 0 balance for ${daysZero}d`);
    if (success) {
      entry.swapExecutedAt = now;
      log(`✅ SEED SWAP complete: ${token.symbol}`);
    }
  }
}

// ─── Hourly P&L Telegram Report + Analysis + JSON Archive ──────────
let lastHourlyReportCycle = 0;
const HOURLY_CYCLES = 60; // 60 cycles × 60s = 1 hour
const REPORT_DIR = `${process.env.HOME}/Desktop/lasbonai/okx-agentic-bot/token portfolio/BSC/REPORT`;
const MAX_HOURLY_REPORTS = 24; // accumulate 24 reports then merge for daily analysis

interface TokenAnalysis {
  symbol: string;
  category: string;
  price: number;
  priceIDR: number;
  entryPrice: number;
  holdings: number;
  currentValueUSD: number;
  currentValueIDR: number;
  entryCostUSD: number;
  entryCostIDR: number;
  pnlUSD: number;
  pnlIDR: number;
  pnlPct: number;
  change1H: number;
  change4H: number;
  change24H: number;
  volume24H: number;
  volume1H: number;
  volume4H: number;
  liquidity: number;
  txs24H: number;
  txs1H: number;
  txs4H: number;
  txs5M: number;               // recent block-level tx activity
  high24H: number;
  low24H: number;
  marketCap: number;           // market cap USD
  fdv: number;                 // fully diluted valuation = price × circSupply
  holders: number;             // holder count
  volatility24H: number;       // (high-low)/low × 100
  priceVsHigh24H: number;      // % distance from 24h high
  priceVsLow24H: number;       // % distance from 24h low
  volumeToLiquidity: number;   // volume24H/liquidity ratio (turnover)
  volumeMomentum1H: number;    // volume1H / (volume4H/4) — hourly momentum vs 4H avg
  buyPressurePct: number;      // % of recent trades that were buys (0-100), -1 = unknown
  signal: string;
  drivers: string[];            // human-readable P&L driver explanations
}

interface HourlyReport {
  timestamp: string;           // ISO
  timestampWIB: string;
  cycleNumber: number;
  portfolio: {
    totalValueUSD: number;
    totalValueIDR: number;
    totalCostUSD: number;
    totalCostIDR: number;
    totalPnlUSD: number;
    totalPnlIDR: number;
    totalPnlPct: number;
    weeklyPnlPct: number;
    weeklyTargetPct: number;
    pendingProfitUSD: number;
  };
  tokens: TokenAnalysis[];
  topGainers: string[];        // top 3 contributors to positive P&L
  topLosers: string[];         // top 3 contributors to negative P&L
  marketSentiment: string;     // "bullish" | "bearish" | "neutral" | "mixed"
  keyInsights: string[];       // auto-generated analysis points
}

function analyzeTokenPnL(token: TokenConfig, snap: PriceSnapshot): TokenAnalysis {
  const currentValue = snap.price * token.holdings;
  const pnlUSD = currentValue - token.entryCost;
  const pnlPct = ((snap.price - token.entryPrice) / token.entryPrice) * 100;
  const volatility24H = snap.low24H > 0 ? ((snap.high24H - snap.low24H) / snap.low24H) * 100 : 0;
  const priceVsHigh = snap.high24H > 0 ? ((snap.high24H - snap.price) / snap.high24H) * 100 : 0;
  const priceVsLow = snap.low24H > 0 ? ((snap.price - snap.low24H) / snap.low24H) * 100 : 0;
  const volToLiq = snap.liquidity > 0 ? snap.volume24H / snap.liquidity : 0;
  const fdv = snap.circSupply > 0 ? snap.price * snap.circSupply : 0;

  // Volume momentum: hourly vol vs 4H average hourly vol
  const avg1HFrom4H = snap.volume4H > 0 ? snap.volume4H / 4 : 0;
  const volMomentum1H = avg1HFrom4H > 0 ? snap.volume1H / avg1HFrom4H : 0;

  // Buy pressure from cache (populated by fetchBuySellPressure)
  const bpEntry = buyPressureCache.get(token.symbol);
  const buyPressurePct = bpEntry ? bpEntry.buyPct : -1;

  // Determine P&L drivers
  const drivers: string[] = [];

  // Price movement driver
  if (Math.abs(snap.change1H) >= 2) {
    drivers.push(`${snap.change1H > 0 ? "📈" : "📉"} Pergerakan 1H signifikan: ${snap.change1H > 0 ? "+" : ""}${snap.change1H.toFixed(1)}%`);
  }
  if (Math.abs(snap.change24H) >= 5) {
    drivers.push(`${snap.change24H > 0 ? "🚀" : "💥"} Perubahan 24H besar: ${snap.change24H > 0 ? "+" : ""}${snap.change24H.toFixed(1)}%`);
  }

  // Volume momentum driver (volume1H vs 4H average)
  if (volMomentum1H >= 2 && snap.volume1H > 0) {
    drivers.push(`🔥 Volume 1H ${volMomentum1H.toFixed(1)}× di atas rata-rata 4H — momentum spike!`);
  } else if (snap.volume1H > 0 && snap.txs1H > 0) {
    drivers.push(`📊 Volume 1H: $${snap.volume1H < 1000 ? snap.volume1H.toFixed(0) : (snap.volume1H / 1000).toFixed(1) + "K"} | txs: ${snap.txs1H}`);
  }

  // Block activity (txs5M — recent)
  if (snap.txs5M > 0) {
    const txsPerMin = (snap.txs5M / 5).toFixed(1);
    drivers.push(`⛓ Aktivitas blok terkini: ${snap.txs5M} tx/5min (${txsPerMin} tx/min)`);
  }

  // Buy/sell pressure
  if (buyPressurePct >= 0) {
    if (buyPressurePct >= 65) {
      drivers.push(`🟢 Tekanan beli dominan: ${buyPressurePct.toFixed(0)}% buy dari 50 trade terakhir`);
    } else if (buyPressurePct <= 35) {
      drivers.push(`🔴 Tekanan jual dominan: ${(100 - buyPressurePct).toFixed(0)}% sell dari 50 trade terakhir`);
    }
  }

  // Market cap context
  if (snap.marketCap > 0) {
    let capLabel = "";
    if (snap.marketCap < 1_000_000) capLabel = "mikro (<$1M)";
    else if (snap.marketCap < 10_000_000) capLabel = "kecil ($1M-$10M)";
    else if (snap.marketCap < 100_000_000) capLabel = "menengah ($10M-$100M)";
    else if (snap.marketCap < 1_000_000_000) capLabel = "besar ($100M-$1B)";
    else capLabel = "mega (>$1B)";
    drivers.push(`🏛 Market cap ${capLabel}: $${snap.marketCap >= 1_000_000 ? (snap.marketCap / 1_000_000).toFixed(1) + "M" : snap.marketCap.toFixed(0)}`);
  }

  // FDV ratio
  if (fdv > 0 && snap.marketCap > 0) {
    const fdvRatio = fdv / snap.marketCap;
    if (fdvRatio > 3) {
      drivers.push(`⚠️ FDV ratio tinggi: ${fdvRatio.toFixed(1)}× MC — risiko inflasi supply`);
    }
  }

  // Holder context
  if (snap.holders > 0) {
    if (snap.holders >= 1_000_000) {
      drivers.push(`👥 Holder retail luas: ${(snap.holders / 1_000_000).toFixed(1)}M holders`);
    } else if (snap.holders < 100) {
      drivers.push(`⚠️ Holder sangat sedikit: ${snap.holders} — risiko rug tinggi`);
    }
  }

  // Volatility driver
  if (volatility24H > 10) {
    drivers.push(`⚡ Volatilitas tinggi: ${volatility24H.toFixed(1)}% range 24H`);
  }

  // Volume/liquidity turnover
  if (volToLiq > 0.5) {
    drivers.push(`🔥 Volume/Liquidity tinggi: ${(volToLiq * 100).toFixed(0)}% turnover`);
  } else if (volToLiq < 0.01 && token.category !== "stablecoin") {
    drivers.push(`😴 Volume sangat rendah: ${(volToLiq * 100).toFixed(2)}% turnover`);
  }

  // Position relative to range
  if (priceVsHigh < 2 && snap.change24H > 0) {
    drivers.push(`🔝 Mendekati high 24H — potensi resistance`);
  }
  if (priceVsLow < 2 && snap.change24H < 0) {
    drivers.push(`🔻 Mendekati low 24H — potensi support`);
  }

  // P&L magnitude driver
  if (pnlPct > 10) {
    drivers.push(`💰 Profit signifikan +${pnlPct.toFixed(1)}% dari entry`);
  } else if (pnlPct < -5) {
    drivers.push(`⚠️ Loss signifikan ${pnlPct.toFixed(1)}% dari entry`);
  }

  if (drivers.length === 0) {
    drivers.push(`✓ Stabil — tidak ada pergerakan signifikan`);
  }

  return {
    symbol: token.symbol,
    category: token.category,
    price: snap.price,
    priceIDR: snap.price * USD_TO_IDR,
    entryPrice: token.entryPrice,
    holdings: token.holdings,
    currentValueUSD: currentValue,
    currentValueIDR: currentValue * USD_TO_IDR,
    entryCostUSD: token.entryCost,
    entryCostIDR: token.entryCost * USD_TO_IDR,
    pnlUSD,
    pnlIDR: pnlUSD * USD_TO_IDR,
    pnlPct,
    change1H: snap.change1H,
    change4H: snap.change4H,
    change24H: snap.change24H,
    volume24H: snap.volume24H,
    volume1H: snap.volume1H,
    volume4H: snap.volume4H,
    liquidity: snap.liquidity,
    txs24H: snap.txs24H,
    txs1H: snap.txs1H,
    txs4H: snap.txs4H,
    txs5M: snap.txs5M,
    high24H: snap.high24H,
    low24H: snap.low24H,
    marketCap: snap.marketCap,
    fdv,
    holders: snap.holders,
    volatility24H,
    priceVsHigh24H: priceVsHigh,
    priceVsLow24H: priceVsLow,
    volumeToLiquidity: volToLiq,
    volumeMomentum1H: volMomentum1H,
    buyPressurePct,
    signal: getSignal(token, snap),
    drivers,
  };
}

function generateKeyInsights(analyses: TokenAnalysis[]): string[] {
  const insights: string[] = [];
  const nonStable = analyses.filter((a) => a.category !== "stablecoin");

  // Overall sentiment
  const bullish = nonStable.filter((a) => a.change1H > 0).length;
  const bearish = nonStable.filter((a) => a.change1H < 0).length;
  if (bullish > bearish * 2) insights.push(`🟢 Market bullish: ${bullish}/${nonStable.length} token naik 1H`);
  else if (bearish > bullish * 2) insights.push(`🔴 Market bearish: ${bearish}/${nonStable.length} token turun 1H`);
  else insights.push(`⚪ Market mixed: ${bullish} naik, ${bearish} turun dari ${nonStable.length} token`);

  // Highest volatility
  const mostVolatile = [...nonStable].sort((a, b) => b.volatility24H - a.volatility24H)[0];
  if (mostVolatile && mostVolatile.volatility24H > 5) {
    insights.push(`⚡ ${mostVolatile.symbol} paling volatile: ${mostVolatile.volatility24H.toFixed(1)}% range`);
  }

  // Biggest gainer/loser by 1H
  const sorted1H = [...nonStable].sort((a, b) => b.change1H - a.change1H);
  if (sorted1H.length > 0 && sorted1H[0].change1H > 1) {
    insights.push(`📈 Top 1H gainer: ${sorted1H[0].symbol} +${sorted1H[0].change1H.toFixed(1)}%`);
  }
  if (sorted1H.length > 0 && sorted1H[sorted1H.length - 1].change1H < -1) {
    const worst = sorted1H[sorted1H.length - 1];
    insights.push(`📉 Top 1H loser: ${worst.symbol} ${worst.change1H.toFixed(1)}%`);
  }

  // Biggest P&L contributor
  const sortedPnL = [...nonStable].sort((a, b) => b.pnlUSD - a.pnlUSD);
  if (sortedPnL.length > 0 && sortedPnL[0].pnlUSD > 0.5) {
    insights.push(`💰 Top P&L: ${sortedPnL[0].symbol} +$${sortedPnL[0].pnlUSD.toFixed(2)} (+${sortedPnL[0].pnlPct.toFixed(1)}%)`);
  }

  // Low liquidity warning
  const lowLiq = nonStable.filter((a) => a.liquidity < 5000 && a.category !== "stablecoin");
  if (lowLiq.length > 0) {
    insights.push(`⚠️ Liquiditas rendah: ${lowLiq.map((a) => a.symbol).join(", ")} — risiko slippage tinggi`);
  }

  // Volume momentum spike
  const momentumSpikes = nonStable.filter((a) => a.volumeMomentum1H >= 2 && a.volume1H > 0);
  if (momentumSpikes.length > 0) {
    const top = momentumSpikes.sort((a, b) => b.volumeMomentum1H - a.volumeMomentum1H)[0];
    insights.push(`⚡ Volume spike 1H: ${top.symbol} ${top.volumeMomentum1H.toFixed(1)}× rata-rata — perhatikan arah`);
  }

  // Buy pressure dominant
  const highBuyPressure = nonStable.filter((a) => a.buyPressurePct >= 65);
  const highSellPressure = nonStable.filter((a) => a.buyPressurePct >= 0 && a.buyPressurePct <= 35);
  if (highBuyPressure.length > 0) {
    insights.push(`🟢 Tekanan beli kuat: ${highBuyPressure.map((a) => `${a.symbol}(${a.buyPressurePct.toFixed(0)}%buy)`).join(", ")}`);
  }
  if (highSellPressure.length > 0) {
    insights.push(`🔴 Tekanan jual kuat: ${highSellPressure.map((a) => `${a.symbol}(${(100 - a.buyPressurePct).toFixed(0)}%sell)`).join(", ")}`);
  }

  // Market cap breakdown
  const hasMcap = nonStable.filter((a) => a.marketCap > 0);
  if (hasMcap.length > 0) {
    const totalMcap = hasMcap.reduce((s, a) => s + a.marketCap, 0);
    if (totalMcap > 0) {
      insights.push(`🏛 Total mkt cap portofolio: $${(totalMcap / 1_000_000).toFixed(1)}M`);
    }
  }

  // FDV inflation risk
  const highFdv = nonStable.filter((a) => a.fdv > 0 && a.marketCap > 0 && (a.fdv / a.marketCap) > 5);
  if (highFdv.length > 0) {
    insights.push(`⚠️ Risiko inflasi supply tinggi: ${highFdv.map((a) => `${a.symbol}(FDV ${(a.fdv / a.marketCap).toFixed(1)}×MC)`).join(", ")}`);
  }

  return insights;
}

function getMarketSentiment(analyses: TokenAnalysis[]): string {
  const nonStable = analyses.filter((a) => a.category !== "stablecoin");
  if (nonStable.length === 0) return "neutral";
  const avg1H = nonStable.reduce((s, a) => s + a.change1H, 0) / nonStable.length;
  const avg24H = nonStable.reduce((s, a) => s + a.change24H, 0) / nonStable.length;
  if (avg1H > 1 && avg24H > 2) return "bullish";
  if (avg1H < -1 && avg24H < -2) return "bearish";
  if (Math.abs(avg1H) < 0.5) return "neutral";
  return "mixed";
}

function buildHourlyReport(snapshots: Map<string, PriceSnapshot>): HourlyReport {
  const now = new Date();
  const analyses: TokenAnalysis[] = [];
  let totalValue = 0;
  let totalCost = 0;

  for (const token of TOKENS) {
    const snap = snapshots.get(token.symbol);
    if (!snap) continue;
    const analysis = analyzeTokenPnL(token, snap);
    analyses.push(analysis);
    totalValue += analysis.currentValueUSD;
    totalCost += analysis.entryCostUSD;
  }

  const totalPnlUSD = totalValue - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnlUSD / totalCost) * 100 : 0;
  const weeklyPnlPct = capitalBaseline.modalAwal > 0
    ? ((totalValue - capitalBaseline.modalAwal) / capitalBaseline.modalAwal) * 100 : 0;

  // Sort by P&L USD contribution
  const sortedByPnl = [...analyses].filter((a) => a.category !== "stablecoin").sort((a, b) => b.pnlUSD - a.pnlUSD);
  const topGainers = sortedByPnl.filter((a) => a.pnlUSD > 0).slice(0, 3).map((a) => `${a.symbol} +$${a.pnlUSD.toFixed(2)}`);
  const topLosers = sortedByPnl.filter((a) => a.pnlUSD < 0).slice(-3).reverse().map((a) => `${a.symbol} $${a.pnlUSD.toFixed(2)}`);

  return {
    timestamp: now.toISOString(),
    timestampWIB: now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }),
    cycleNumber: cycleCount,
    portfolio: {
      totalValueUSD: totalValue,
      totalValueIDR: totalValue * USD_TO_IDR,
      totalCostUSD: totalCost,
      totalCostIDR: totalCost * USD_TO_IDR,
      totalPnlUSD,
      totalPnlIDR: totalPnlUSD * USD_TO_IDR,
      totalPnlPct,
      weeklyPnlPct,
      weeklyTargetPct: WEEKLY_PNL_TARGET,
      pendingProfitUSD: profitTracker.accumulatedProfitUSDT,
    },
    tokens: analyses,
    topGainers,
    topLosers,
    marketSentiment: getMarketSentiment(analyses),
    keyInsights: generateKeyInsights(analyses),
  };
}

function saveHourlyReportJSON(report: HourlyReport): string {
  mkdirSync(REPORT_DIR, { recursive: true });
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const fileName = `${dd}${mm}${yyyy}_${hh}${mi}${ss}_report.json`;
  const filePath = `${REPORT_DIR}/${fileName}`;
  writeFileSync(filePath, JSON.stringify(report, null, 2));
  log(`📄 Report saved: ${fileName}`);
  return filePath;
}

interface DailyAnalysis {
  date: string;
  generatedAt: string;
  reportCount: number;
  periodStart: string;
  periodEnd: string;
  portfolio: {
    startValueUSD: number;
    endValueUSD: number;
    highValueUSD: number;
    lowValueUSD: number;
    dailyPnlUSD: number;
    dailyPnlPct: number;
    avgPnlPct: number;
  };
  tokenTrends: {
    symbol: string;
    category: string;
    priceStart: number;
    priceEnd: number;
    priceHigh: number;
    priceLow: number;
    priceTrend: number;        // % change start→end
    avgVolatility: number;
    avgVolume: number;
    avgLiquidity: number;
    avgTurnover: number;
    pnlStart: number;
    pnlEnd: number;
    pnlTrend: string;          // "improving" | "declining" | "stable"
    bestHour: string;           // WIB timestamp of best P&L
    worstHour: string;          // WIB timestamp of worst P&L
    recommendation: string;     // auto-generated action suggestion
  }[];
  marketAnalysis: {
    dominantSentiment: string;
    bullishHours: number;
    bearishHours: number;
    neutralHours: number;
    trendDirection: string;     // "up" | "down" | "sideways"
  };
  predictions: {
    symbol: string;
    currentPrice: number;
    predictedDirection: string; // "up" | "down" | "sideways"
    confidence: string;         // "high" | "medium" | "low"
    reasoning: string;
    suggestedAction: string;    // "hold" | "accumulate" | "reduce" | "watch"
  }[];
  optimizationSuggestions: string[];
}

function mergeDailyReports(): DailyAnalysis | null {
  const files = readdirSync(REPORT_DIR)
    .filter((f) => f.endsWith("_report.json"))
    .sort();

  if (files.length < MAX_HOURLY_REPORTS) return null;

  // Load all reports
  const reports: HourlyReport[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(readFileSync(`${REPORT_DIR}/${f}`, "utf-8"));
      reports.push(data);
    } catch { /* skip corrupt */ }
  }

  if (reports.length < MAX_HOURLY_REPORTS) return null;

  const first = reports[0];
  const last = reports[reports.length - 1];

  // Portfolio trajectory
  const portfolioValues = reports.map((r) => r.portfolio.totalValueUSD);
  const highValue = Math.max(...portfolioValues);
  const lowValue = Math.min(...portfolioValues);
  const dailyPnlUSD = last.portfolio.totalValueUSD - first.portfolio.totalValueUSD;
  const dailyPnlPct = first.portfolio.totalValueUSD > 0
    ? (dailyPnlUSD / first.portfolio.totalValueUSD) * 100 : 0;
  const avgPnlPct = reports.reduce((s, r) => s + r.portfolio.totalPnlPct, 0) / reports.length;

  // Per-token trend analysis
  const allSymbols = [...new Set(reports.flatMap((r) => r.tokens.map((t) => t.symbol)))];
  const tokenTrends = allSymbols.map((symbol) => {
    const tokenSnaps = reports.map((r) => r.tokens.find((t) => t.symbol === symbol)).filter(Boolean) as TokenAnalysis[];
    if (tokenSnaps.length === 0) return null;

    const firstSnap = tokenSnaps[0];
    const lastSnap = tokenSnaps[tokenSnaps.length - 1];
    const prices = tokenSnaps.map((t) => t.price);
    const pnls = tokenSnaps.map((t) => t.pnlPct);

    const priceTrend = firstSnap.price > 0
      ? ((lastSnap.price - firstSnap.price) / firstSnap.price) * 100 : 0;

    // Best/worst hour
    const bestIdx = pnls.indexOf(Math.max(...pnls));
    const worstIdx = pnls.indexOf(Math.min(...pnls));

    // P&L trend
    const firstHalfAvg = pnls.slice(0, Math.floor(pnls.length / 2)).reduce((s, v) => s + v, 0) / Math.floor(pnls.length / 2);
    const secondHalfAvg = pnls.slice(Math.floor(pnls.length / 2)).reduce((s, v) => s + v, 0) / (pnls.length - Math.floor(pnls.length / 2));
    const pnlTrendDirection = secondHalfAvg - firstHalfAvg > 1 ? "improving" : secondHalfAvg - firstHalfAvg < -1 ? "declining" : "stable";

    // Recommendation
    let recommendation = "hold";
    if (priceTrend > 5 && lastSnap.pnlPct > 5) recommendation = "consider taking partial profit";
    else if (priceTrend < -5 && lastSnap.pnlPct < -3) recommendation = "monitor closely — set tighter stop";
    else if (priceTrend > 2 && pnlTrendDirection === "improving") recommendation = "trend positif — hold/accumulate";
    else if (lastSnap.volumeToLiquidity > 0.5 && priceTrend > 0) recommendation = "volume tinggi + up — momentum bagus";
    else if (lastSnap.volumeToLiquidity < 0.01 && firstSnap.category !== "stablecoin") recommendation = "volume sangat rendah — waspadai exit liquidity";

    return {
      symbol,
      category: firstSnap.category,
      priceStart: firstSnap.price,
      priceEnd: lastSnap.price,
      priceHigh: Math.max(...prices),
      priceLow: Math.min(...prices),
      priceTrend,
      avgVolatility: tokenSnaps.reduce((s, t) => s + t.volatility24H, 0) / tokenSnaps.length,
      avgVolume: tokenSnaps.reduce((s, t) => s + t.volume24H, 0) / tokenSnaps.length,
      avgLiquidity: tokenSnaps.reduce((s, t) => s + t.liquidity, 0) / tokenSnaps.length,
      avgTurnover: tokenSnaps.reduce((s, t) => s + t.volumeToLiquidity, 0) / tokenSnaps.length,
      pnlStart: firstSnap.pnlPct,
      pnlEnd: lastSnap.pnlPct,
      pnlTrend: pnlTrendDirection,
      bestHour: reports[bestIdx]?.timestampWIB ?? "N/A",
      worstHour: reports[worstIdx]?.timestampWIB ?? "N/A",
      recommendation,
    };
  }).filter(Boolean) as DailyAnalysis["tokenTrends"];

  // Market sentiment over the day
  const sentiments = reports.map((r) => r.marketSentiment);
  const bullishHours = sentiments.filter((s) => s === "bullish").length;
  const bearishHours = sentiments.filter((s) => s === "bearish").length;
  const neutralHours = sentiments.filter((s) => s === "neutral").length;
  const dominantSentiment = bullishHours > bearishHours && bullishHours > neutralHours ? "bullish"
    : bearishHours > bullishHours && bearishHours > neutralHours ? "bearish" : "neutral";
  const trendDirection = dailyPnlPct > 1 ? "up" : dailyPnlPct < -1 ? "down" : "sideways";

  // Predictions based on trend analysis
  const predictions = tokenTrends
    .filter((t) => t.category !== "stablecoin")
    .map((t) => {
      let direction: string;
      let confidence: string;
      let reasoning: string;
      let action: string;

      // Simple momentum + trend analysis
      const momentum = t.priceTrend;
      const volStrength = t.avgTurnover;

      if (momentum > 3 && t.pnlTrend === "improving") {
        direction = "up";
        confidence = Math.abs(momentum) > 8 ? "high" : "medium";
        reasoning = `Momentum naik ${momentum.toFixed(1)}% dengan trend P&L membaik. Volume turnover: ${(volStrength * 100).toFixed(0)}%`;
        action = momentum > 8 ? "reduce" : "hold";
      } else if (momentum < -3 && t.pnlTrend === "declining") {
        direction = "down";
        confidence = Math.abs(momentum) > 8 ? "high" : "medium";
        reasoning = `Momentum turun ${momentum.toFixed(1)}% dengan trend P&L menurun. Pertimbangkan stop-loss yang lebih ketat`;
        action = Math.abs(momentum) > 8 ? "reduce" : "watch";
      } else if (Math.abs(momentum) < 1.5) {
        direction = "sideways";
        confidence = "medium";
        reasoning = `Pergerakan sideways (${momentum > 0 ? "+" : ""}${momentum.toFixed(1)}%) — konsolidasi`;
        action = "hold";
      } else {
        direction = momentum > 0 ? "up" : "down";
        confidence = "low";
        reasoning = `Sinyal lemah — momentum ${momentum > 0 ? "+" : ""}${momentum.toFixed(1)}% tapi trend ${t.pnlTrend}`;
        action = "watch";
      }

      return {
        symbol: t.symbol,
        currentPrice: t.priceEnd,
        predictedDirection: direction,
        confidence,
        reasoning,
        suggestedAction: action,
      };
    });

  // Optimization suggestions
  const suggestions: string[] = [];

  if (dailyPnlPct < 0) {
    suggestions.push(`⚠️ P&L harian negatif (${dailyPnlPct.toFixed(1)}%) — review alokasi portfolio`);
  }
  if (dailyPnlPct > 0 && dailyPnlPct < 1) {
    suggestions.push(`📊 P&L positif tapi kecil (+${dailyPnlPct.toFixed(1)}%) — cari entry point baru untuk token berpotensi`);
  }

  const lowPerformers = tokenTrends.filter((t) => t.pnlEnd < -3 && t.category !== "stablecoin");
  if (lowPerformers.length > 0) {
    suggestions.push(`🔻 Token underperform: ${lowPerformers.map((t) => t.symbol).join(", ")} — evaluasi apakah masih layak hold`);
  }

  const highVolatile = tokenTrends.filter((t) => t.avgVolatility > 15 && t.category !== "stablecoin");
  if (highVolatile.length > 0) {
    suggestions.push(`⚡ Volatilitas tinggi: ${highVolatile.map((t) => `${t.symbol}(${t.avgVolatility.toFixed(0)}%)`).join(", ")} — pertimbangkan trailing stop lebih ketat`);
  }

  const improvingTokens = tokenTrends.filter((t) => t.pnlTrend === "improving" && t.pnlEnd > 0 && t.category !== "stablecoin");
  if (improvingTokens.length > 0) {
    suggestions.push(`📈 Momentum positif: ${improvingTokens.map((t) => t.symbol).join(", ")} — biarkan profit berjalan`);
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });

  const analysis: DailyAnalysis = {
    date: dateStr,
    generatedAt: now.toISOString(),
    reportCount: reports.length,
    periodStart: first.timestampWIB,
    periodEnd: last.timestampWIB,
    portfolio: {
      startValueUSD: first.portfolio.totalValueUSD,
      endValueUSD: last.portfolio.totalValueUSD,
      highValueUSD: highValue,
      lowValueUSD: lowValue,
      dailyPnlUSD,
      dailyPnlPct,
      avgPnlPct,
    },
    tokenTrends,
    marketAnalysis: {
      dominantSentiment,
      bullishHours,
      bearishHours,
      neutralHours,
      trendDirection,
    },
    predictions,
    optimizationSuggestions: suggestions,
  };

  // Save daily analysis
  const analysisDir = `${REPORT_DIR}/daily`;
  mkdirSync(analysisDir, { recursive: true });
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yyyy = now.getFullYear();
  const analysisFile = `${analysisDir}/${dd}${mm}${yyyy}_daily_analysis.json`;
  writeFileSync(analysisFile, JSON.stringify(analysis, null, 2));
  log(`📊 Daily analysis saved: ${dd}${mm}${yyyy}_daily_analysis.json`);

  // Delete the merged hourly reports to reset for next day
  for (const f of files) {
    try { unlinkSync(`${REPORT_DIR}/${f}`); } catch {}
  }
  log(`🗑️ Cleaned ${files.length} hourly reports after merge`);

  return analysis;
}

async function sendHourlyPnLReport(snapshots: Map<string, PriceSnapshot>) {
  if (cycleCount - lastHourlyReportCycle < HOURLY_CYCLES && lastHourlyReportCycle > 0) return;

  lastHourlyReportCycle = cycleCount;

  // Build detailed analysis report
  const report = buildHourlyReport(snapshots);

  // Save JSON report (always, regardless of Telegram)
  saveHourlyReportJSON(report);

  // Build Telegram message with analysis
  const canSendTG = !noTelegram && hasTelegramConfig();
  const lines: string[] = [];
  for (const t of report.tokens) {
    const pnlSign = t.pnlPct >= 0 ? "+" : "";
    const valueIdr = t.currentValueIDR;
    const valueStr = valueIdr >= 1_000_000
      ? `${(valueIdr / 1_000_000).toFixed(1)}jt`
      : valueIdr >= 1_000
        ? `${(valueIdr / 1_000).toFixed(0)}rb`
        : `${Math.round(valueIdr)}`;

    const emoji = t.pnlPct >= 5 ? "🟢" : t.pnlPct >= 0 ? "⚪" : "🔴";
    lines.push(`${emoji} <b>${t.symbol}</b> ${pnlSign}${t.pnlPct.toFixed(1)}% Rp${valueStr}`);
  }

  // Weekly target progress
  let targetLine = "";
  if (capitalBaseline.modalAwal > 0) {
    const progressPct = Math.min(100, Math.max(0, (report.portfolio.weeklyPnlPct / WEEKLY_PNL_TARGET) * 100));
    targetLine = `\n📊 Weekly: ${report.portfolio.weeklyPnlPct >= 0 ? "+" : ""}${report.portfolio.weeklyPnlPct.toFixed(1)}% / +${WEEKLY_PNL_TARGET}% target (${progressPct.toFixed(0)}%)`;
  }

  // Key insights for Telegram
  const insightsText = report.keyInsights.length > 0
    ? `\n\n🔍 <b>Analisis:</b>\n${report.keyInsights.join("\n")}` : "";

  // Top movers
  let moversText = "";
  if (report.topGainers.length > 0) moversText += `\n📈 Top: ${report.topGainers.join(", ")}`;
  if (report.topLosers.length > 0) moversText += `\n📉 Bot: ${report.topLosers.join(", ")}`;

  const msg =
    `📈 <b>Hourly P&amp;L Report</b>\n` +
    `🕐 ${report.timestampWIB} WIB | ${report.marketSentiment.toUpperCase()}\n\n` +
    lines.join("\n") +
    `\n\n💰 <b>Total: ${formatIDR(report.portfolio.totalValueUSD)}</b> (cost: ${formatIDR(report.portfolio.totalCostUSD)})` +
    `\n📊 P&amp;L: ${report.portfolio.totalPnlPct >= 0 ? "+" : ""}${report.portfolio.totalPnlPct.toFixed(1)}% ($${report.portfolio.totalPnlUSD.toFixed(2)})` +
    targetLine +
    moversText +
    insightsText +
    `\n\n💸 Pending: $${profitTracker.accumulatedProfitUSDT.toFixed(2)}`;

  if (canSendTG) {
    await sendTelegram(msg);
    log(`📨 Hourly P&L report sent to Telegram`);
  }

  // Check if we have 24 reports → merge for daily analysis
  const reportFiles = readdirSync(REPORT_DIR).filter((f) => f.endsWith("_report.json"));
  if (reportFiles.length >= MAX_HOURLY_REPORTS) {
    log(`📊 ${reportFiles.length} hourly reports accumulated — generating daily analysis...`);
    const dailyAnalysis = mergeDailyReports();
    if (dailyAnalysis) {
      // Send daily summary to Telegram
      const predLines = dailyAnalysis.predictions
        .map((p) => `${p.predictedDirection === "up" ? "📈" : p.predictedDirection === "down" ? "📉" : "➡️"} <b>${p.symbol}</b>: ${p.suggestedAction} (${p.confidence}) — ${p.reasoning.substring(0, 80)}`)
        .join("\n");

      const suggestLines = dailyAnalysis.optimizationSuggestions.join("\n");

      const dailyMsg =
        `📊 <b>DAILY ANALYSIS — ${dailyAnalysis.date}</b>\n` +
        `📅 ${dailyAnalysis.periodStart} → ${dailyAnalysis.periodEnd}\n` +
        `📈 Reports: ${dailyAnalysis.reportCount} | Sentiment: ${dailyAnalysis.marketAnalysis.dominantSentiment}\n\n` +
        `💰 <b>Portfolio Harian:</b>\n` +
        `Start: ${formatIDR(dailyAnalysis.portfolio.startValueUSD)} → End: ${formatIDR(dailyAnalysis.portfolio.endValueUSD)}\n` +
        `Daily P&amp;L: ${dailyAnalysis.portfolio.dailyPnlPct >= 0 ? "+" : ""}${dailyAnalysis.portfolio.dailyPnlPct.toFixed(2)}% ($${dailyAnalysis.portfolio.dailyPnlUSD.toFixed(2)})\n\n` +
        `🔮 <b>Prediksi &amp; Aksi:</b>\n${predLines}\n\n` +
        `💡 <b>Optimisasi P&amp;L:</b>\n${suggestLines}`;

      if (canSendTG) {
        await sendTelegram(dailyMsg);
        log(`📊 Daily analysis sent to Telegram`);
      }
    }
  }
}

function canAlert(symbol: string, type: keyof AlertState): boolean {
  const state = alertStates[symbol];
  if (!state) return true;
  const lastTime = state[type] ?? 0;
  return Date.now() - lastTime > ALERT_COOLDOWN_MS;
}

function markAlerted(symbol: string, type: keyof AlertState) {
  if (!alertStates[symbol]) {
    alertStates[symbol] = {
      lastBuyAlert: 0,
      lastSellAlert: 0,
      lastStopLossAlert: 0,
      lastPumpAlert: 0,
      lastDumpAlert: 0,
      lastAutoBuy: 0,
    };
  }
  alertStates[symbol][type] = Date.now();
}

// ─── On-Chain Balance Check ─────────────────────────────────────────
// ─── Wallet balance cache (TTL 20s) to avoid blocking execSync on every call ───
let walletBalanceCache: { data: Record<string, number>; ts: number } | null = null;
const WALLET_CACHE_TTL = 20_000;

function getCachedWalletBalances(force = false): Record<string, number> | null {
  const now = Date.now();
  if (!force && walletBalanceCache && now - walletBalanceCache.ts < WALLET_CACHE_TTL) {
    return walletBalanceCache.data;
  }
  try {
    const result = execSync(
      `${ONCHAINOS} wallet balance --chain 56 --force`,
      { timeout: 30000, encoding: "utf-8" }
    );
    const parsed = JSON.parse(result);
    if (!parsed.ok) return walletBalanceCache?.data ?? null;
    const balMap: Record<string, number> = {};
    for (const detail of parsed.data?.details ?? []) {
      for (const asset of detail.tokenAssets ?? []) {
        const addr = (asset.tokenAddress || "").toLowerCase();
        balMap[addr] = parseFloat(asset.balance) || 0;
        // also store by symbol as fallback
        if (asset.symbol) balMap[asset.symbol.toLowerCase()] = parseFloat(asset.balance) || 0;
      }
    }
    walletBalanceCache = { data: balMap, ts: now };
    return balMap;
  } catch (e: any) {
    log(`⚠ Wallet balance fetch failed: ${e.message?.split("\n")[0]}`);
    return walletBalanceCache?.data ?? null;
  }
}

function getOnChainBalance(tokenAddress: string): number | null {
  const balMap = getCachedWalletBalances();
  if (!balMap) return null;
  if (tokenAddress === "native") {
    return balMap["bnb"] ?? balMap[""] ?? null;
  }
  return balMap[tokenAddress.toLowerCase()] ?? null;
}

// Sync all token holdings from on-chain wallet at startup
function syncHoldingsFromChain(): void {
  log("🔄 Syncing holdings from on-chain wallet...");
  // Force-refresh cache on startup
  const balanceMap = getCachedWalletBalances(true);
  if (!balanceMap) { log("⚠ Holdings sync failed: could not fetch balance"); return; }

  for (const token of TOKENS) {
    const addr = token.address === "native" ? "" : token.address.toLowerCase();
    const symKey = token.symbol.toLowerCase();
    const key: string = addr in balanceMap ? addr : symKey;
    if (key in balanceMap) {
      const onChain = balanceMap[key];
      if (Math.abs(onChain - token.holdings) / Math.max(token.holdings, 0.0001) > 0.05) {
        log(`📊 ${token.symbol}: holdings ${token.holdings} → ${onChain} (synced from chain)`);
        token.holdings = onChain;
      }
    }
  }
  log("✅ Holdings sync complete");
}

// ─── Auto-Execute Swap ─────────────────────────────────────────────
async function executeSwap(
  token: TokenConfig,
  sellPct: number,
  reason: string,
  currentPrice?: number
): Promise<boolean> {
  if (!token.autoExecute) {
    log(`⚠ Auto-execute disabled for ${token.symbol}, skipping swap`);
    return false;
  }

  // Pre-flight: verify on-chain balance before swap
  const onChainBalance = getOnChainBalance(token.address);
  if (onChainBalance !== null && onChainBalance < 0.001) {
    log(`⚠ ${token.symbol} on-chain balance is ${onChainBalance} — near zero, skipping swap`);
    log(`📊 Syncing ${token.symbol} holdings: ${token.holdings} → ${onChainBalance}`);
    token.holdings = onChainBalance;
    await sendTelegram(
      `⚠ <b>${token.symbol} — Balance Mismatch</b>\n` +
      `On-chain: ${onChainBalance}\n` +
      `Config: ${token.holdings}\n` +
      `Holdings synced. Swap skipped.`
    );
    return false;
  }

  const effectiveHoldings = (onChainBalance !== null && onChainBalance < token.holdings)
    ? onChainBalance : token.holdings;
  const sellTokens = effectiveHoldings * sellPct / 100;
  const sellAmount = sellTokens.toFixed(token.decimals > 6 ? 8 : token.decimals);

  if (sellTokens < 0.001) {
    log(`⚠ ${token.symbol} sell amount too small (${sellAmount}), skipping swap`);
    return false;
  }

  // Calculate expected USDT received and profit portion
  const price = currentPrice ?? token.entryPrice;
  const expectedUSDT = sellTokens * price;
  const proportionalCost = token.entryCost * (sellPct / 100);
  const profitFromSell = Math.max(0, expectedUSDT - proportionalCost);

  log(`🔄 AUTO-SWAP: Selling ${sellPct}% of ${token.symbol} (${sellAmount}) → USDT [${reason}] | est. profit: $${profitFromSell.toFixed(4)}`);

  // ── PRE-SWAP SNAPSHOT: balance & price ──
  const preTokenBal = onChainBalance ?? effectiveHoldings;
  const preUsdtBal = getOnChainBalance(USDT_ADDRESS) ?? 0;
  const prePrice = price;
  const preValueUSD = preTokenBal * prePrice;
  log(`📋 PRE-SWAP  | ${token.symbol}: ${preTokenBal.toFixed(4)} @ $${prePrice.toFixed(6)} ($${preValueUSD.toFixed(2)}) | USDT: ${preUsdtBal.toFixed(2)}`);

  const SLIPPAGE_TIERS = (token.category === "moonshot" || token.category === "swing") ? [5, 8, 12] : [2.5, 5, 8];
  const MAX_RETRIES = SLIPPAGE_TIERS.length;
  const roundedAmount = Math.floor(parseFloat(sellAmount));
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const slippage = SLIPPAGE_TIERS[attempt - 1];
    const cmd = `${ONCHAINOS} swap execute` +
      ` --from ${token.address}` +
      ` --to ${USDT_ADDRESS}` +
      ` --readable-amount ${roundedAmount}` +
      ` --chain bsc` +
      ` --wallet ${WALLET_ADDRESS}` +
      ` --slippage ${slippage}`;
    try {
      if (attempt > 1) log(`🔁 ${token.symbol} sell retry #${attempt} with slippage ${slippage}%`);
      const swapResult = await execWithTimeout(cmd, 60000);
      if (!swapResult) throw new Error("swap_timeout");
      const parsed = JSON.parse(swapResult);

      if (parsed.ok || parsed.txHash) {
        // Invalidate wallet cache so post-swap reads fresh balance
        walletBalanceCache = null;
        const txHash =
          parsed.data?.swapTxHash ||
          parsed.txHash ||
          parsed.data?.txHash ||
          parsed.data?.orderId ||
          "pending";
        log(`✅ SWAP SUCCESS: ${token.symbol} → USDT | tx: ${txHash}${attempt > 1 ? ` (retry #${attempt - 1})` : ""}`);

        // ── POST-SWAP SNAPSHOT: wait for BSC confirmation before reading balance ──
        await new Promise((r) => setTimeout(r, 7000)); // BSC block time ~3s + buffer
        const postTokenBal = getOnChainBalance(token.address) ?? (effectiveHoldings - sellTokens);
        const postUsdtBal = getOnChainBalance(USDT_ADDRESS) ?? preUsdtBal;
        const actualReceived = postUsdtBal - preUsdtBal;
        const actualSold = preTokenBal - postTokenBal;
        log(`📋 POST-SWAP | ${token.symbol}: ${postTokenBal.toFixed(4)} (Δ -${actualSold.toFixed(4)}) | USDT: ${postUsdtBal.toFixed(2)} (Δ +${actualReceived.toFixed(2)})`);

        // Accumulate profit for weekly withdrawal
        if (profitFromSell > 0) {
          profitTracker.accumulatedProfitUSDT += profitFromSell;
          log(`💰 Profit accumulated: +$${profitFromSell.toFixed(4)} | Total pending: $${profitTracker.accumulatedProfitUSDT.toFixed(4)}`);
        }

        await sendTelegram(
          `✅ <b>AUTO-SWAP ${reason}</b>\n` +
          `${token.symbol}: Sold ${sellPct}% (${sellAmount} tokens)\n` +
          `→ USDT on BSC\n` +
          `\n📋 <b>Before:</b> ${preTokenBal.toFixed(4)} ${token.symbol} | ${preUsdtBal.toFixed(2)} USDT\n` +
          `📋 <b>After:</b> ${postTokenBal.toFixed(4)} ${token.symbol} | ${postUsdtBal.toFixed(2)} USDT\n` +
          `📊 Received: +${actualReceived.toFixed(2)} USDT\n` +
          `${profitFromSell > 0 ? `💰 Profit: $${profitFromSell.toFixed(2)} → pending withdrawal\n` : ""}` +
          `${attempt > 1 ? `🔁 Succeeded on retry #${attempt - 1}\n` : ""}` +
          `Tx: <code>${txHash}</code>`
        );

        // Update holdings from actual on-chain balance
        token.holdings = postTokenBal;
        token.entryCost = token.entryCost * (1 - sellPct / 100);
        return true;
      } else {
        log(`❌ SWAP FAILED: ${JSON.stringify(parsed).slice(0, 200)}`);
        await sendTelegramWith2Buttons(
          `❌ <b>SWAP FAILED — ${token.symbol}</b>\n` +
          `Reason: ${JSON.stringify(parsed).slice(0, 100)}\n` +
          `⚠ Manual action required!`,
          `🔄 Swap on PancakeSwap`,
          pancakeUrl(token.address, USDT_ADDRESS),
          `🔄 Swap on OKX DEX`,
          okxSwapUrl(token.address, USDT_ADDRESS)
        );
        return false;
      }
    } catch (e: any) {
      const errMsg = e.message?.split("\n")[0] || "Unknown error";

      // Retry with next slippage tier if attempts remain
      if (attempt < MAX_RETRIES) {
        log(`⚠ SWAP ERROR (attempt ${attempt}/${MAX_RETRIES}, slippage ${slippage}%): ${token.symbol} — ${errMsg}. Retrying with higher slippage...`);
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      // All retries exhausted
      log(`❌ SWAP ERROR after ${MAX_RETRIES} attempts: ${token.symbol} — ${errMsg}`);
      const freshBalance = getOnChainBalance(token.address);
      if (freshBalance !== null) {
        log(`📊 Auto-syncing ${token.symbol} holdings: ${token.holdings} → ${freshBalance}`);
        token.holdings = freshBalance;
      }
      await sendTelegramWith2Buttons(
        `❌ <b>SWAP ERROR — ${token.symbol}</b>\n` +
        `${errMsg}\n` +
        `Retried ${MAX_RETRIES - 1}x (slippage up to ${SLIPPAGE_TIERS[MAX_RETRIES - 1]}%), still failing.\n` +
        `⚠ Manual action needed!`,
        `🔄 Swap on PancakeSwap`,
        pancakeUrl(token.address, USDT_ADDRESS),
        `🔄 Swap on OKX DEX`,
        okxSwapUrl(token.address, USDT_ADDRESS)
      );
      return false;
    }
  }
  return false; // unreachable, satisfies TS
}

// ─── Auto DCA Buy (USDT → Token) ──────────────────────────────────
async function executeBuy(
  token: TokenConfig,
  usdtAmount: number,
  reason: string
): Promise<boolean> {
  const usdtBalance = getOnChainBalance(USDT_ADDRESS) ?? 0;
  const MIN_USDT_RESERVE = 3; // keep at least $3 USDT as reserve
  if (usdtBalance < usdtAmount + MIN_USDT_RESERVE) {
    log(`⚠ AUTO-BUY skip ${token.symbol}: USDT ${usdtBalance.toFixed(2)} < needed ${(usdtAmount + MIN_USDT_RESERVE).toFixed(2)}`);
    return false;
  }

  log(`🛒 AUTO-BUY: Spending ${usdtAmount} USDT → ${token.symbol} [${reason}] | USDT bal: ${usdtBalance.toFixed(2)}`);

  const preUsdtBal = usdtBalance;
  const preTokenBal = getOnChainBalance(token.address) ?? token.holdings;

  const SLIPPAGE_TIERS_BUY = (token.category === "moonshot" || token.category === "swing") ? [5, 8, 12] : [2.5, 5, 8];
  const MAX_RETRIES = SLIPPAGE_TIERS_BUY.length;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const slippage = SLIPPAGE_TIERS_BUY[attempt - 1];
    const cmd = `${ONCHAINOS} swap execute` +
      ` --from ${USDT_ADDRESS}` +
      ` --to ${token.address}` +
      ` --readable-amount ${usdtAmount.toFixed(2)}` +
      ` --chain bsc` +
      ` --wallet ${WALLET_ADDRESS}` +
      ` --slippage ${slippage}`;
    try {
      if (attempt > 1) log(`🔁 ${token.symbol} buy retry #${attempt} with slippage ${slippage}%`);
      const result = await execWithTimeout(cmd, 60000);
      if (!result) throw new Error("buy_timeout");
      const parsed = JSON.parse(result);

      if (parsed.ok || parsed.txHash) {
        walletBalanceCache = null;
        const txHash =
          parsed.data?.swapTxHash ||
          parsed.txHash ||
          parsed.data?.txHash ||
          parsed.data?.orderId ||
          "pending";
        log(`✅ AUTO-BUY SUCCESS: USDT → ${token.symbol} | tx: ${txHash}${attempt > 1 ? ` (retry #${attempt - 1})` : ""}`);

        await new Promise((r) => setTimeout(r, 7000)); // wait BSC confirmation
        const postTokenBal = getOnChainBalance(token.address) ?? (preTokenBal + usdtAmount / token.entryPrice);
        const postUsdtBal = getOnChainBalance(USDT_ADDRESS) ?? (preUsdtBal - usdtAmount);
        const tokenReceived = postTokenBal - preTokenBal;
        log(`📋 POST-BUY  | ${token.symbol}: ${postTokenBal.toFixed(4)} (Δ +${tokenReceived.toFixed(4)}) | USDT: ${postUsdtBal.toFixed(2)} (Δ -${(preUsdtBal - postUsdtBal).toFixed(2)})`);

        // Sync holdings with on-chain value
        token.holdings = postTokenBal;
        token.entryCost += usdtAmount;

        await sendTelegram(
          `🛒 <b>AUTO-BUY DCA — ${token.symbol}</b>\n` +
          `Spent: $${usdtAmount} USDT\n` +
          `Received: ~${tokenReceived.toFixed(4)} ${token.symbol}\n` +
          `Reason: ${reason}\n` +
          `\n📋 <b>Before:</b> ${preTokenBal.toFixed(4)} ${token.symbol} | ${preUsdtBal.toFixed(2)} USDT\n` +
          `📋 <b>After:</b> ${postTokenBal.toFixed(4)} ${token.symbol} | ${postUsdtBal.toFixed(2)} USDT\n` +
          `${attempt > 1 ? `🔁 Succeeded on retry #${attempt - 1}\n` : ""}` +
          `Tx: <code>${txHash}</code>`
        );
        return true;
      } else {
        log(`❌ AUTO-BUY FAILED: ${JSON.stringify(parsed).slice(0, 200)}`);
        if (attempt === MAX_RETRIES) {
          await sendTelegramWith2Buttons(
            `❌ <b>AUTO-BUY FAILED — ${token.symbol}</b>\n` +
            `${JSON.stringify(parsed).slice(0, 100)}\n` +
            `⚠ Buy manual jika mau DCA`,
            `🔵 Buy on PancakeSwap`,
            pancakeUrl(USDT_ADDRESS, token.address),
            `🔵 Buy on OKX DEX`,
            okxSwapUrl(USDT_ADDRESS, token.address)
          );
        }
        return false;
      }
    } catch (e: any) {
      const errMsg = e.message?.split("\n")[0] || "Unknown error";
      if (attempt < MAX_RETRIES) {
        log(`⚠ AUTO-BUY transient error (attempt ${attempt}/${MAX_RETRIES}): ${token.symbol} — ${errMsg}. Retrying...`);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      log(`❌ AUTO-BUY ERROR: ${token.symbol} — ${errMsg}`);
      await sendTelegramWith2Buttons(
        `❌ <b>AUTO-BUY ERROR — ${token.symbol}</b>\n${errMsg}\n⚠ Buy manual jika mau DCA`,
        `🔵 Buy on PancakeSwap`,
        pancakeUrl(USDT_ADDRESS, token.address),
        `🔵 Buy on OKX DEX`,
        okxSwapUrl(USDT_ADDRESS, token.address)
      );
      return false;
    }
  }
  return false;
}



// ─── Trailing Stop-Loss Update ─────────────────────────────────────
function updateTrailingStop(token: TokenConfig, price: number) {
  const ts = trailingStates[token.symbol];
  if (!ts || token.trailingStopPct <= 0) return;

  if (price > ts.peakPrice) {
    ts.peakPrice = price;
    ts.trailingStop = price * (1 - token.trailingStopPct / 100);
    log(`📈 ${token.symbol} new peak ${formatPrice(price)} → trailing stop ${formatPrice(ts.trailingStop)}`);
  }
}

// ─── Market Context Footer Builder ─────────────────────────────────
// Returns 1-3 lines of market context for SELL/STOP/PUMP alerts
function buildMarketCtx(token: TokenConfig, snap: PriceSnapshot): string {
  const lines: string[] = [];

  // Volume 1H + txs1H
  if (snap.volume1H > 0) {
    const vol1Hfmt = snap.volume1H >= 1_000_000
      ? `$${(snap.volume1H / 1_000_000).toFixed(2)}M`
      : snap.volume1H >= 1_000
      ? `$${(snap.volume1H / 1_000).toFixed(1)}K`
      : `$${snap.volume1H.toFixed(0)}`;
    const txPart = snap.txs1H > 0 ? ` | ${snap.txs1H}tx` : "";
    lines.push(`📊 Vol 1H: ${vol1Hfmt}${txPart} | Block: ${snap.txs5M}tx/5min`);
  }

  // Market cap + holders
  const mcPart = snap.marketCap > 0
    ? `MC: $${snap.marketCap >= 1_000_000 ? (snap.marketCap / 1_000_000).toFixed(1) + "M" : snap.marketCap.toFixed(0)}`
    : "";
  const holdersPart = snap.holders > 0
    ? ` | ${snap.holders >= 1_000_000 ? (snap.holders / 1_000_000).toFixed(1) + "M" : snap.holders >= 1_000 ? (snap.holders / 1_000).toFixed(0) + "K" : snap.holders} holders`
    : "";
  if (mcPart || holdersPart) lines.push(`🏛 ${mcPart}${holdersPart}`);

  // Buy pressure
  const bp = buyPressureCache.get(token.symbol);
  if (bp) {
    const pressureEmoji = bp.buyPct >= 65 ? "🟢" : bp.buyPct <= 35 ? "🔴" : "⚪";
    lines.push(`${pressureEmoji} Buy pressure: ${bp.buyPct.toFixed(0)}% (${bp.buyCount}B/${bp.sellCount}S dari 50 trade)`);
  }

  // Best swap route
  const route = swapRouteCache.get(token.symbol);
  if (route) {
    lines.push(`🔀 Route: ${route.routeSummary} | Impact: ${route.priceImpact}`);
  }

  // Liquidity pool
  const pool = liquidityPoolCache.get(token.symbol);
  if (pool) {
    const poolLiqFmt = pool.poolLiquidityUSD >= 1_000_000
      ? `$${(pool.poolLiquidityUSD / 1_000_000).toFixed(2)}M`
      : `$${(pool.poolLiquidityUSD / 1_000).toFixed(1)}K`;
    lines.push(`💧 Pool: ${pool.topPool} | Liq: ${poolLiqFmt}`);
  }

  return lines.length > 0 ? "\n" + lines.join("\n") : "";
}

// ─── Alert Logic (with auto-execute & trailing stops) ──────────────
async function checkAlerts(token: TokenConfig, snap: PriceSnapshot) {
  const pnlPct = ((snap.price - token.entryPrice) / token.entryPrice) * 100;
  const currentValue = snap.price * token.holdings;
  const ts = trailingStates[token.symbol];

  // Update trailing stop
  updateTrailingStop(token, snap.price);

  // Skip stablecoins
  if (token.category === "stablecoin") return;

  // 🔴 STOP LOSS (fixed -5%)
  if (snap.price <= token.stopLoss && canAlert(token.symbol, "lastStopLossAlert")) {
    markAlerted(token.symbol, "lastStopLossAlert");
    log(`🔴 STOP LOSS ${token.symbol} @ ${formatPrice(snap.price)} (entry: ${formatPrice(token.entryPrice)})`);

    // Auto-execute: sell 100% at stop-loss
    const _stopCtx = buildMarketCtx(token, snap);
    if (token.autoExecute) {
      await sendTelegram(
        `🔴 <b>STOP LOSS HIT — ${token.symbol}</b>\n` +
        `Price: ${formatPrice(snap.price)} (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
        `Value: ${formatIDR(currentValue)}\n` +
        `🤖 Auto-selling 100%...` + _stopCtx
      );
      await executeSwap(token, 100, "STOP-LOSS", snap.price);
    } else {
      await sendTelegramWith2Buttons(
        `🔴 <b>STOP LOSS — ${token.symbol}</b>\n` +
        `Price: ${formatPrice(snap.price)} (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
        `Value: ${formatIDR(currentValue)} / Entry: ${formatIDR(token.entryCost)}\n` +
        `⚡ Manual sell recommended!` + _stopCtx,
        `🔴 Sell on PancakeSwap`,
        pancakeUrl(token.address, USDT_ADDRESS),
        `🔴 Sell on OKX DEX`,
        okxSwapUrl(token.address, USDT_ADDRESS)
      );
    }
    return; // Don't check other targets after stop-loss
  }

  // 📉 TRAILING STOP (dynamic, from peak)
  if (ts && ts.trailingStop > token.stopLoss && snap.price <= ts.trailingStop && snap.price > token.stopLoss) {
    if (canAlert(token.symbol, "lastStopLossAlert")) {
      markAlerted(token.symbol, "lastStopLossAlert");
      const dropFromPeak = ((ts.peakPrice - snap.price) / ts.peakPrice * 100).toFixed(1);
      log(`📉 TRAILING STOP ${token.symbol} @ ${formatPrice(snap.price)} (peak was ${formatPrice(ts.peakPrice)}, -${dropFromPeak}%)`);

      const _trailCtx = buildMarketCtx(token, snap);
      if (token.autoExecute) {
        await sendTelegram(
          `📉 <b>TRAILING STOP — ${token.symbol}</b>\n` +
          `Price: ${formatPrice(snap.price)} (peak: ${formatPrice(ts.peakPrice)}, -${dropFromPeak}%)\n` +
          `🤖 Auto-selling 100%...` + _trailCtx
        );
        await executeSwap(token, 100, `TRAILING-STOP (peak ${formatPrice(ts.peakPrice)})`, snap.price);
      } else {
        await sendTelegramWith2Buttons(
          `📉 <b>TRAILING STOP — ${token.symbol}</b>\n` +
          `Price dropped ${dropFromPeak}% from peak ${formatPrice(ts.peakPrice)}\n` +
          `⚠ Manual sell recommended!` + _trailCtx,
          `📉 Sell on PancakeSwap`,
          pancakeUrl(token.address, USDT_ADDRESS),
          `📉 Sell on OKX DEX`,
          okxSwapUrl(token.address, USDT_ADDRESS)
        );
      }
      return;
    }
  }

  // 🟢 TIERED SELL TARGETS (partial take-profit)
  // Target 1: +3% → sell 30%
  if (ts && !ts.sold1 && snap.price >= token.sellTarget1 && canAlert(token.symbol, "lastSellAlert")) {
    ts.sold1 = true;
    markAlerted(token.symbol, "lastSellAlert");
    log(`🟢 TARGET-1 (+3%) ${token.symbol} @ ${formatPrice(snap.price)}`);

    const _t1Ctx = buildMarketCtx(token, snap);
    if (token.autoExecute) {
      await sendTelegram(
        `🟢 <b>TARGET 1 (+3%) — ${token.symbol}</b>\n` +
        `Price: ${formatPrice(snap.price)} (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
        `🤖 Auto-selling 30%...` + _t1Ctx
      );
      const ok = await executeSwap(token, 30, "TARGET-1 (+3%)", snap.price);
      if (!ok) { ts.sold1 = false; log(`⚠ Rolled back sold1 for ${token.symbol} — will retry next cycle`); }
    } else {
      await sendTelegramWith2Buttons(
        `🟢 <b>TARGET 1 (+3%) — ${token.symbol}</b>\n` +
        `Sell 30% now for safe profit.` + _t1Ctx,
        `🟢 Sell on PancakeSwap`,
        pancakeUrl(token.address, USDT_ADDRESS),
        `🟢 Sell on OKX DEX`,
        okxSwapUrl(token.address, USDT_ADDRESS)
      );
    }
  }

  // Target 2: +7% → sell 30% more
  if (ts && !ts.sold2 && snap.price >= token.sellTarget2 && canAlert(token.symbol, "lastSellAlert")) {
    ts.sold2 = true;
    markAlerted(token.symbol, "lastSellAlert");
    log(`🟢 TARGET-2 (+7%) ${token.symbol} @ ${formatPrice(snap.price)}`);

    const _t2Ctx = buildMarketCtx(token, snap);
    if (token.autoExecute) {
      await sendTelegram(
        `🟡 <b>TARGET 2 (+7%) — ${token.symbol}</b>\n` +
        `Price: ${formatPrice(snap.price)} (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
        `🤖 Auto-selling 30% more...` + _t2Ctx
      );
      const ok = await executeSwap(token, 30, "TARGET-2 (+7%)", snap.price);
      if (!ok) { ts.sold2 = false; log(`⚠ Rolled back sold2 for ${token.symbol} — will retry next cycle`); }
    } else {
      await sendTelegramWith2Buttons(
        `🟡 <b>TARGET 2 (+7%) — ${token.symbol}</b>\n` +
        `Sell 30% more.` + _t2Ctx,
        `🟡 Sell on PancakeSwap`,
        pancakeUrl(token.address, USDT_ADDRESS),
        `🟡 Sell on OKX DEX`,
        okxSwapUrl(token.address, USDT_ADDRESS)
      );
    }
  }

  // Target 3: +12% → sell remaining
  if (ts && !ts.sold3 && snap.price >= token.sellTarget3 && canAlert(token.symbol, "lastSellAlert")) {
    ts.sold3 = true;
    markAlerted(token.symbol, "lastSellAlert");
    log(`🟢 TARGET-3 (+12%) ${token.symbol} @ ${formatPrice(snap.price)}`);

    const _t3Ctx = buildMarketCtx(token, snap);
    if (token.autoExecute) {
      await sendTelegram(
        `🏆 <b>TARGET 3 (+12%) — ${token.symbol}</b>\n` +
        `Price: ${formatPrice(snap.price)} (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
        `🤖 Auto-selling remaining position!` + _t3Ctx
      );
      const ok = await executeSwap(token, 100, "TARGET-3 (+12%) FULL EXIT", snap.price);
      if (!ok) { ts.sold3 = false; log(`⚠ Rolled back sold3 for ${token.symbol} — will retry next cycle`); }
    } else {
      await sendTelegramWith2Buttons(
        `🏆 <b>TARGET 3 (+12%) — ${token.symbol}</b>\n` +
        `Full exit recommended!` + _t3Ctx,
        `🏆 Sell on PancakeSwap`,
        pancakeUrl(token.address, USDT_ADDRESS),
        `🏆 Sell on OKX DEX`,
        okxSwapUrl(token.address, USDT_ADDRESS)
      );
    }
  }

  // 🔵 BUY ZONE (DCA opportunity)
  if (snap.price <= token.buyZone && canAlert(token.symbol, "lastBuyAlert")) {
    markAlerted(token.symbol, "lastBuyAlert");

    if (token.autoExecute) {
      // Check 6-hour auto-buy cooldown independently of alert cooldown
      const autoBuyState = alertStates[token.symbol];
      const lastAutoBuy = autoBuyState?.lastAutoBuy ?? 0;
      const canDca = Date.now() - lastAutoBuy > AUTO_BUY_COOLDOWN_MS;

      if (canDca) {
        if (!autoBuyState) markAlerted(token.symbol, "lastBuyAlert"); // ensure state exists
        alertStates[token.symbol].lastAutoBuy = Date.now();
        await sendTelegram(
          `🔵 <b>BUY ZONE — ${token.symbol}</b>\n` +
          `Price: ${formatPrice(snap.price)} (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
          `Buy zone: &lt; ${formatPrice(token.buyZone)}\n` +
          `🤖 Auto-DCA: buying $${DCA_BUY_USD} USDT worth...`
        );
        log(`🔵 AUTO-BUY ZONE ${token.symbol} @ ${formatPrice(snap.price)} — DCA $${DCA_BUY_USD}`);
        await executeBuy(token, DCA_BUY_USD, `BUY ZONE DCA @ ${formatPrice(snap.price)}`);
      } else {
        const hoursLeft = ((AUTO_BUY_COOLDOWN_MS - (Date.now() - lastAutoBuy)) / 3_600_000).toFixed(1);
        log(`🔵 BUY ZONE ${token.symbol} @ ${formatPrice(snap.price)} — auto-buy cooldown (${hoursLeft}h left)`);
      }
    } else {
      await sendTelegramWith2Buttons(
        `🔵 <b>BUY ZONE — ${token.symbol}</b>\n` +
        `Price: ${formatPrice(snap.price)} (${pnlPct > 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
        `Buy zone: &lt; ${formatPrice(token.buyZone)}\n` +
        `💡 DCA opportunity — tambah posisi manual.`,
        `🔵 Buy on PancakeSwap`,
        pancakeUrl(USDT_ADDRESS, token.address),
        `🔵 Buy on OKX DEX`,
        okxSwapUrl(USDT_ADDRESS, token.address)
      );
      log(`🔵 BUY ZONE ${token.symbol} @ ${formatPrice(snap.price)}`);  
    }
  }

  // 🚀 PUMP: >5% dalam 1 jam
  if (snap.change1H >= 5 && canAlert(token.symbol, "lastPumpAlert")) {
    markAlerted(token.symbol, "lastPumpAlert");
    const _pumpCtx = buildMarketCtx(token, snap);
    await sendTelegram(
      `🚀 <b>PUMP +${snap.change1H.toFixed(1)}% (1H) — ${token.symbol}</b>\n` +
      `Price: ${formatPrice(snap.price)}\n` +
      `Consider partial take-profit.` + _pumpCtx
    );
    log(`🚀 PUMP ${token.symbol} +${snap.change1H.toFixed(1)}% (1H)`);
  }

  // 💥 DUMP: < -5% dalam 1 jam
  if (snap.change1H <= -5 && canAlert(token.symbol, "lastDumpAlert")) {
    markAlerted(token.symbol, "lastDumpAlert");
    const _dumpCtx = buildMarketCtx(token, snap);
    await sendTelegram(
      `💥 <b>DUMP ${snap.change1H.toFixed(1)}% (1H) — ${token.symbol}</b>\n` +
      `Price: ${formatPrice(snap.price)}\n` +
      `⚠ Trailing stop active at ${formatPrice(ts?.trailingStop ?? token.stopLoss)}` + _dumpCtx
    );
    log(`💥 DUMP ${token.symbol} ${snap.change1H.toFixed(1)}% (1H)`);
  }
}

// ─── Modal Awal (Capital Baseline) ─────────────────────────────────
// Hitung total portfolio value dari semua token holdings × harga saat ini
function calcTotalPortfolioValue(snapshots: Map<string, PriceSnapshot>): number {
  let total = 0;
  for (const token of TOKENS) {
    const snap = snapshots.get(token.symbol);
    if (snap) {
      total += snap.price * token.holdings;
    } else {
      // Fallback: gunakan entry price jika harga tidak tersedia
      total += token.entryPrice * token.holdings;
    }
  }
  return total;
}

// Snapshot modal awal: dipanggil setelah withdrawal atau setiap Senin
function snapshotModalAwal(snapshots: Map<string, PriceSnapshot>, reason: string) {
  const totalValue = calcTotalPortfolioValue(snapshots);
  capitalBaseline.modalAwal = totalValue;
  capitalBaseline.setAt = Date.now();
  capitalBaseline.setReason = reason;
  if (reason === "monday-reset") {
    capitalBaseline.lastMondayReset = new Date().toISOString().split("T")[0];
  }
  log(`📊 Modal Awal di-set: $${totalValue.toFixed(2)} (${formatIDR(totalValue)}) [${reason}]`);
}

// Cek apakah hari ini Senin dan belum di-reset minggu ini
function checkMondayReset(snapshots: Map<string, PriceSnapshot>) {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Jakarta" }));
  if (now.getDay() !== 1) return; // Bukan Senin → skip

  const todayStr = now.toISOString().split("T")[0];
  if (capitalBaseline.lastMondayReset === todayStr) return; // Sudah reset hari ini → skip

  snapshotModalAwal(snapshots, "monday-reset");
}

// ─── Weekly Profit Withdrawal ──────────────────────────────────────
const WEEK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
const MIN_WITHDRAWAL_USDT = 0.5; // minimum $0.50 to avoid dust transfers
const WEEKLY_PNL_TARGET = 15; // target +15% weekly P&L dari modal awal

async function checkWeeklyWithdrawal(snapshots: Map<string, PriceSnapshot>) {
  const now = Date.now();
  const elapsed = now - profitTracker.lastWithdrawalTime;

  if (elapsed < WEEK_MS) {
    // Not yet time — log days remaining
    const daysLeft = ((WEEK_MS - elapsed) / (24 * 60 * 60 * 1000)).toFixed(1);
    if (cycleCount % 60 === 0) { // log once per hour
      const pnlPct = capitalBaseline.modalAwal > 0
        ? ((calcTotalPortfolioValue(snapshots) - capitalBaseline.modalAwal) / capitalBaseline.modalAwal * 100).toFixed(1)
        : "?";
      log(`📅 Next withdrawal in ${daysLeft} days | Weekly P&L: ${pnlPct}% / target ${WEEKLY_PNL_TARGET}% | Pending: $${profitTracker.accumulatedProfitUSDT.toFixed(4)}`);
    }
    return;
  }

  // Week has passed — check if weekly P&L target reached
  if (capitalBaseline.modalAwal > 0) {
    const totalValue = calcTotalPortfolioValue(snapshots);
    const weeklyPnlPct = ((totalValue - capitalBaseline.modalAwal) / capitalBaseline.modalAwal) * 100;

    if (weeklyPnlPct < WEEKLY_PNL_TARGET) {
      log(`📅 Weekly check: P&L ${weeklyPnlPct.toFixed(1)}% < target ${WEEKLY_PNL_TARGET}% — no withdrawal, timer reset`);
      profitTracker.lastWithdrawalTime = now; // Reset timer, try again next week
      return;
    }

    // Target reached! Withdraw the profit above modal awal (the +15% gain)
    const profitAboveBaseline = totalValue - capitalBaseline.modalAwal;
    // Use whichever is smaller: accumulated sell profit or portfolio gain above baseline
    const withdrawableAmount = Math.min(profitTracker.accumulatedProfitUSDT, profitAboveBaseline);

    if (withdrawableAmount < MIN_WITHDRAWAL_USDT) {
      log(`📅 Weekly P&L ${weeklyPnlPct.toFixed(1)}% ≥ ${WEEKLY_PNL_TARGET}% but only $${withdrawableAmount.toFixed(4)} withdrawable (min $${MIN_WITHDRAWAL_USDT}), skipping`);
      profitTracker.lastWithdrawalTime = now;
      return;
    }

    log(`🎯 WEEKLY TARGET HIT! P&L: +${weeklyPnlPct.toFixed(1)}% ≥ ${WEEKLY_PNL_TARGET}% — withdrawing $${withdrawableAmount.toFixed(2)}`);
    await withdrawProfit(snapshots, withdrawableAmount);
    return;
  }

  // Fallback: no modal awal set, use old logic (accumulated profit)
  if (profitTracker.accumulatedProfitUSDT < MIN_WITHDRAWAL_USDT) {
    log(`📅 Weekly withdrawal check: only $${profitTracker.accumulatedProfitUSDT.toFixed(4)} pending (min $${MIN_WITHDRAWAL_USDT}), skipping`);
    profitTracker.lastWithdrawalTime = now;
    return;
  }

  await withdrawProfit(snapshots);
}

async function withdrawProfit(snapshots: Map<string, PriceSnapshot>, overrideAmount?: number) {
  const amount = overrideAmount ?? profitTracker.accumulatedProfitUSDT;
  const amountStr = amount.toFixed(6);

  // ── PRE-WITHDRAWAL SNAPSHOT: USDT balance ──
  const preUsdtBal = getOnChainBalance(USDT_ADDRESS) ?? 0;
  log(`💸 WEEKLY WITHDRAWAL: Sending $${amountStr} USDT to profit wallet ${PROFIT_WALLET}`);
  log(`📋 PRE-WITHDRAW  | USDT: ${preUsdtBal.toFixed(2)}`);

  try {
    const cmd = `${ONCHAINOS} wallet send` +
      ` --receipt ${PROFIT_WALLET}` +
      ` --contract-token ${USDT_ADDRESS}` +
      ` --readable-amount ${amountStr}` +
      ` --chain 56` +
      ` --from ${WALLET_ADDRESS}` +
      ` --force`;

    const result = execSync(cmd, { timeout: 60000, encoding: "utf-8" });
    const parsed = JSON.parse(result);

    if (parsed.ok || parsed.txHash || parsed.data?.txHash) {
      const txHash = parsed.txHash || parsed.data?.txHash || "pending";
      const dateStr = new Date().toISOString().split("T")[0];

      // ── POST-WITHDRAWAL SNAPSHOT: USDT balance ──
      const postUsdtBal = getOnChainBalance(USDT_ADDRESS) ?? (preUsdtBal - amount);
      const actualSent = preUsdtBal - postUsdtBal;
      log(`✅ WITHDRAWAL SUCCESS: $${amountStr} USDT → ${PROFIT_WALLET} | tx: ${txHash}`);
      log(`📋 POST-WITHDRAW | USDT: ${postUsdtBal.toFixed(2)} (Δ -${actualSent.toFixed(2)})`);

      profitTracker.totalWithdrawn += amount;
      profitTracker.withdrawalHistory.push({ date: dateStr, amount, txHash });
      // Keep only last 52 withdrawal records (~1 year)
      if (profitTracker.withdrawalHistory.length > 52) {
        profitTracker.withdrawalHistory = profitTracker.withdrawalHistory.slice(-52);
      }
      profitTracker.accumulatedProfitUSDT = Math.max(0, profitTracker.accumulatedProfitUSDT - amount);
      profitTracker.lastWithdrawalTime = Date.now();

      // Snapshot modal awal setelah profit ditransfer
      snapshotModalAwal(snapshots, "withdrawal");

      await sendTelegram(
        `💸 <b>WEEKLY PROFIT WITHDRAWAL</b>\n` +
        `Amount: $${amountStr} USDT (${formatIDR(amount)})\n` +
        `To: <code>${PROFIT_WALLET}</code>\n` +
        `\n📋 <b>Before:</b> ${preUsdtBal.toFixed(2)} USDT\n` +
        `📋 <b>After:</b> ${postUsdtBal.toFixed(2)} USDT\n` +
        `📊 Sent: -${actualSent.toFixed(2)} USDT\n` +
        `Total withdrawn: $${profitTracker.totalWithdrawn.toFixed(2)}\n` +
        `📊 Modal Awal baru: $${capitalBaseline.modalAwal.toFixed(2)} (${formatIDR(capitalBaseline.modalAwal)})\n` +
        `Tx: <code>${txHash}</code>`
      );
    } else {
      log(`❌ WITHDRAWAL FAILED: ${JSON.stringify(parsed).slice(0, 200)}`);
      // Don't reset — will retry next cycle
      await sendTelegram(
        `❌ <b>WITHDRAWAL FAILED</b>\n` +
        `Amount: $${amountStr} USDT\n` +
        `To: <code>${PROFIT_WALLET}</code>\n` +
        `Error: ${JSON.stringify(parsed).slice(0, 100)}\n` +
        `⚠ Will retry next cycle`
      );
    }
  } catch (e: any) {
    log(`❌ WITHDRAWAL ERROR: ${e.message?.split("\n")[0]}`);
    await sendTelegram(
      `❌ <b>WITHDRAWAL ERROR</b>\n` +
      `$${amountStr} USDT → ${PROFIT_WALLET}\n` +
      `${e.message?.split("\n")[0]}\n` +
      `⚠ Will retry next cycle`
    );
  }
}

// ─── Dashboard Display ─────────────────────────────────────────────
function printDashboard(snapshots: Map<string, PriceSnapshot>) {
  const now = new Date();
  const ts = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

  console.clear();
  console.log(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║${C.reset}  ${C.bold}LasbonBSCbot${C.reset} — BSC Token Monitor          ${C.dim}Cycle #${cycleCount} | ${ts} WIB${C.reset}  ${C.bold}${C.cyan}║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╠══════════════════════════════════════════════════════════════════════════╣${C.reset}`);

  // Header
  console.log(
    `${C.bold} ${"Token".padEnd(8)} ${"Price".padEnd(14)} ${"1H".padEnd(8)} ${"4H".padEnd(8)} ${"24H".padEnd(8)} ` +
    `${"P&L".padEnd(10)} ${"Value (IDR)".padEnd(14)} ${"Signal".padEnd(10)}${C.reset}`
  );
  console.log(`${C.dim}${"─".repeat(76)}${C.reset}`);

  let totalValue = 0;
  let totalCost = 0;

  for (const token of TOKENS) {
    const snap = snapshots.get(token.symbol);
    if (!snap) {
      console.log(`${C.dim} ${token.symbol.padEnd(8)} -- offline --${C.reset}`);
      continue;
    }

    const pnlPct = ((snap.price - token.entryPrice) / token.entryPrice) * 100;
    const currentValue = snap.price * token.holdings;
    const pnlUSD = currentValue - token.entryCost;
    totalValue += currentValue;
    totalCost += token.entryCost;

    // Determine signal (with trailing stop + tiered targets)
    let signal = "";
    const ts = trailingStates[token.symbol];
    if (token.category === "stablecoin") {
      signal = `${C.dim} STBL ${C.reset}`;
    } else if (snap.price <= token.stopLoss) {
      signal = `${C.bgRed}${C.white} STOP ${C.reset}`;
    } else if (ts && ts.trailingStop > token.stopLoss && snap.price <= ts.trailingStop) {
      signal = `${C.bgRed}${C.white} TRAIL${C.reset}`;
    } else if (ts && ts.sold3) {
      signal = `${C.bgGreen}${C.white} DONE ${C.reset}`;
    } else if (snap.price >= token.sellTarget3) {
      signal = `${C.bgGreen}${C.white} T3 🏆${C.reset}`;
    } else if (snap.price >= token.sellTarget2) {
      signal = `${C.green}${C.bold} T2   ${C.reset}`;
    } else if (snap.price >= token.sellTarget1) {
      signal = `${C.green} T1   ${C.reset}`;
    } else if (snap.price <= token.buyZone) {
      signal = `${C.blue}${C.bold} BUY  ${C.reset}`;
    } else {
      signal = `${C.dim} HOLD ${C.reset}`;
    }

    const pnlStr = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%`;
    const valueStr = formatIDR(currentValue);

    console.log(
      ` ${C.bold}${token.symbol.padEnd(8)}${C.reset}` +
      `${formatPrice(snap.price).padEnd(14)}` +
      `${pctColor(snap.change1H)}${(snap.change1H >= 0 ? "+" : "") + snap.change1H.toFixed(1) + "%"}${C.reset}`.padEnd(20) +
      `${pctColor(snap.change4H)}${(snap.change4H >= 0 ? "+" : "") + snap.change4H.toFixed(1) + "%"}${C.reset}`.padEnd(20) +
      `${pctColor(snap.change24H)}${(snap.change24H >= 0 ? "+" : "") + snap.change24H.toFixed(1) + "%"}${C.reset}`.padEnd(20) +
      `${pctColor(pnlPct)}${pnlStr}${C.reset}`.padEnd(22) +
      `${valueStr.padEnd(14)}` +
      `${signal}`
    );
  }

  const totalPnl = totalValue - totalCost;
  const totalPnlPct = ((totalValue - totalCost) / totalCost) * 100;

  console.log(`${C.dim}${"─".repeat(76)}${C.reset}`);
  console.log(
    `${C.bold} TOTAL${C.reset}`.padEnd(42) +
    `${pctColor(totalPnlPct)}${totalPnl >= 0 ? "+" : ""}${totalPnlPct.toFixed(1)}%${C.reset}`.padEnd(22) +
    `${C.bold}${formatIDR(totalValue)}${C.reset}`.padEnd(14) +
    `${C.dim}cost: ${formatIDR(totalCost)}${C.reset}`
  );

  console.log(`${C.bold}${C.cyan}╠══════════════════════════════════════════════════════════════════════════╣${C.reset}`);
  console.log(`${C.bold}${C.cyan}║${C.reset} ${C.dim}Zones:${C.reset} ` +
    `${C.blue}BUY${C.reset}=buy zone  ` +
    `${C.green}T1${C.reset}=+5%  ` +
    `${C.green}T2${C.reset}=+10%  ` +
    `${C.green}T3${C.reset}=+15%  ` +
    `${C.red}STOP${C.reset}=-5%  ` +
    `${C.red}TRAIL${C.reset}=trailing  ` +
    `       ${C.bold}${C.cyan}║${C.reset}`
  );
  console.log(`${C.bold}${C.cyan}║${C.reset} ${C.dim}Interval: ${intervalSec}s | Telegram: ${noTelegram ? "OFF" : "ON"} | Ctrl+C to stop${C.reset}`.padEnd(85) + `${C.bold}${C.cyan}║${C.reset}`);

  // Profit withdrawal info
  const daysUntilWithdraw = Math.max(0, (WEEK_MS - (Date.now() - profitTracker.lastWithdrawalTime)) / (24 * 60 * 60 * 1000));
  const profitLine = `💰 Pending: $${profitTracker.accumulatedProfitUSDT.toFixed(2)} | Withdrawn: $${profitTracker.totalWithdrawn.toFixed(2)} | Next: ${daysUntilWithdraw.toFixed(1)}d`;
  console.log(`${C.bold}${C.cyan}║${C.reset} ${C.yellow}${profitLine}${C.reset}`.padEnd(85) + `${C.bold}${C.cyan}║${C.reset}`);

  // Modal Awal (Capital Baseline) info
  if (capitalBaseline.modalAwal > 0) {
    const weeklyPnl = totalValue - capitalBaseline.modalAwal;
    const weeklyPnlPct = (weeklyPnl / capitalBaseline.modalAwal) * 100;
    const pnlColor = weeklyPnlPct >= WEEKLY_PNL_TARGET ? C.green : weeklyPnl >= 0 ? C.yellow : C.red;
    const targetUsd = capitalBaseline.modalAwal * WEEKLY_PNL_TARGET / 100;
    const progressPct = Math.min(100, Math.max(0, (weeklyPnlPct / WEEKLY_PNL_TARGET) * 100));
    const barLen = 10;
    const filled = Math.round(barLen * progressPct / 100);
    const bar = "█".repeat(filled) + "░".repeat(barLen - filled);
    const targetStatus = weeklyPnlPct >= WEEKLY_PNL_TARGET ? `${C.green}✅ TARGET HIT${C.reset}` : `${progressPct.toFixed(0)}%`;
    const baselineDate = new Date(capitalBaseline.setAt).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta" });
    const modalLine = `📊 Modal: ${formatIDR(capitalBaseline.modalAwal)} | P&L: ${pnlColor}${weeklyPnl >= 0 ? "+" : ""}${weeklyPnlPct.toFixed(1)}%${C.reset} | Target: +${WEEKLY_PNL_TARGET}% [${bar}] ${targetStatus}`;
    console.log(`${C.bold}${C.cyan}║${C.reset} ${modalLine}`.padEnd(85) + `${C.bold}${C.cyan}║${C.reset}`);
    const detailLine = `   Need: $${targetUsd.toFixed(2)} gain | Got: $${weeklyPnl.toFixed(2)} | ${baselineDate} [${capitalBaseline.setReason}]`;
    console.log(`${C.bold}${C.cyan}║${C.reset} ${C.dim}${detailLine}${C.reset}`.padEnd(85) + `${C.bold}${C.cyan}║${C.reset}`);
  }

  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════════════════════════╝${C.reset}`);

  // Per-token detail section
  console.log();
  for (const token of TOKENS) {
    const snap = snapshots.get(token.symbol);
    if (!snap) continue;
    const range24 = snap.high24H > 0 && snap.low24H > 0
      ? `${formatPrice(snap.low24H)} — ${formatPrice(snap.high24H)}`
      : "N/A";
    const liqIdr = snap.liquidity * USD_TO_IDR;
    const liqStr = liqIdr >= 1_000_000_000
      ? `Rp${(liqIdr / 1_000_000_000).toFixed(1)}M`
      : liqIdr >= 1_000_000
        ? `Rp${(liqIdr / 1_000_000).toFixed(1)}jt`
        : `Rp${(liqIdr / 1_000).toFixed(0)}rb`;
    const volIdr = snap.volume24H * USD_TO_IDR;
    const volStr = volIdr >= 1_000_000_000
      ? `Rp${(volIdr / 1_000_000_000).toFixed(1)}M`
      : volIdr >= 1_000_000
        ? `Rp${(volIdr / 1_000_000).toFixed(1)}jt`
        : `Rp${(volIdr / 1_000).toFixed(0)}rb`;

    console.log(
      `${C.dim}  ${token.symbol}: Range[${range24}] Vol24h[${volStr}] Liq[${liqStr}] Txs24h[${snap.txs24H}] ${token.category.toUpperCase()}${C.reset}`
    );
  }
}

// ─── Main Loop ─────────────────────────────────────────────────────
async function runCycle() {
  cycleCount++;
  const snapshots = new Map<string, PriceSnapshot>();

  // ── Fetch all token prices sequentially async (non-blocking, 200ms gap anti-throttle)
  for (const token of TOKENS) {
    const snap = await fetchPriceInfo(token);
    if (snap) {
      snapshots.set(token.symbol, snap);
      if (!priceHistory[token.symbol]) priceHistory[token.symbol] = [];
      priceHistory[token.symbol].push(snap);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  // ── Refresh buy/sell pressure every 5 cycles (parallel across tokens)
  const buyPressureTasks: Promise<void>[] = [];
  for (let i = 0; i < TOKENS.length; i++) {
    const token = TOKENS[i];
    if ((cycleCount + i) % BUY_PRESSURE_INTERVAL === 0) {
      buyPressureTasks.push(fetchBuySellPressure(token));
    }
  }
  if (buyPressureTasks.length > 0) await Promise.allSettled(buyPressureTasks);

  // ── Refresh swap route cache only for tokens with actual SELL/STOP signal
  const swapRouteTasks: Promise<void>[] = [];
  for (const token of TOKENS) {
    const snap = snapshots.get(token.symbol);
    if (!snap) continue;
    const sig = getSignal(token, snap);
    const entry = swapRouteCache.get(token.symbol);
    const needsRefresh = !entry || (cycleCount - entry.updatedAtCycle) >= SWAP_ROUTE_INTERVAL;
    // Only fetch when token actually signals sell — not on first-cycle !entry for all tokens
    if (needsRefresh && (sig.startsWith("SELL") || sig === "TRAILING_STOP" || sig === "STOP_LOSS")) {
      swapRouteTasks.push(fetchSwapRouteForToken(token, snap));
    }
  }
  if (swapRouteTasks.length > 0) await Promise.allSettled(swapRouteTasks);

  // ── Refresh liquidity pool cache every LIQUIDITY_POOL_INTERVAL cycles (staggered)
  for (let i = 0; i < TOKENS.length; i++) {
    const token = TOKENS[i];
    const entry = liquidityPoolCache.get(token.symbol);
    const needsRefresh = !entry || (cycleCount - entry.updatedAtCycle) >= LIQUIDITY_POOL_INTERVAL;
    if (needsRefresh && (cycleCount + i) % LIQUIDITY_POOL_INTERVAL === 0) {
      await fetchLiquidityPool(token);
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  // Print dashboard
  printDashboard(snapshots);

  // Save JSON snapshots to token portfolio
  for (const token of TOKENS) {
    const snap = snapshots.get(token.symbol);
    if (snap) saveTokenSnapshot(token, snap);
  }

  // Upload snapshots to MySQL (token_info DB)
  for (const token of TOKENS) {
    const snap = snapshots.get(token.symbol);
    if (snap) await uploadSnapshotToMySQL(token, snap);
  }

  // Check alerts for each token
  for (const token of TOKENS) {
    const snap = snapshots.get(token.symbol);
    if (snap) await checkAlerts(token, snap);
  }

  // Execute seed swaps (zero-balance tokens >1 day → auto buy 1 USDT)
  await executeSeedSwaps();

  // Hourly P&L Telegram report
  await sendHourlyPnLReport(snapshots);

  // Check weekly profit withdrawal
  await checkWeeklyWithdrawal(snapshots);

  // Check Monday reset for modal awal
  checkMondayReset(snapshots);

  // Set initial modal awal if not yet set (first run)
  if (capitalBaseline.modalAwal === 0 && snapshots.size > 0) {
    snapshotModalAwal(snapshots, "initial");
  }

  saveState();
}

async function main() {
  log("═══ LasbonBSCbot started ═══");
  log(`Monitoring: ${TOKENS.map((t) => t.symbol).join(", ")}`);
  log(`Interval: ${intervalSec}s | Telegram: ${noTelegram ? "OFF" : "ON"}`);

  loadState();

  // Sync holdings from on-chain wallet before starting
  syncHoldingsFromChain();

  // Startup notification
  if (!noTelegram && hasTelegramConfig()) {
    await sendTelegram(
      `🤖 <b>LasbonBSCbot Started</b>\n` +
      `Monitoring: ${TOKENS.map((t) => t.symbol).join(", ")}\n` +
      `Interval: ${intervalSec}s\n` +
      `💸 Weekly profit → <code>${PROFIT_WALLET}</code>\n` +
      `Pending: $${profitTracker.accumulatedProfitUSDT.toFixed(2)} | Withdrawn: $${profitTracker.totalWithdrawn.toFixed(2)}`
    );
  }

  // Run first cycle
  await runCycle();

  if (onceMode) {
    log("═══ Single run complete ═══");
    process.exit(0);
  }

  // Continuous loop
  const interval = setInterval(async () => {
    try {
      await runCycle();
    } catch (e: any) {
      log(`⚠ Cycle error: ${e.message}`);
    }
  }, intervalSec * 1000);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    clearInterval(interval);
    log("═══ LasbonBSCbot stopped ═══");
    if (!noTelegram && hasTelegramConfig()) {
      await sendTelegram("🛑 <b>LasbonBSCbot stopped</b>");
    }
    saveState();
    await mysqlPool.end().catch(() => {});
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    clearInterval(interval);
    saveState();
    await mysqlPool.end().catch(() => {});
    process.exit(0);
  });
}

main().catch((err) => {
  log(`Fatal: ${err.message}`);
  process.exit(1);
});
