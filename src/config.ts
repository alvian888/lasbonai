import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

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
  EXECUTION_PROVIDER: z.enum(["local-wallet", "okx-agentic-wallet", "onchainos"]).default("okx-agentic-wallet"),
  OPENAI_API_KEY: z.string().default("ollama"),
  OPENAI_BASE_URL: z.string().url().default("http://127.0.0.1:11435/v1"),
  OPENAI_MODEL: z.string().default("rahmatginanjar120/lasbonai:latest"),
  OKX_DEX_BASE_URL: z.string().url().default("https://web3.okx.com"),
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
  DEFAULT_CHAIN_ID: z.string().optional().default("1"),
  DEFAULT_BASE_TOKEN_ADDRESS: z.string().optional().default(""),
  DEFAULT_QUOTE_TOKEN_ADDRESS: z.string().optional().default(""),
  DEFAULT_BUY_AMOUNT: z.string().optional().default(""),
  DEFAULT_SELL_AMOUNT: z.string().optional().default(""),
  DEFAULT_SLIPPAGE: z.string().optional().default("0.5"),
  DEFAULT_MARKET_CONTEXT: z.string().optional().default("Automated 5-minute scan for conservative opportunities."),
  BASELINE_MIN_NOTIONAL_USD: z.coerce.number().default(25),
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
  MAX_CONFIDENCE_TO_EXECUTE: z.coerce.number().default(0.65),
  MAX_BUY_AMOUNT: z.string().optional().default(""),
  MAX_SELL_AMOUNT: z.string().optional().default(""),
  MAX_POSITION_USD: z.coerce.number().default(60),
  TAKE_PROFIT_PCT: z.coerce.number().default(10),
  STOP_LOSS_PCT: z.coerce.number().default(15),
  COOLDOWN_SAME_DIRECTION_MIN: z.coerce.number().default(15),
  SELL_PORTION_PCT: z.coerce.number().default(50),

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

  // Google OAuth – MCP default gateway client ID
  GOOGLE_CLIENT_ID: z.string().default("204421016317-9fnkralojtes0u7lv0skua2spnm9j3u8.apps.googleusercontent.com")
});

export const config = envSchema.parse(process.env);

export function hasOkxCredentials() {
  return Boolean(config.OKX_ACCESS_KEY && config.OKX_SECRET_KEY && config.OKX_PASSPHRASE);
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