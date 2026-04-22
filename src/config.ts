import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const XRPL_WALLET_FILE = path.join(ROOT_DIR, "secrets", "xrpl-wallet.json");

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  SCHEDULE_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true")
    .default("true"),
  SCHEDULE_INTERVAL_MINUTES: z.coerce.number().default(5),
  LIVE_STAGE: z.enum(["dry-run", "canary", "full"]).default("dry-run"),
  DRY_RUN: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  ONCHAINOS_BIN: z.string().optional().default(""),
  ONCHAINOS_ROUTER_PREFERENCE: z.string().optional().default("lifi"),
  ONCHAINOS_ROUTER_STRICT: z
    .string()
    .optional()
    .transform((value) => value === "true")
    .default("false"),
  EXECUTION_PROVIDER: z.enum(["local-wallet", "okx-agentic-wallet", "onchainos"]).default("okx-agentic-wallet"),
  OPENAI_API_KEY: z.string().default("ollama"),
  OPENAI_BASE_URL: z.string().url().default("http://127.0.0.1:11435/v1"),
  OPENAI_MODEL: z.string().default("lasbonai-trading"),
  BOT_UV_THREADPOOL_SIZE: z.string().optional().default("16"),
  BOT_GPU_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true")
    .default("false"),
  OKX_DEX_BASE_URL: z.string().url().default("https://web3.okx.com"),
  OKX_DISABLE_DIRECT_API: z
    .string()
    .optional()
    .transform((value) => value === "true")
    .default("false"),
  OKX_ACCESS_KEY: z.string().optional().default(""),
  OKX_SECRET_KEY: z.string().optional().default(""),
  OKX_PASSPHRASE: z.string().optional().default(""),
  OKX_PROJECT_ID: z.string().optional().default(""),
  EXECUTION_WALLET_PRIVATE_KEY: z.string().optional().default(""),
  EXECUTION_WALLET_ADDRESS: z.string().optional().default(""),
  EVM_RPC_URL: z.string().optional().default(""),
  OKX_AGENTIC_WALLET_EXECUTE_URL: z.string().optional().default(""),
  OKX_AGENTIC_WALLET_API_KEY: z.string().optional().default(""),
  OKX_AGENTIC_WALLET_ID: z.string().optional().default(""),
  OKX_AGENTIC_SUB_WALLET_ID: z.string().optional().default(""),
  XRPL_NATIVE_EXECUTE_URL: z.string().optional().default(""),
  XRPL_NATIVE_EXECUTE_API_KEY: z.string().optional().default(""),
  XRPL_NATIVE_EXECUTE_WALLET: z.string().optional().default(""),
  XRPL_NATIVE_EXECUTE_TIMEOUT_MS: z.coerce.number().int().positive().default(25000),
  XRPL_NATIVE_EXECUTE_MOCK_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true")
    .default("false"),
  XRPL_NATIVE_EXECUTE_ALLOWED_HOSTS: z.string().optional().default(""),
  DEFAULT_CHAIN_ID: z.string().optional().default("1"),
  DEFAULT_BASE_TOKEN_ADDRESS: z.string().optional().default(""),
  DEFAULT_QUOTE_TOKEN_ADDRESS: z.string().optional().default(""),
  DEFAULT_BUY_AMOUNT: z.string().optional().default(""),
  DEFAULT_SELL_AMOUNT: z.string().optional().default(""),
  DEFAULT_SLIPPAGE: z.string().optional().default("0.3"),
  DEFAULT_MARKET_CONTEXT: z.string().optional().default("Automated 5-minute scan for conservative opportunities."),
  BASELINE_MIN_NOTIONAL_USD: z.coerce.number().default(10),
  BASELINE_MAX_PRICE_IMPACT_PCT: z.coerce.number().default(0.5),
  MIN_CONFIDENCE_TO_EXECUTE: z.coerce.number().default(0.50),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  TELEGRAM_USERNAME: z.string().optional().default("@lasbon_88"),
  CANDIDATE_SCAN_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false")
    .default("true"),
  CANDIDATE_NOTIFY_ONLY_WHEN_FOUND: z
    .string()
    .optional()
    .transform((value) => value !== "false")
    .default("true"),
  CANDIDATE_CHAIN: z.string().default("bnb"),
  CANDIDATE_ALLOWLIST_ADDRESSES: z.string().optional().default(""),
  CANDIDATE_ALLOWLIST_FALLBACK_TO_TOP: z
    .string()
    .optional()
    .transform((value) => value !== "false")
    .default("true"),
  CANDIDATE_RISK_FILTER: z
    .string()
    .optional()
    .transform((value) => value !== "false")
    .default("false"),
  CANDIDATE_STABLE_FILTER: z
    .string()
    .optional()
    .transform((value) => value !== "false")
    .default("false"),
  CANDIDATE_LIMIT: z.coerce.number().default(10),
  CANDIDATE_HOLDERS_MIN: z.coerce.number().default(500000),
  CANDIDATE_LIQ_MIN_IDR: z.coerce.number().default(10000000),
  CANDIDATE_MC_MIN_IDR: z.coerce.number().default(10000000000000),
  CANDIDATE_FDV_MIN_IDR: z.coerce.number().default(0),
  CANDIDATE_AUTO_RELAX_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false")
    .default("true"),
  CANDIDATE_RELAX_HOLDERS_MIN: z.coerce.number().default(100000),
  CANDIDATE_RELAX_MC_MIN_IDR: z.coerce.number().default(340000000000),
  CANDIDATE_RELAX_FDV_MIN_IDR: z.coerce.number().default(0),
  CANDIDATE_FX_USD_TO_IDR: z.coerce.number().default(0),
  CANDIDATE_REQUIRE_EXPLICIT_FDV: z
    .string()
    .optional()
    .transform((value) => value === "true")
    .default("false"),
  CANDIDATE_SCAN_MAX_ATTEMPTS: z.coerce.number().default(3),
  CANDIDATE_SCAN_RETRY_DELAY_MS: z.coerce.number().default(10000),
  CANDIDATE_HISTORY_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false")
    .default("true"),
  CANDIDATE_HISTORY_KEEP: z.coerce.number().default(576),
  MAX_CONFIDENCE_TO_EXECUTE: z.coerce.number().default(0.65), // DEPRECATED: Use MIN_CONFIDENCE_TO_EXECUTE instead
  MAX_BUY_AMOUNT: z.string().optional().default(""),
  MAX_SELL_AMOUNT: z.string().optional().default(""),
  MAX_POSITION_USD: z.coerce.number().default(150),
  TAKE_PROFIT_PCT: z.coerce.number().default(6),
  STOP_LOSS_PCT: z.coerce.number().default(15),
  COOLDOWN_SAME_DIRECTION_MIN: z.coerce.number().default(15),
  SELL_PORTION_PCT: z.coerce.number().default(50),
  MIN_QUOTE_BALANCE_USD: z.coerce.number().default(10),

  // Sentiment analysis
  SENTIMENT_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true")
    .default("false"),
  SENTIMENT_CHANNEL_URL: z.string().optional().default("https://t.me/kaptencrypto707"),
  SENTIMENT_CHANNEL_URLS: z.string().optional().default(""),
  SENTIMENT_THRESHOLD: z.coerce.number().default(70),
  SENTIMENT_SCRAPE_LIMIT: z.coerce.number().default(50),
  SENTIMENT_MAX_POSITION_USD: z.coerce.number().default(15),

  // Wallet Pattern Analysis — on-chain smart wallet intelligence
  WALLET_PATTERN_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false")
    .default("true"),
  WALLET_PATTERN_SCAN_CYCLES: z.coerce.number().default(10),
  WALLET_PATTERN_LOOKBACK_BLOCKS: z.coerce.number().default(2000),
  WALLET_PATTERN_MIN_PNL_PCT: z.coerce.number().default(15),
  WALLET_PATTERN_RPC_URLS: z.string().optional().default("https://1rpc.io/bnb,https://bsc-dataseed.bnbchain.org"),
  WALLET_PATTERN_TRACK_WALLET: z.string().optional().default(""),
  BSCSCAN_API_KEY: z.string().optional().default(""),

  // Google OAuth – MCP default gateway client ID
  GOOGLE_CLIENT_ID: z.string().default("204421016317-9fnkralojtes0u7lv0skua2spnm9j3u8.apps.googleusercontent.com")
});

export const config = envSchema.parse(process.env);

export function hasOkxCredentials() {
  // Passphrase is optional; API key + secret are sufficient for some endpoints
  // Full authentication requires all three, but fallback to onchainos CLI works without it
  return Boolean(config.OKX_ACCESS_KEY && config.OKX_SECRET_KEY);
}

export function assertOkxCredentials() {
  if (hasOkxCredentials()) {
    return;
  }

  const missing = [
    ["OKX_ACCESS_KEY", config.OKX_ACCESS_KEY],
    ["OKX_SECRET_KEY", config.OKX_SECRET_KEY],
    ["OKX_PASSPHRASE", config.OKX_PASSPHRASE]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(`Missing OKX credentials: ${missing.map(([key]) => key).join(", ")}`);
  }
}

export function assertExecutionReady() {
  if (config.DRY_RUN) {
    return;
  }

  if (config.LIVE_STAGE === "dry-run") {
    throw new Error("LIVE_STAGE must be canary or full when DRY_RUN=false");
  }

  const riskMissing = [
    ["MAX_BUY_AMOUNT", config.MAX_BUY_AMOUNT],
    ["MAX_SELL_AMOUNT", config.MAX_SELL_AMOUNT]
  ].filter(([, value]) => !value);

  if (riskMissing.length > 0) {
    throw new Error(`Missing live risk guardrails: ${riskMissing.map(([key]) => key).join(", ")}`);
  }

  let missing: string[][] = [];
  if (config.EXECUTION_PROVIDER === "local-wallet") {
    missing = [
      ["EXECUTION_WALLET_PRIVATE_KEY", config.EXECUTION_WALLET_PRIVATE_KEY],
      ["EVM_RPC_URL", config.EVM_RPC_URL]
    ].filter(([, value]) => !value);
  } else if (config.EXECUTION_PROVIDER === "okx-agentic-wallet") {
    missing = [
      ["OKX_AGENTIC_WALLET_EXECUTE_URL", config.OKX_AGENTIC_WALLET_EXECUTE_URL],
      ["OKX_AGENTIC_WALLET_API_KEY", config.OKX_AGENTIC_WALLET_API_KEY],
      ["OKX_AGENTIC_WALLET_ID", config.OKX_AGENTIC_WALLET_ID]
    ].filter(([, value]) => !value);
  }
  // onchainos provider uses CLI auth — no extra keys needed

  if (missing.length > 0) {
    throw new Error(`Missing execution config: ${missing.map(([key]) => key).join(", ")}`);
  }
}

export function hasXrplNativeExecutorConfig() {
  return Boolean(config.XRPL_NATIVE_EXECUTE_URL);
}

export function getXrplNativeExecutionWallet() {
  if (config.XRPL_NATIVE_EXECUTE_WALLET) {
    return config.XRPL_NATIVE_EXECUTE_WALLET;
  }

  try {
    const raw = fs.readFileSync(XRPL_WALLET_FILE, "utf8");
    const parsed = JSON.parse(raw) as { classicAddress?: string };
    return parsed.classicAddress?.trim() ?? "";
  } catch {
    return "";
  }
}

export function getXrplNativeAllowedHosts() {
  return config.XRPL_NATIVE_EXECUTE_ALLOWED_HOSTS
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function getXrplExecutorUrlHost() {
  try {
    return new URL(config.XRPL_NATIVE_EXECUTE_URL).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function assertXrplNativeExecutionReady() {
  if (config.DRY_RUN) {
    throw new Error("DRY_RUN masih true. Set DRY_RUN=false untuk XRPL live execution.");
  }

  if (config.LIVE_STAGE === "dry-run") {
    throw new Error("LIVE_STAGE harus canary/full untuk XRPL live execution.");
  }

  if (!config.XRPL_NATIVE_EXECUTE_URL) {
    throw new Error("Missing XRPL execution config: XRPL_NATIVE_EXECUTE_URL");
  }

  if (config.LIVE_STAGE === "full" && config.XRPL_NATIVE_EXECUTE_MOCK_ENABLED) {
    throw new Error("LIVE_STAGE=full tidak boleh memakai XRPL mock executor.");
  }

  if (config.LIVE_STAGE === "full") {
    const allowedHosts = getXrplNativeAllowedHosts();
    if (allowedHosts.length === 0) {
      throw new Error("LIVE_STAGE=full membutuhkan XRPL_NATIVE_EXECUTE_ALLOWED_HOSTS.");
    }

    const executorHost = getXrplExecutorUrlHost();
    if (!executorHost) {
      throw new Error("XRPL_NATIVE_EXECUTE_URL tidak valid (host tidak dapat diparse).");
    }

    if (!allowedHosts.includes(executorHost)) {
      throw new Error(
        `XRPL executor host '${executorHost}' tidak ada di XRPL_NATIVE_EXECUTE_ALLOWED_HOSTS.`,
      );
    }
  }
}

export function hasTelegramConfig() {
  return Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID);
}

export function getScheduledRequest() {
  const missing = [
    ["DEFAULT_CHAIN_ID", config.DEFAULT_CHAIN_ID],
    ["EXECUTION_WALLET_ADDRESS", config.EXECUTION_WALLET_ADDRESS],
    ["DEFAULT_BASE_TOKEN_ADDRESS", config.DEFAULT_BASE_TOKEN_ADDRESS],
    ["DEFAULT_QUOTE_TOKEN_ADDRESS", config.DEFAULT_QUOTE_TOKEN_ADDRESS],
    ["DEFAULT_BUY_AMOUNT", config.DEFAULT_BUY_AMOUNT],
    ["DEFAULT_SELL_AMOUNT", config.DEFAULT_SELL_AMOUNT]
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    throw new Error(`Missing scheduled bot config: ${missing.map(([key]) => key).join(", ")}`);
  }

  return {
    chainId: config.DEFAULT_CHAIN_ID,
    walletAddress: config.EXECUTION_WALLET_ADDRESS,
    baseTokenAddress: config.DEFAULT_BASE_TOKEN_ADDRESS,
    quoteTokenAddress: config.DEFAULT_QUOTE_TOKEN_ADDRESS,
    buyAmount: config.DEFAULT_BUY_AMOUNT,
    sellAmount: config.DEFAULT_SELL_AMOUNT,
    slippage: config.DEFAULT_SLIPPAGE,
    marketContext: config.DEFAULT_MARKET_CONTEXT
  };
}

export function getCandidateAllowlistSet() {
  const values = config.CANDIDATE_ALLOWLIST_ADDRESSES.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.startsWith("0x") && value.length > 10);

  return new Set(values);
}