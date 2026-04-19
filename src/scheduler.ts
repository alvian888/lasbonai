import { AgenticTradingBot } from "./bot.js";
import { config, getScheduledRequest } from "./config.js";
import { scanBep20Candidates } from "./candidate-scan.js";
import { persistCandidateArtifacts } from "./candidate-storage.js";
import { getPositionInfo } from "./position-tracker.js";
import { formatCandidateTelegramMessage, formatTelegramMessage, sendTelegramMessage } from "./telegram.js";
import { runSentimentCycle } from "./sentiment-trader.js";

let timer: NodeJS.Timeout | undefined;
let running = false;

async function runScheduledCycle(bot: AgenticTradingBot) {
  if (running) {
    console.log("Scheduled cycle skipped because a previous run is still active.");
    return;
  }

  const cycleStartedAt = Date.now();
  running = true;
  console.log("[scheduler] cycle started");
  try {
    // Sentiment-driven auto-buy cycle
    if (config.SENTIMENT_ENABLED) {
      const sentimentStartedAt = Date.now();
      try {
        await runSentimentCycle(bot);
      } catch (sentimentErr) {
        console.error(`[scheduler] sentiment cycle failed: ${sentimentErr instanceof Error ? sentimentErr.message : sentimentErr}`);
      } finally {
        console.log(`[scheduler] sentiment duration_ms=${Date.now() - sentimentStartedAt}`);
      }
    }

    if (config.CANDIDATE_SCAN_ENABLED) {
      const scanStartedAt = Date.now();
      const candidates = await scanBep20Candidates();
      console.log(`[scheduler] candidate_scan duration_ms=${Date.now() - scanStartedAt} mode=${candidates.mode} count=${candidates.count}`);

      const persistStartedAt = Date.now();
      await persistCandidateArtifacts(candidates);
      console.log(`[scheduler] candidate_persist duration_ms=${Date.now() - persistStartedAt}`);

      if (!config.CANDIDATE_NOTIFY_ONLY_WHEN_FOUND || candidates.count > 0) {
        const telegramStartedAt = Date.now();
        await sendTelegramMessage(formatCandidateTelegramMessage(candidates));
        console.log(`[scheduler] candidate_telegram duration_ms=${Date.now() - telegramStartedAt}`);
      }

      return;
    }

    const request = getScheduledRequest();

    // Fetch current position before making a decision
    let position;
    try {
      const positionStartedAt = Date.now();
      position = await getPositionInfo(request.chainId, request.baseTokenAddress, request.quoteTokenAddress);
      console.log(
        `[scheduler] position: XPL=${position.baseTokenBalance.toFixed(2)} ($${position.baseTokenValueUsd.toFixed(2)}) USDT=$${position.quoteTokenBalance.toFixed(2)} pnl=${position.unrealizedPnlPct.toFixed(1)}%`
      );
      console.log(`[scheduler] position_fetch duration_ms=${Date.now() - positionStartedAt}`);
    } catch (posErr) {
      console.error(`[scheduler] position check failed: ${posErr instanceof Error ? posErr.message : posErr}`);
    }

    const botRunStartedAt = Date.now();
    const result = await bot.run(request, position);
    console.log(`[scheduler] bot_run duration_ms=${Date.now() - botRunStartedAt}`);
    console.log(`[scheduler] decision=${result.decision.action} confidence=${result.decision.confidence.toFixed(2)} source=${result.decisionSource}`);
    if (result.decision.reasoning) console.log(`[scheduler] reasoning: ${result.decision.reasoning}`);
    if (result.decision.riskNotes?.length) console.log(`[scheduler] riskNotes: ${result.decision.riskNotes.join("; ")}`);

    const telegramStartedAt = Date.now();
    await sendTelegramMessage(formatTelegramMessage(result));
    console.log(`[scheduler] decision_telegram duration_ms=${Date.now() - telegramStartedAt}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[scheduler] ${message}`);
    try {
      await sendTelegramMessage(`<b>OKX Agentic Bot Error</b>\n${message.replaceAll("<", "<").replaceAll(">", ">")}`);
    } catch (telegramError) {
      console.error(telegramError instanceof Error ? telegramError.message : telegramError);
    }
  } finally {
    running = false;
    console.log(`[scheduler] cycle finished duration_ms=${Date.now() - cycleStartedAt}`);
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
