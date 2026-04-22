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

async function checkOpenAiModel() {
  const baseUrl = config.OPENAI_BASE_URL.replace(/\/+$/u, "");
  const modelListUrl = baseUrl.endsWith("/v1") ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (config.OPENAI_API_KEY) {
    headers.Authorization = `Bearer ${config.OPENAI_API_KEY}`;
  }

  const response = await fetch(modelListUrl, { method: "GET", headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    fail(`AI model endpoint check failed: ${response.status} ${response.statusText} - ${body.slice(0, 200)}`);
  }

  const payload = await response.json().catch(() => null);
  if (!payload || !Array.isArray(payload.data)) {
    fail(`AI model endpoint returned unexpected payload from ${modelListUrl}`);
  }

  const modelIds = payload.data
    .map((item: Record<string, unknown>) => (typeof item.id === "string" ? item.id : ""))
    .filter((id: string) => id.length > 0);

  const modelTarget = config.OPENAI_MODEL.replace(/:latest$/u, "");
  const found = modelIds.some((id: string) => id === config.OPENAI_MODEL || id === `${modelTarget}:latest` || id.replace(/:latest$/u, "") === modelTarget);
  if (!found) {
    fail(`OPENAI_MODEL=${config.OPENAI_MODEL} is not available from ${modelListUrl}. Available models: ${modelIds.slice(0, 10).join(", ")}`);
  }

  return modelIds;
}

async function runPreflight() {
  const summary: Record<string, string | number | boolean> = {
    liveStage: config.LIVE_STAGE,
    dryRun: config.DRY_RUN,
    executionProvider: config.EXECUTION_PROVIDER,
    hasOkxDexCredentials: hasOkxCredentials(),
    hasTelegramConfig: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID),
    openAiBaseUrl: config.OPENAI_BASE_URL,
    openAiModel: config.OPENAI_MODEL
  };

  const availableModels = await checkOpenAiModel();
  summary.openAiModelAvailable = availableModels.includes(config.OPENAI_MODEL);

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
  } else if (config.EXECUTION_PROVIDER === "okx-agentic-wallet") {
    if (!config.OKX_AGENTIC_WALLET_EXECUTE_URL || !config.OKX_AGENTIC_WALLET_API_KEY || !config.OKX_AGENTIC_WALLET_ID) {
      fail("okx-agentic-wallet mode requires OKX_AGENTIC_WALLET_EXECUTE_URL, OKX_AGENTIC_WALLET_API_KEY, and OKX_AGENTIC_WALLET_ID");
    }
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
