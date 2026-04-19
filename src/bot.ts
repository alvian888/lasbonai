import { assertExecutionReady, config } from "./config.js";
import { AiTradeAgent } from "./ai-agent.js";
import { evaluateBaselineStrategy } from "./baseline-strategy.js";
import { createExecutionProvider } from "./executor.js";
import { OkxDexClient } from "./okx-client.js";
import { recordTrade, type PositionInfo } from "./position-tracker.js";
import type { AgentDecision, BotRunResult, TradingRequest } from "./types.js";

function clampAmount(rawAmount: string, maxAmount?: string) {
  if (!maxAmount) {
    return rawAmount;
  }

  const amount = BigInt(rawAmount);
  const max = BigInt(maxAmount);
  return (amount > max ? max : amount).toString();
}

export class AgenticTradingBot {
  private okx = new OkxDexClient();
  private agent = new AiTradeAgent();
  private executor = createExecutionProvider();

  async run(request: TradingRequest, position?: PositionInfo): Promise<BotRunResult> {
    const slippage = request.slippage ?? config.DEFAULT_SLIPPAGE;
    const buyAmount = clampAmount(request.buyAmount, config.MAX_BUY_AMOUNT);

    // Dynamic sell amount: sell a portion of actual holdings, never exceed balance
    let sellAmount = clampAmount(request.sellAmount, config.MAX_SELL_AMOUNT);
    if (position && position.baseTokenBalance > 0) {
      const portionTokens = position.baseTokenBalance * (config.SELL_PORTION_PCT / 100);
      const balanceWei = BigInt(Math.floor(position.baseTokenBalance * 1e18));
      const portionWei = BigInt(Math.floor(portionTokens * 1e18));
      // Use portion of balance, capped to actual balance
      const safeAmount = portionWei > balanceWei ? balanceWei : portionWei;
      sellAmount = clampAmount(safeAmount.toString(), config.MAX_SELL_AMOUNT);
    }

    const buyQuote = await this.okx.quoteSwap({
      chainId: request.chainId,
      fromTokenAddress: request.quoteTokenAddress,
      toTokenAddress: request.baseTokenAddress,
      amount: buyAmount,
      slippage
    });

    const sellQuote = await this.okx.quoteSwap({
      chainId: request.chainId,
      fromTokenAddress: request.baseTokenAddress,
      toTokenAddress: request.quoteTokenAddress,
      amount: sellAmount,
      slippage
    });

    const baselineDecision = evaluateBaselineStrategy({ request, buyQuote, sellQuote, position });

    let aiDecision: AgentDecision;
    try {
      const positionContext = position
        ? `Holding ${position.baseTokenBalance.toFixed(2)} XPL ($${position.baseTokenValueUsd.toFixed(2)}). USDT balance: $${position.quoteTokenBalance.toFixed(2)}. Cost basis: $${position.costBasisUsd.toFixed(2)}. Unrealized P&L: ${position.unrealizedPnlPct.toFixed(1)}%. Max position: $${config.MAX_POSITION_USD}. Take profit at: ${config.TAKE_PROFIT_PCT}%.`
        : undefined;
      aiDecision = await this.agent.decide({ request, buyQuote, sellQuote, positionContext });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aiDecision = {
        action: "hold",
        confidence: 0,
        reasoning: `AI decision service unavailable, bot switched to safe hold: ${message}`,
        riskNotes: ["LLM endpoint is unreachable or returned an error."]
      };
    }

    const aiFallbackHold =
      aiDecision.action === "hold" &&
      /Model response was incomplete|Model returned incomplete output|Model returned non-JSON content|Model returned partial|Model output was partial|AI decision service unavailable/i.test(
        aiDecision.reasoning
      );

    // Decision logic: combine baseline risk guard with AI intelligence
    let decision: AgentDecision;
    let decisionSource: "baseline" | "ai";

    if (aiFallbackHold) {
      // AI service failure: fall back to baseline
      decision = baselineDecision;
      decisionSource = "baseline";
    } else if (baselineDecision.action === "hold" && baselineDecision.confidence >= 0.65) {
      // Baseline hard hold (risk block or position management): respect it
      decision = baselineDecision;
      decisionSource = "baseline";
    } else if (baselineDecision.action === "hold") {
      // Baseline neutral (no clear signal, confidence < 0.65): defer to AI
      decision = aiDecision;
      decisionSource = "ai";
    } else if (aiDecision.action === baselineDecision.action) {
      // Baseline and AI agree on direction: boost confidence
      decision = {
        ...aiDecision,
        confidence: Math.min(1, Math.max(aiDecision.confidence, baselineDecision.confidence) + 0.05),
        reasoning: `[Baseline+AI agree] ${aiDecision.reasoning}`,
      };
      decisionSource = "ai";
    } else if (
      aiDecision.action !== "hold" &&
      aiDecision.confidence >= 0.85 &&
      baselineDecision.confidence < 0.55
    ) {
      // AI very strongly disagrees AND baseline signal is weak: respect AI
      decision = aiDecision;
      decisionSource = "ai";
    } else {
      // Default: trust baseline directional signal over unreliable AI
      decision = baselineDecision;
      decisionSource = "baseline";
    }

    const result: BotRunResult = {
      dryRun: config.DRY_RUN,
      request,
      buyQuote,
      sellQuote,
      position: position ? {
        baseTokenBalance: position.baseTokenBalance,
        baseTokenValueUsd: position.baseTokenValueUsd,
        quoteTokenBalance: position.quoteTokenBalance,
        costBasisUsd: position.costBasisUsd,
        unrealizedPnlPct: position.unrealizedPnlPct,
      } : undefined,
      baselineDecision,
      decision,
      decisionSource,
      executionProvider: this.executor.name
    };

    if (decision.action === "hold") {
      return result;
    }

    // Guard: block sells on tiny positions (< $5) to prevent bleeding dust
    if (decision.action === "sell" && position && position.baseTokenValueUsd < 5) {
      console.log(`[bot] Blocked sell: position value $${position.baseTokenValueUsd.toFixed(2)} < $5 minimum. Holding.`);
      return { ...result, decision: { ...decision, action: "hold", reasoning: `Blocked sell: position too small ($${position.baseTokenValueUsd.toFixed(2)} < $5)` } };
    }

    if (decision.confidence < config.MAX_CONFIDENCE_TO_EXECUTE) {
      return {
        ...result,
        execution: {
          mode: "preview",
          transaction: undefined
        }
      };
    }

    const selectedAmount = decision.preferredAmount ?? (decision.action === "buy" ? buyAmount : sellAmount);

    // Guard: reject execution when amount is 0, empty, or invalid
    if (!selectedAmount || selectedAmount === "0" || BigInt(selectedAmount) <= 0n) {
      console.log(`[bot] Blocked execution: selectedAmount is ${selectedAmount}. Returning hold.`);
      return { ...result, decision: { ...decision, action: "hold", reasoning: `Blocked: ${decision.action} amount was zero or invalid` } };
    }

    const swap = await this.okx.buildSwap({
      chainId: request.chainId,
      fromTokenAddress: decision.action === "buy" ? request.quoteTokenAddress : request.baseTokenAddress,
      toTokenAddress: decision.action === "buy" ? request.baseTokenAddress : request.quoteTokenAddress,
      amount: selectedAmount,
      slippage,
      walletAddress: request.walletAddress
    });

    if (config.DRY_RUN) {
      return {
        ...result,
        execution: {
          mode: "preview",
          transaction: {
            to: swap.to,
            data: swap.data,
            value: swap.value,
            gas: swap.gas,
            gasPrice: swap.gasPrice
          }
        }
      };
    }

    assertExecutionReady();
    const txHash = await this.executor.send(swap, request);

    // Record trade for position tracking
    try {
      const quote = decision.action === "buy" ? buyQuote : sellQuote;
      const raw = quote.raw as Record<string, unknown>;
      const fromToken = raw?.fromToken as Record<string, unknown> | undefined;
      const toToken = raw?.toToken as Record<string, unknown> | undefined;
      const fromDecimals = Number(fromToken?.decimal ?? 18);
      const toDecimals = Number(toToken?.decimal ?? 18);
      if (decision.action === "buy") {
        const usdSpent = Number(quote.amountIn) / (10 ** fromDecimals) * Number(fromToken?.tokenUnitPrice ?? 1);
        const tokensReceived = Number(quote.amountOut) / (10 ** toDecimals);
        await recordTrade("buy", usdSpent, tokensReceived);
      } else {
        const usdReceived = Number(quote.amountOut) / (10 ** toDecimals) * Number(toToken?.tokenUnitPrice ?? 1);
        const tokensSold = Number(quote.amountIn) / (10 ** fromDecimals);
        await recordTrade("sell", usdReceived, tokensSold);
      }
    } catch (recordErr) {
      console.error(`[bot] failed to record trade: ${recordErr instanceof Error ? recordErr.message : recordErr}`);
    }

    return {
      ...result,
      execution: {
        mode: "sent",
        txHash,
        transaction: {
          to: swap.to,
          data: swap.data,
          value: swap.value,
          gas: swap.gas,
          gasPrice: swap.gasPrice
        }
      }
    };
  }
}