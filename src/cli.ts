import "./initialize.js";
import { config } from "./config.js";
import { AgenticTradingBot } from "./bot.js";

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function getArgValue(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }

  return process.argv[index + 1];
}

async function main() {
  const command = process.argv[2] ?? "run";

  if (command !== "run") {
    throw new Error(`Unknown command: ${command}`);
  }

  const bot = new AgenticTradingBot();
  const result = await bot.run({
    chainId: config.DEFAULT_CHAIN_ID,
    walletAddress: config.EXECUTION_WALLET_ADDRESS,
    baseTokenAddress: config.DEFAULT_BASE_TOKEN_ADDRESS,
    quoteTokenAddress: config.DEFAULT_QUOTE_TOKEN_ADDRESS,
    buyAmount: config.DEFAULT_BUY_AMOUNT,
    sellAmount: config.DEFAULT_SELL_AMOUNT,
    slippage: config.DEFAULT_SLIPPAGE,
    marketContext: getArgValue("--market-context"),
    rsi: getArgValue("--rsi") ? Number(getArgValue("--rsi")) : undefined,
    macd: getArgValue("--macd") ? Number(getArgValue("--macd")) : undefined,
    macdSignal: getArgValue("--macd-signal") ? Number(getArgValue("--macd-signal")) : undefined,
    emaFast: getArgValue("--ema-fast") ? Number(getArgValue("--ema-fast")) : undefined,
    emaSlow: getArgValue("--ema-slow") ? Number(getArgValue("--ema-slow")) : undefined
  });

  const preferredAmount = result.decision.preferredAmount ? ` preferredAmount=${result.decision.preferredAmount}` : "";
  console.error(
    `[cli] decision=${result.decision.action} conf=${result.decision.confidence.toFixed(2)} source=${result.decisionSource ?? "unknown"}${preferredAmount}`
  );
  if (result.decision.riskNotes?.length) {
    console.error(`[cli] riskNotes=${result.decision.riskNotes.join("; ")}`);
  }

  console.log(JSON.stringify(result, jsonReplacer, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});