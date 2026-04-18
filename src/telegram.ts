import { config, hasTelegramConfig } from "./config.js";
import type { CandidateScanResult } from "./candidate-scan.js";
import type { BotRunResult } from "./types.js";

function toMonospaceJson(value: unknown) {
  return `<pre>${JSON.stringify(value, null, 2)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")}</pre>`;
}

export function formatTelegramMessage(result: BotRunResult) {
  const lines = [
    `<b>OKX Agentic Bot</b>`,
    `Mode: ${result.dryRun ? "dry-run" : "live"}`,
    `Decision: ${result.decision.action.toUpperCase()} (${result.decision.confidence.toFixed(2)})`,
    `Source: ${result.decisionSource ?? "unknown"}`,
    `Chain: ${result.request.chainId}`,
    `Reason: ${result.decision.reasoning}`
  ];

  if (result.position) {
    lines.push(
      `Position: XPL $${result.position.baseTokenValueUsd.toFixed(2)} | USDT $${result.position.quoteTokenBalance.toFixed(2)} | P&amp;L ${result.position.unrealizedPnlPct.toFixed(1)}%`
    );
  }

  if (result.decision.riskNotes.length > 0) {
    lines.push(`Risk: ${result.decision.riskNotes.join(" | ")}`);
  }

  if (result.execution?.txHash) {
    lines.push(`Tx: ${result.execution.txHash}`);
  }

  return lines.join("\n");
}

export function formatCandidateTelegramMessage(result: CandidateScanResult) {
  const lines = [
    "<b>BEP20 Candidate Scan</b>",
    `Count: ${result.count}`,
    `Mode: ${result.mode}`,
    `Chain: ${result.chain}`,
    `Min holders: ${result.thresholds.holdersMin.toLocaleString("en-US")}`,
    `Min liquidity: ${result.thresholds.liquidityMinIdr.toLocaleString("id-ID")} IDR (~${result.thresholds.liquidityMinUsd} USD)`,
    `Min market cap: ${result.thresholds.marketCapMinIdr.toLocaleString("id-ID")} IDR (~${result.thresholds.marketCapMinUsd} USD)`,
    `Min FDV: ${result.thresholds.fdvMinIdr.toLocaleString("id-ID")} IDR (~${result.thresholds.fdvMinUsd} USD)`
  ];

  for (const token of result.tokens.slice(0, 10)) {
    lines.push(
      `#${token.rank} ${token.symbol} | price=${token.priceUsd.toFixed(6)} | holders=${token.holders.toLocaleString("en-US")} | liq=${token.liquidityUsd.toFixed(0)} | mcap=${token.marketCapUsdOkx.toFixed(0)} | fdv_cg=${token.fdvUsdCoinGecko ?? "n/a"}`
    );
  }

  return lines.join("\n");
}

export async function sendTelegramMessage(text: string) {
  if (!hasTelegramConfig()) {
    console.warn(
      `Telegram notification skipped. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to deliver messages to ${config.TELEGRAM_USERNAME}.`
    );
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: config.TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    })
  });

  if (!response.ok) {
    const payload = await response.text().catch(() => "");
    throw new Error(`Telegram send failed with HTTP ${response.status}: ${payload}`);
  }
}