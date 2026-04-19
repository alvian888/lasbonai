/**
 * Quick test: scrape 3 channels + analyze + compare + notify
 * Usage: npx tsx src/test-sentiment-3ch.ts
 */
import { scrapeTelegramChannel } from "./telegram-scraper.js";
import { analyzeSentiment } from "./sentiment-analyzer.js";
import { config } from "./config.js";

const CHANNELS = (
  process.env.SENTIMENT_CHANNEL_URLS || config.SENTIMENT_CHANNEL_URLS || ""
)
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

if (CHANNELS.length === 0) {
  CHANNELS.push(config.SENTIMENT_CHANNEL_URL || "https://t.me/kaptencrypto707");
}

async function main() {
  console.log(`\n🔍 Testing ${CHANNELS.length} channels...\n`);

  for (const url of CHANNELS) {
    const tag = url.replace(/.*t\.me\//, "@");
    console.log(`━━━ ${tag} ━━━`);
    try {
      const scrape = await scrapeTelegramChannel(url, 20);
      console.log(`  Scraped: ${scrape.messageCount} messages`);
      if (scrape.messageCount === 0) {
        console.log("  ⚠️  No messages found — channel mungkin private atau kosong\n");
        continue;
      }
      // Show sample
      console.log(`  Sample: "${scrape.messages[0]?.text.slice(0, 80)}..."`);

      console.log("  Analyzing with Ollama...");
      const analysis = await analyzeSentiment(scrape.messages, tag);
      console.log(`  Score: ${analysis.sentimentScore}/100 (${analysis.overallSentiment})`);
      console.log(`  Tokens: ${analysis.mentionedTokens.length} mentioned`);
      if (analysis.mentionedTokens.length > 0) {
        const top5 = analysis.mentionedTokens.slice(0, 5);
        for (const t of top5) {
          console.log(`    ${t.sentiment === "positive" ? "🟢" : t.sentiment === "negative" ? "🔴" : "⚪"} ${t.symbol} (${(t.confidence * 100).toFixed(0)}%)`);
        }
      }
      console.log(`  Bullish: ${analysis.topBullishSignals.join(", ") || "none"}`);
      console.log(`  Bearish: ${analysis.topBearishSignals.join(", ") || "none"}`);
      console.log(`  Reasoning: ${analysis.reasoning.slice(0, 120)}...`);
    } catch (err: any) {
      console.error(`  ❌ Error: ${err.message}`);
    }
    console.log();
  }
  console.log("✅ Test selesai");
}

main().catch(console.error);
