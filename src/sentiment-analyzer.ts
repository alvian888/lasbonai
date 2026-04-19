import OpenAI from "openai";
import { z } from "zod";
import { config } from "./config.js";
import type { TelegramMessage } from "./telegram-scraper.js";

const sentimentResultSchema = z.object({
  overallSentiment: z.enum(["positive", "negative", "neutral"]),
  sentimentScore: z.number().min(0).max(100),
  mentionedTokens: z
    .array(
      z.object({
        symbol: z.string(),
        sentiment: z.enum(["positive", "negative", "neutral"]),
        confidence: z.number().min(0).max(1),
        contractAddress: z.string().nullish().transform(v => v ?? undefined)
      })
    )
    .default([]),
  reasoning: z.string(),
  topBullishSignals: z.array(z.string()).default([]),
  topBearishSignals: z.array(z.string()).default([])
});

export type SentimentResult = z.infer<typeof sentimentResultSchema>;

// Use Ollama directly for sentiment (avoids auth proxy on port 3001)
const OLLAMA_URL = process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11435/v1";
const OLLAMA_MODEL = process.env.SENTIMENT_MODEL || "rahmatginanjar120/lasbonai:latest";
const client = new OpenAI({
  apiKey: "ollama",
  baseURL: OLLAMA_URL
});

export async function analyzeSentiment(
  messages: TelegramMessage[],
  channelName: string
): Promise<SentimentResult> {
  if (messages.length === 0) {
    return fallbackResult("No messages to analyze");
  }

  const digest = messages
    .slice(0, 30)
    .map((m, i) => `[${i + 1}] (${m.date}) ${m.text.slice(0, 500)}`)
    .join("\n\n");

  const systemPrompt = `You are a crypto sentiment analysis agent. Analyze Telegram channel messages and determine the overall market sentiment.

Reply with strict JSON only. No explanation outside JSON.

Schema:
{
  "overallSentiment": "positive" | "negative" | "neutral",
  "sentimentScore": <number 0-100, where 0=extremely bearish, 50=neutral, 100=extremely bullish>,
  "mentionedTokens": [{"symbol": "TOKEN", "sentiment": "positive"|"negative"|"neutral", "confidence": 0.0-1.0 }],
  "reasoning": "brief explanation",
  "topBullishSignals": ["signal1", ...],
  "topBearishSignals": ["signal1", ...]
}

Rules:
- contractAddress must be a valid 0x hex address if mentioned in the messages, omit otherwise.
- sentimentScore: 0-30 bearish, 31-49 slightly bearish, 50 neutral, 51-69 slightly bullish, 70-100 bullish.
- Be conservative. Only score above 70 if there is clear, strong bullish consensus.`;

  const userPrompt = `Analyze the following ${messages.length} messages from Telegram channel @${channelName} for crypto market sentiment.

Focus on:
1. Overall bullish/bearish sentiment percentage
2. Specific token mentions with their individual sentiment
3. Any contract addresses mentioned (BSC/ETH format 0x...)
4. Buy/sell signals, price predictions, pump/dump warnings

Messages:
${digest}`;

  try {
    console.log(`[sentiment] Analyzing ${messages.length} messages from @${channelName}...`);

    const completion = await client.chat.completions.create({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: 1024
    });

    const raw = completion.choices[0]?.message?.content ?? "";

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error("[sentiment] LLM returned no JSON:", raw.slice(0, 200));
      return fallbackResult("LLM returned no parseable JSON");
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Normalize LLM sentiment values to expected enum
    const normSentiment = (s: string) => {
      const lower = String(s).toLowerCase();
      if (["bullish", "positive", "buy"].includes(lower)) return "positive";
      if (["bearish", "negative", "sell"].includes(lower)) return "negative";
      return "neutral";
    };
    if (parsed.overallSentiment) parsed.overallSentiment = normSentiment(parsed.overallSentiment);
    if (Array.isArray(parsed.mentionedTokens)) {
      for (const t of parsed.mentionedTokens) {
        if (t.sentiment) t.sentiment = normSentiment(t.sentiment);
        if (t.confidence == null) {
          // Default confidence based on resolved sentiment
          t.confidence = t.sentiment === "positive" ? 0.7 : 0.4;
        }
      }
    }

    const validated = sentimentResultSchema.parse(parsed);

    console.log(
      `[sentiment] score=${validated.sentimentScore}% sentiment=${validated.overallSentiment} tokens=${validated.mentionedTokens.length}`
    );
    return validated;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[sentiment] analysis failed: ${msg}`);
    return fallbackResult(msg);
  }
}

function fallbackResult(reason: string): SentimentResult {
  return {
    overallSentiment: "neutral",
    sentimentScore: 50,
    mentionedTokens: [],
    reasoning: `Fallback: ${reason}`,
    topBullishSignals: [],
    topBearishSignals: []
  };
}
