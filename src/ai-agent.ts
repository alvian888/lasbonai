import OpenAI from "openai";
import { z } from "zod";
import { config } from "./config.js";
import type { AgentDecision, QuoteSummary, TradingRequest } from "./types.js";

const decisionSchema = z.object({
  action: z.enum(["buy", "sell", "hold"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1),
  riskNotes: z.array(z.string()).default([]),
  preferredAmount: z.string().optional()
});

function tryExtractJsonObject(content: string) {
  const trimmed = content.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function normalizeDecision(content: string): AgentDecision {
  try {
    const parsed = JSON.parse(tryExtractJsonObject(content)) as Record<string, unknown>;
    const rawAction = typeof parsed.action === "string" ? parsed.action.toLowerCase() : "";
    const hasReasoning = typeof parsed.reasoning === "string" && parsed.reasoning.trim().length > 0;
    const candidate = {
      action: rawAction === "buy" || rawAction === "sell" || rawAction === "hold"
        ? (hasReasoning ? rawAction : "hold")
        : "hold",
      confidence:
        typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence) && hasReasoning
          ? Math.min(1, Math.max(0, parsed.confidence))
          : 0,
      reasoning:
        typeof parsed.reasoning === "string" && parsed.reasoning.trim()
          ? parsed.reasoning.trim()
          : "Model returned incomplete output.",
      riskNotes: Array.isArray(parsed.riskNotes)
        ? parsed.riskNotes.filter((item): item is string => typeof item === "string")
        : typeof parsed.reasoning === "string" && parsed.reasoning.trim()
          ? []
          : ["Model output was partial; downgraded to hold for safety."],
      preferredAmount: typeof parsed.preferredAmount === "string" ? parsed.preferredAmount : undefined
    };

    return decisionSchema.parse(candidate);
  } catch {
    return {
      action: "hold",
      confidence: 0,
      reasoning: `Model returned non-JSON content: ${content.slice(0, 240)}`,
      riskNotes: ["Response formatting was invalid."],
      preferredAmount: undefined
    };
  }
}

export class AiTradeAgent {
  private client = new OpenAI({
    apiKey: config.OPENAI_API_KEY,
    baseURL: config.OPENAI_BASE_URL
  });

  async decide(params: {
    request: TradingRequest;
    buyQuote: QuoteSummary;
    sellQuote: QuoteSummary;
    positionContext?: string;
  }): Promise<AgentDecision> {
    const completion = await this.client.chat.completions.create({
      model: config.OPENAI_MODEL,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a risk-aware crypto execution agent. Respond with strict JSON only: {\"action\":\"buy\"|\"sell\"|\"hold\", \"confidence\":0.0-1.0, \"reasoning\":\"...\", \"riskNotes\":[], \"preferredAmount\":\"atomic amount string\"}.\n\nUse the provided market quotes, position context, and risk limits. Prioritize low slippage, low price impact, and risk-calibrated position sizing. Recognize strong market context cues (e.g., \"Bullish breakout\", \"accumulation\") and act on them with confidence >= 0.7 when quote quality is acceptable. Only recommend execution when the trade has a clear edge and the confidence level justifies live execution. If you are uncertain, return hold with low confidence."
        },
        {
          role: "user",
          content: JSON.stringify(
            {
              task: "Decide the best next trade action for the requested market scan.",
              guidance: {
                target: "Maximize weekly P&L with risk-calibrated execution. Prefer acting on high-quality edges over passive holding.",
                avoid: ["high slippage", "low liquidity", "weak signals", "selling into a loss unless stop-loss conditions are met"],
                preferredAmountUnits: "same atomic units as request.buyAmount and request.sellAmount"
              },
              guardrails: {
                allowedActions: ["buy", "sell", "hold"],
                maxConfidenceToExecute: config.MAX_CONFIDENCE_TO_EXECUTE,
                dryRun: config.DRY_RUN,
                defaultSlippagePercent: config.DEFAULT_SLIPPAGE
              },
              request: params.request,
              buyQuote: params.buyQuote,
              sellQuote: params.sellQuote,
              position: params.positionContext ?? "No current position information provided."
            },
            null,
            2
          )
        }
      ]
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      throw new Error("LLM returned empty content");
    }

    return normalizeDecision(content);
  }
}