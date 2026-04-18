import { config, hasOkxCredentials } from "./config.js";

function fail(message: string): never {
  throw new Error(message);
}

function ensureBigInt(value: string, key: string) {
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n) {
      fail(`${key} must be > 0`);
    }
    return parsed;
  } catch {
    fail(`${key} must be a valid integer string`);
  }
}

function runPreflight() {
  const summary: Record<string, string | number | boolean> = {
    liveStage: config.LIVE_STAGE,
    dryRun: config.DRY_RUN,
    executionProvider: config.EXECUTION_PROVIDER,
    hasOkxDexCredentials: hasOkxCredentials(),
    hasTelegramConfig: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID)
  };

  if (config.LIVE_STAGE === "dry-run") {
    if (!config.DRY_RUN) {
      fail("LIVE_STAGE=dry-run requires DRY_RUN=true");
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "dry-run",
          message: "Dry-run mode is active. No real transaction execution will be sent.",
          summary
        },
        null,
        2
      )
    );
    return;
  }

  if (config.DRY_RUN) {
    fail(`LIVE_STAGE=${config.LIVE_STAGE} requires DRY_RUN=false`);
  }

  const maxBuy = ensureBigInt(config.MAX_BUY_AMOUNT, "MAX_BUY_AMOUNT");
  const maxSell = ensureBigInt(config.MAX_SELL_AMOUNT, "MAX_SELL_AMOUNT");
  const defaultBuy = ensureBigInt(config.DEFAULT_BUY_AMOUNT, "DEFAULT_BUY_AMOUNT");
  const defaultSell = ensureBigInt(config.DEFAULT_SELL_AMOUNT, "DEFAULT_SELL_AMOUNT");

  if (defaultBuy > maxBuy) {
    fail("DEFAULT_BUY_AMOUNT must be <= MAX_BUY_AMOUNT");
  }

  if (defaultSell > maxSell) {
    fail("DEFAULT_SELL_AMOUNT must be <= MAX_SELL_AMOUNT");
  }

  if (config.MAX_CONFIDENCE_TO_EXECUTE > 0.8) {
    fail("MAX_CONFIDENCE_TO_EXECUTE should be <= 0.8 for live execution");
  }

  if (config.EXECUTION_PROVIDER === "local-wallet") {
    if (!config.EXECUTION_WALLET_PRIVATE_KEY || !config.EVM_RPC_URL) {
      fail("local-wallet mode requires EXECUTION_WALLET_PRIVATE_KEY and EVM_RPC_URL");
    }
  } else if (!config.OKX_AGENTIC_WALLET_EXECUTE_URL || !config.OKX_AGENTIC_WALLET_API_KEY || !config.OKX_AGENTIC_WALLET_ID) {
    fail("okx-agentic-wallet mode requires OKX_AGENTIC_WALLET_EXECUTE_URL, OKX_AGENTIC_WALLET_API_KEY, and OKX_AGENTIC_WALLET_ID");
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: config.LIVE_STAGE,
        message: "Live preflight checks passed.",
        summary: {
          ...summary,
          maxBuyAmount: config.MAX_BUY_AMOUNT,
          maxSellAmount: config.MAX_SELL_AMOUNT,
          defaultBuyAmount: config.DEFAULT_BUY_AMOUNT,
          defaultSellAmount: config.DEFAULT_SELL_AMOUNT,
          maxConfidenceToExecute: config.MAX_CONFIDENCE_TO_EXECUTE
        }
      },
      null,
      2
    )
  );
}

runPreflight();
