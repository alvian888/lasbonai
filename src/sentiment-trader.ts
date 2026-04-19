import { config } from "./config.js";
import { scrapeTelegramChannel } from "./telegram-scraper.js";
import { analyzeSentiment, type SentimentResult } from "./sentiment-analyzer.js";
import { resolveTokenAddress } from "./token-resolver.js";
import { getPositionInfo } from "./position-tracker.js";
import { sendTelegramMessage } from "./telegram.js";
import type { AgenticTradingBot } from "./bot.js";
import type { TradingRequest } from "./types.js";
import * as fs from "node:fs";
import * as path from "node:path";

const ANALYSIS_PATH = path.resolve("data/telegram-sentiment-analysis.json");
const COMPARISON_PATH = path.resolve("data/telegram-sentiment-comparison.json");

interface ChannelAnalysis {
  channel: string;
  channelUrl: string;
  messageCount: number;
  analysis: SentimentResult;
  scrapedAt: string;
}

interface SentimentComparison {
  comparedAt: string;
  channels: ChannelAnalysis[];
  combinedScore: number;
  combinedSentiment: string;
  agreement: "strong" | "moderate" | "weak" | "conflicting";
  commonBullishTokens: string[];
  commonBearishTokens: string[];
  tradeDecision: string;
}

function getChannelUrls(): string[] {
  // Prefer comma-separated list; fall back to single URL
  if (config.SENTIMENT_CHANNEL_URLS) {
    return config.SENTIMENT_CHANNEL_URLS
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
  }
  return [config.SENTIMENT_CHANNEL_URL];
}

export async function runSentimentCycle(bot: AgenticTradingBot): Promise<void> {
  const channelUrls = getChannelUrls();
  const threshold = config.SENTIMENT_THRESHOLD;
  const limit = config.SENTIMENT_SCRAPE_LIMIT;

  console.log(
    `[sentiment-trader] Starting multi-channel sentiment cycle (threshold=${threshold}%, channels=${channelUrls.length})`
  );

  // ── Step 1: Scrape & analyze all channels in parallel ──
  const channelResults: ChannelAnalysis[] = [];

  const tasks = channelUrls.map(async (url) => {
    try {
      const scrapeResult = await scrapeTelegramChannel(url, limit);
      if (!scrapeResult || scrapeResult.messages.length === 0) {
        console.log(`[sentiment-trader] No messages from ${url}, skipping.`);
        return null;
      }
      console.log(
        `[sentiment-trader] Scraped ${scrapeResult.messages.length} messages from @${scrapeResult.channel}`
      );

      const analysis = await analyzeSentiment(scrapeResult.messages, scrapeResult.channel);
      console.log(
        `[sentiment-trader] @${scrapeResult.channel}: ${analysis.overallSentiment} (${analysis.sentimentScore}%) — tokens: ${analysis.mentionedTokens.length}`
      );

      return {
        channel: scrapeResult.channel,
        channelUrl: url,
        messageCount: scrapeResult.messages.length,
        analysis,
        scrapedAt: scrapeResult.scrapedAt,
      } as ChannelAnalysis;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[sentiment-trader] Error processing ${url}: ${msg}`);
      return null;
    }
  });

  const settled = await Promise.all(tasks);
  for (const r of settled) {
    if (r) channelResults.push(r);
  }

  if (channelResults.length === 0) {
    console.log("[sentiment-trader] No channels returned data, skipping cycle.");
    return;
  }

  // ── Step 2: Compare & merge ──
  const comparison = buildComparison(channelResults);
  saveComparison(comparison);

  // Also save latest single-channel analysis for backward compat
  saveAnalysis(channelResults[0].analysis, channelResults[0].channel);

  console.log(
    `[sentiment-trader] Combined: ${comparison.combinedSentiment} (${comparison.combinedScore}%) agreement=${comparison.agreement} commonBullish=[${comparison.commonBullishTokens.join(",")}]`
  );

  // ── Step 3: Check threshold using combined score ──
  if (comparison.combinedScore < threshold) {
    console.log(
      `[sentiment-trader] Combined score ${comparison.combinedScore}% < threshold ${threshold}%. No auto-buy.`
    );
    await notifySentimentComparison(comparison, false);
    return;
  }

  // Extra safety: require at least moderate agreement for auto-buy
  if (comparison.agreement === "conflicting") {
    console.log(
      `[sentiment-trader] Channels are conflicting despite high score. No auto-buy for safety.`
    );
    await notifySentimentComparison(comparison, false);
    return;
  }

  // ── Step 4: Merge bullish tokens across channels & enrich addresses ──
  const mergedTokens = mergeBullishTokens(channelResults);

  for (const token of mergedTokens) {
    // Always validate address format: must be 42-char hex (0x + 40 hex chars)
    const isValidAddr = token.contractAddress && /^0x[0-9a-fA-F]{40}$/.test(token.contractAddress);
    if (!isValidAddr) {
      if (token.contractAddress) {
        console.log(`[sentiment-trader] Invalid address "${token.contractAddress}" for ${token.symbol}, re-resolving`);
      }
      const resolved = resolveTokenAddress(token.symbol);
      if (resolved) {
        console.log(`[sentiment-trader] Resolved ${token.symbol} → ${resolved}`);
        token.contractAddress = resolved;
      } else {
        token.contractAddress = undefined;
      }
    }
  }

  const quoteAddr = config.DEFAULT_QUOTE_TOKEN_ADDRESS.toLowerCase();
  const tradableTokens = mergedTokens.filter(
    (t) => t.contractAddress && t.contractAddress.toLowerCase() !== quoteAddr
  );

  if (tradableTokens.length === 0) {
    console.log(
      `[sentiment-trader] Combined score ${comparison.combinedScore}% >= threshold but no tradable bullish tokens found.`
    );
    await notifySentimentComparison(comparison, false);
    return;
  }

  // ── Step 5: Execute trades ──
  let tradeCount = 0;
  for (const token of tradableTokens) {
    try {
      console.log(
        `[sentiment-trader] Auto-buy signal: ${token.symbol} (${token.contractAddress}) confidence=${token.confidence.toFixed(2)} sources=${token.sourceChannels.join(",")}`
      );

      const request: TradingRequest = {
        chainId: config.DEFAULT_CHAIN_ID,
        walletAddress: config.EXECUTION_WALLET_ADDRESS || "",
        baseTokenAddress: token.contractAddress || config.DEFAULT_BASE_TOKEN_ADDRESS || "",
        quoteTokenAddress: config.DEFAULT_QUOTE_TOKEN_ADDRESS,
        buyAmount: config.DEFAULT_BUY_AMOUNT,
        sellAmount: "0",
        slippage: config.DEFAULT_SLIPPAGE,
        marketContext: buildComparisonContext(comparison, token.symbol),
      };

      const position = await getPositionInfo(
        request.chainId,
        request.baseTokenAddress,
        request.quoteTokenAddress
      );

      const result = await bot.run(request, position);
      console.log(
        `[sentiment-trader] ${token.symbol} result: action=${result.decision.action} executed=${result.execution?.mode === "sent"}`
      );
      tradeCount++;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[sentiment-trader] Failed to trade ${token.symbol}: ${msg}`);
    }
  }

  await notifySentimentComparison(comparison, tradeCount > 0, tradeCount);
}

// ── Comparison logic ──

interface MergedToken {
  symbol: string;
  sentiment: string;
  confidence: number;
  contractAddress?: string;
  sourceChannels: string[];
}

function buildComparison(channels: ChannelAnalysis[]): SentimentComparison {
  // Weighted average score by message count
  let totalMessages = 0;
  let weightedScore = 0;
  for (const ch of channels) {
    totalMessages += ch.messageCount;
    weightedScore += ch.analysis.sentimentScore * ch.messageCount;
  }
  const combinedScore = totalMessages > 0 ? Math.round(weightedScore / totalMessages) : 50;

  let combinedSentiment: string;
  if (combinedScore >= 70) combinedSentiment = "positive";
  else if (combinedScore <= 30) combinedSentiment = "negative";
  else combinedSentiment = "neutral";

  // Agreement calculation
  const scores = channels.map((c) => c.analysis.sentimentScore);
  const maxDiff =
    scores.length > 1 ? Math.max(...scores) - Math.min(...scores) : 0;
  let agreement: SentimentComparison["agreement"];
  if (maxDiff <= 15) agreement = "strong";
  else if (maxDiff <= 30) agreement = "moderate";
  else if (maxDiff <= 50) agreement = "weak";
  else agreement = "conflicting";

  // Find common tokens mentioned across channels
  const bullishByChannel = channels.map((ch) =>
    ch.analysis.mentionedTokens
      .filter((t) => t.sentiment === "positive")
      .map((t) => t.symbol.toUpperCase())
  );
  const bearishByChannel = channels.map((ch) =>
    ch.analysis.mentionedTokens
      .filter((t) => t.sentiment === "negative")
      .map((t) => t.symbol.toUpperCase())
  );

  const commonBullish =
    bullishByChannel.length > 1
      ? bullishByChannel[0].filter((sym) =>
          bullishByChannel.slice(1).some((arr) => arr.includes(sym))
        )
      : bullishByChannel[0] || [];

  const commonBearish =
    bearishByChannel.length > 1
      ? bearishByChannel[0].filter((sym) =>
          bearishByChannel.slice(1).some((arr) => arr.includes(sym))
        )
      : bearishByChannel[0] || [];

  let tradeDecision: string;
  if (combinedScore >= 70 && agreement !== "conflicting") {
    tradeDecision = commonBullish.length > 0
      ? `Auto-buy: multi-channel consensus on ${commonBullish.join(", ")}`
      : "Auto-buy: high combined score, using all bullish tokens";
  } else if (agreement === "conflicting") {
    tradeDecision = "Hold: channels disagree significantly";
  } else {
    tradeDecision = `Hold: combined score ${combinedScore}% below threshold`;
  }

  return {
    comparedAt: new Date().toISOString(),
    channels,
    combinedScore,
    combinedSentiment,
    agreement,
    commonBullishTokens: [...new Set(commonBullish)],
    commonBearishTokens: [...new Set(commonBearish)],
    tradeDecision,
  };
}

function mergeBullishTokens(channels: ChannelAnalysis[]): MergedToken[] {
  const tokenMap = new Map<string, MergedToken>();

  for (const ch of channels) {
    for (const t of ch.analysis.mentionedTokens) {
      if (t.sentiment !== "positive" || t.confidence < 0.6) continue;
      const key = t.symbol.toUpperCase();
      const existing = tokenMap.get(key);
      if (existing) {
        // Average confidence, merge sources
        existing.confidence = (existing.confidence + t.confidence) / 2;
        if (!existing.sourceChannels.includes(ch.channel)) {
          existing.sourceChannels.push(ch.channel);
        }
        // Prefer resolved address
        if (!existing.contractAddress && t.contractAddress) {
          existing.contractAddress = t.contractAddress;
        }
      } else {
        tokenMap.set(key, {
          symbol: t.symbol,
          sentiment: t.sentiment,
          confidence: t.confidence,
          contractAddress: t.contractAddress,
          sourceChannels: [ch.channel],
        });
      }
    }
  }

  // Sort: tokens mentioned by multiple channels first, then by confidence
  return [...tokenMap.values()].sort(
    (a, b) => b.sourceChannels.length - a.sourceChannels.length || b.confidence - a.confidence
  );
}

// ── Context & persistence ──

function buildComparisonContext(comparison: SentimentComparison, tokenSymbol: string): string {
  const channelBreakdown = comparison.channels
    .map((c) => `@${c.channel}: ${c.analysis.sentimentScore}% ${c.analysis.overallSentiment}`)
    .join("; ");
  return [
    `Multi-channel sentiment: ${comparison.combinedSentiment} (${comparison.combinedScore}%) [${comparison.agreement} agreement].`,
    `Channels: ${channelBreakdown}.`,
    `Target token: ${tokenSymbol}.`,
    `Common bullish: ${comparison.commonBullishTokens.join(", ") || "none"}.`,
    `Decision: ${comparison.tradeDecision}`,
  ].join(" ");
}

function saveAnalysis(analysis: SentimentResult, channel: string) {
  const payload = { channel, analyzedAt: new Date().toISOString(), ...analysis };
  fs.writeFileSync(ANALYSIS_PATH, JSON.stringify(payload, null, 2));
}

function saveComparison(comparison: SentimentComparison) {
  // Strip full analysis bodies from channels to keep file small
  const slim = {
    ...comparison,
    channels: comparison.channels.map((c) => ({
      channel: c.channel,
      channelUrl: c.channelUrl,
      messageCount: c.messageCount,
      scrapedAt: c.scrapedAt,
      sentimentScore: c.analysis.sentimentScore,
      overallSentiment: c.analysis.overallSentiment,
      mentionedTokens: c.analysis.mentionedTokens.map((t) => ({
        symbol: t.symbol,
        sentiment: t.sentiment,
        confidence: t.confidence,
      })),
      topBullishSignals: c.analysis.topBullishSignals,
      topBearishSignals: c.analysis.topBearishSignals,
      reasoning: c.analysis.reasoning,
    })),
  };
  fs.writeFileSync(COMPARISON_PATH, JSON.stringify(slim, null, 2));
  console.log(`[sentiment-trader] Comparison saved to ${COMPARISON_PATH}`);
}

async function notifySentimentComparison(
  comparison: SentimentComparison,
  tradeTriggered: boolean,
  tradeCount = 0
) {
  // ── Per-channel score summary ──
  const channelLines = comparison.channels.map(
    (c) =>
      `  @${c.channel}: ${c.analysis.sentimentScore}% ${c.analysis.overallSentiment} (${c.messageCount} msgs)`
  );

  // ── Per-channel top tokens breakdown ──
  const tokenBreakdownLines: string[] = [];
  for (const ch of comparison.channels) {
    const bullish = ch.analysis.mentionedTokens
      .filter((t) => t.sentiment === "positive")
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 5)
      .map((t) => `${t.symbol}(${Math.round(t.confidence * 100)}%)`)
      .join(", ");
    const bearish = ch.analysis.mentionedTokens
      .filter((t) => t.sentiment === "negative")
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 3)
      .map((t) => `${t.symbol}(${Math.round(t.confidence * 100)}%)`)
      .join(", ");
    tokenBreakdownLines.push(
      `  @${ch.channel}:`,
      `    📈 Bullish: ${bullish || "none"}`,
      `    📉 Bearish: ${bearish || "none"}`
    );
  }

  // ── Cross-source comparison matrix ──
  const allTokenSymbols = new Set<string>();
  for (const ch of comparison.channels) {
    for (const t of ch.analysis.mentionedTokens) {
      allTokenSymbols.add(t.symbol.toUpperCase());
    }
  }

  const crossSourceLines: string[] = [];
  if (allTokenSymbols.size > 0 && comparison.channels.length >= 2) {
    crossSourceLines.push("🔄 *Cross-Source Token Comparison:*");
    const sortedTokens = [...allTokenSymbols].slice(0, 10);
    for (const sym of sortedTokens) {
      const mentions: string[] = [];
      for (const ch of comparison.channels) {
        const tok = ch.analysis.mentionedTokens.find(
          (t) => t.symbol.toUpperCase() === sym
        );
        if (tok) {
          const icon =
            tok.sentiment === "positive" ? "🟢" :
            tok.sentiment === "negative" ? "🔴" : "⚪";
          mentions.push(`${icon}@${ch.channel}`);
        } else {
          mentions.push(`➖@${ch.channel}`);
        }
      }
      crossSourceLines.push(`  ${sym}: ${mentions.join(" | ")}`);
    }
  }

  const lines = [
    `📊 *Multi-Channel Sentiment Report (${comparison.channels.length} sources)*`,
    ``,
    `*Score per Channel:*`,
    ...channelLines,
    ``,
    `*Token Breakdown per Channel:*`,
    ...tokenBreakdownLines,
    ``,
    ...crossSourceLines,
    ``,
    `*Combined:* ${comparison.combinedScore}% ${comparison.combinedSentiment} (${comparison.agreement} agreement)`,
    comparison.commonBullishTokens.length > 0
      ? `*Consensus Bullish:* ${comparison.commonBullishTokens.join(", ")}`
      : `No common bullish tokens across channels`,
    comparison.commonBearishTokens.length > 0
      ? `*Consensus Bearish:* ${comparison.commonBearishTokens.join(", ")}`
      : ``,
    ``,
    tradeTriggered
      ? `✅ Auto-buy triggered for ${tradeCount} token(s)`
      : `⏸ ${comparison.tradeDecision}`,
  ].filter(Boolean);
  await sendTelegramMessage(lines.join("\n"));
}

// ── CLI entry point (test mode — scrape + analyze only, no trades) ──
if (process.argv[1]?.endsWith("sentiment-trader.ts") || process.argv[1]?.endsWith("sentiment-trader.js")) {
  (async () => {
    const channelUrl = config.SENTIMENT_CHANNEL_URL;
    const limit = config.SENTIMENT_SCRAPE_LIMIT;
    console.log(`[sentiment-test] Scraping ${channelUrl} (limit=${limit})...`);
    const scrapeResult = await scrapeTelegramChannel(channelUrl, limit);
    if (!scrapeResult || scrapeResult.messages.length === 0) {
      console.log("[sentiment-test] No messages scraped.");
      process.exit(0);
    }
    console.log(`[sentiment-test] Scraped ${scrapeResult.messages.length} messages`);
    const analysis = await analyzeSentiment(scrapeResult.messages, scrapeResult.channel);
    saveAnalysis(analysis, scrapeResult.channel);
    console.log("[sentiment-test] Result:", JSON.stringify(analysis, null, 2));
  })().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
