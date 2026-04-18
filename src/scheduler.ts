import { AgenticTradingBot } from "./bot.js";
import { config, getScheduledRequest } from "./config.js";
import { scanBep20Candidates } from "./candidate-scan.js";
import { persistCandidateArtifacts } from "./candidate-storage.js";
import { getPositionInfo } from "./position-tracker.js";
import { formatCandidateTelegramMessage, formatTelegramMessage, sendTelegramMessage } from "./telegram.js";

let timer: NodeJS.Timeout | undefined;
let running = false;

async function runScheduledCycle(bot: AgenticTradingBot) {
  if (running) {
    console.log("Scheduled cycle skipped because a previous run is still active.");
    return;
  }

  running = true;
  try {
    if (config.CANDIDATE_SCAN_ENABLED) {
      const candidates = await scanBep20Candidates();
      await persistCandidateArtifacts(candidates);
      console.log(`[scheduler] candidate_count=${candidates.count}`);
      if (!config.CANDIDATE_NOTIFY_ONLY_WHEN_FOUND || candidates.count > 0) {
        await sendTelegramMessage(formatCandidateTelegramMessage(candidates));
      }
      return;
    }

    const request = getScheduledRequest();

    // Fetch current position before making a decision
    let position;
    try {
      position = await getPositionInfo(request.chainId, request.baseTokenAddress, request.quoteTokenAddress);
      console.log(
        `[scheduler] position: XPL=${position.baseTokenBalance.toFixed(2)} ($${position.baseTokenValueUsd.toFixed(2)}) USDT=$${position.quoteTokenBalance.toFixed(2)} pnl=${position.unrealizedPnlPct.toFixed(1)}%`
      );
    } catch (posErr) {
      console.error(`[scheduler] position check failed: ${posErr instanceof Error ? posErr.message : posErr}`);
    }

    const result = await bot.run(request, position);
    console.log(`[scheduler] decision=${result.decision.action} confidence=${result.decision.confidence.toFixed(2)}`);
    await sendTelegramMessage(formatTelegramMessage(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[scheduler] ${message}`);
    try {
      await sendTelegramMessage(`<b>OKX Agentic Bot Error</b>\n${message.replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`);
    } catch (telegramError) {
      console.error(telegramError instanceof Error ? telegramError.message : telegramError);
    }
  } finally {
    running = false;
  }
}

export function startScheduler(bot: AgenticTradingBot) {
  if (!config.SCHEDULE_ENABLED) {
    console.log("Scheduler disabled by configuration.");
    return;
  }

  const intervalMs = Math.max(1, config.SCHEDULE_INTERVAL_MINUTES) * 60_000;
  console.log(`[scheduler] enabled, interval=${config.SCHEDULE_INTERVAL_MINUTES} minute(s)`);

  void runScheduledCycle(bot);
  timer = setInterval(() => {
    void runScheduledCycle(bot);
  }, intervalMs);
}

export function stopScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}