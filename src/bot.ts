import { assertExecutionReady, config } from "./config.js";
import { AiTradeAgent } from "./ai-agent.js";
import { evaluateBaselineStrategy } from "./baseline-strategy.js";
import { createExecutionProvider } from "./executor.js";
import { OkxDexClient } from "./okx-client.js";
import { recordTrade, type PositionInfo } from "./position-tracker.js";
import type { AgentDecision, BotRunResult, TradingRequest } from "./types.js";
import { createPublicClient, http } from "viem";
import { bsc } from "viem/chains";

/** Consecutive execution error tracking to break infinite fail loops */
let consecutiveExecErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 3;
let consecutiveReceiptFailures = 0;
const MAX_CONSECUTIVE_RECEIPT_FAILURES = 2;

function clampAmount(rawAmount: string, maxAmount?: string) {
  if (!maxAmount) {
    return rawAmount;
  }

  const amount = BigInt(rawAmount);
  const max = BigInt(maxAmount);
  return (amount > max ? max : amount).toString();
}

async function verifyTxReceipt(txHash: string): Promise<{
  receiptStatus: "success" | "failed" | "pending" | "unavailable";
  receiptBlockNumber?: number;
  receiptGasUsed?: string;
}> {
  if (!config.EVM_RPC_URL || !txHash.startsWith("0x")) {
    return { receiptStatus: "unavailable" };
  }

  try {
    const client = createPublicClient({
      chain: bsc,
      transport: http(config.EVM_RPC_URL, { timeout: 10_000 })
    });

    const deadlineMs = Date.now() + 45_000;
    while (Date.now() < deadlineMs) {
      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => undefined);
      if (receipt) {
        return {
          receiptStatus: receipt.status === "success" ? "success" : "failed",
          receiptBlockNumber: Number(receipt.blockNumber),
          receiptGasUsed: receipt.gasUsed.toString()
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    return { receiptStatus: "pending" };
  } catch {
    return { receiptStatus: "unavailable" };
  }
}

export class AgenticTradingBot {
  private okx = new OkxDexClient();
  private agent = new AiTradeAgent();
  private executor = createExecutionProvider();

  async run(request: TradingRequest, position?: PositionInfo): Promise<BotRunResult> {
    const slippage = request.slippage ?? config.DEFAULT_SLIPPAGE;
    const buyAmount = clampAmount(request.buyAmount, config.MAX_BUY_AMOUNT);

    // Dynamic sell amount: use ACTUAL on-chain raw balance, never exceed it
    let sellAmount = clampAmount(request.sellAmount, config.MAX_SELL_AMOUNT);
    if (position && position.baseTokenBalance > 0) {
      // Use rawBalance from direct RPC (wei precision) if available
      const actualBalanceWei = position.baseTokenRawBalance > 0n
        ? position.baseTokenRawBalance
        : BigInt(Math.floor(position.baseTokenBalance * 1e18));
      
      // Sell configured portion, capped to 95% of actual balance as safety margin
      const portionWei = actualBalanceWei * BigInt(config.SELL_PORTION_PCT) / 100n;
      const safeMaxWei = actualBalanceWei * 95n / 100n; // Never exceed 95% to account for rounding
      const safeAmount = portionWei > safeMaxWei ? safeMaxWei : portionWei;
      sellAmount = clampAmount(safeAmount.toString(), config.MAX_SELL_AMOUNT);
    }

    // Consecutive error breaker: if last N executions failed (or receipt failures), force hold
    if (
      consecutiveExecErrors >= MAX_CONSECUTIVE_ERRORS ||
      consecutiveReceiptFailures >= MAX_CONSECUTIVE_RECEIPT_FAILURES
    ) {
      console.log(
        `[bot] ERROR BREAKER: exec_failures=${consecutiveExecErrors}, receipt_failures=${consecutiveReceiptFailures}. Forcing hold until success.`
      );
      return {
        dryRun: config.DRY_RUN,
        request,
        buyQuote: { fromTokenAddress: "", toTokenAddress: "", amountIn: "0", amountOut: "0", raw: null },
        sellQuote: { fromTokenAddress: "", toTokenAddress: "", amountIn: "0", amountOut: "0", raw: null },
        position: position ? {
          baseTokenBalance: position.baseTokenBalance,
          baseTokenValueUsd: position.baseTokenValueUsd,
          quoteTokenBalance: position.quoteTokenBalance,
          costBasisUsd: position.costBasisUsd,
          unrealizedPnlPct: position.unrealizedPnlPct,
        } : undefined,
        baselineDecision: {
          action: "hold",
          confidence: 0.99,
          reasoning: `Error breaker: execution_failures=${consecutiveExecErrors}, receipt_failures=${consecutiveReceiptFailures}`,
          riskNotes: []
        },
        decision: {
          action: "hold",
          confidence: 0.99,
          reasoning: `Error breaker active due to repeated execution/receipt failures.`,
          riskNotes: []
        },
        decisionSource: "baseline",
        executionProvider: this.executor.name,
      };
    }

    const [buyQuote, sellQuote] = await Promise.all([
      this.okx.quoteSwap({
        chainId: request.chainId,
        fromTokenAddress: request.quoteTokenAddress,
        toTokenAddress: request.baseTokenAddress,
        amount: buyAmount,
        slippage
      }),
      this.okx.quoteSwap({
        chainId: request.chainId,
        fromTokenAddress: request.baseTokenAddress,
        toTokenAddress: request.quoteTokenAddress,
        amount: sellAmount,
        slippage
      })
    ]);

    const baselineDecision = evaluateBaselineStrategy({ request, buyQuote, sellQuote, position });

    let aiDecision: AgentDecision;
    try {
      const positionContext = position
        ? `Holding ${position.baseTokenBalance.toFixed(6)} base token ($${position.baseTokenValueUsd.toFixed(2)} USD). USDT balance: $${position.quoteTokenBalance.toFixed(2)}. Cost basis: $${position.costBasisUsd.toFixed(2)}. Unrealized P&L: ${position.unrealizedPnlPct.toFixed(1)}%. Max position: $${config.MAX_POSITION_USD}. Take profit at: ${config.TAKE_PROFIT_PCT}%.`
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
      decision = baselineDecision;
      decisionSource = "baseline";
    } else if (
      baselineDecision.action !== "hold" &&
      baselineDecision.confidence >= 0.72 &&
      aiDecision.action === "hold"
    ) {
      // Favor high-quality baseline entries/exits when AI is only passively holding.
      decision = baselineDecision;
      decisionSource = "baseline";
    } else if (
      baselineDecision.action !== "hold" &&
      aiDecision.action !== "hold" &&
      baselineDecision.action === aiDecision.action &&
      baselineDecision.confidence >= 0.72
    ) {
      decision = {
        ...baselineDecision,
        confidence: Math.min(1, Math.max(baselineDecision.confidence, aiDecision.confidence) + 0.04),
        reasoning: `[Baseline + AI agree] ${baselineDecision.reasoning}`,
      };
      decisionSource = "baseline";
    } else if (
      baselineDecision.action === "hold" &&
      baselineDecision.confidence >= 0.85 &&
      aiDecision.action === "hold"
    ) {
      // Keep baseline HOLD only when AI also prefers HOLD.
      decision = baselineDecision;
      decisionSource = "baseline";
    } else if (baselineDecision.action === "hold" && aiDecision.action !== "hold") {
      decision = aiDecision;
      decisionSource = "ai";
    } else if (baselineDecision.action === aiDecision.action) {
      decision = {
        ...aiDecision,
        confidence: Math.min(1, Math.max(aiDecision.confidence, baselineDecision.confidence) + 0.05),
        reasoning: `[Baseline + AI agree] ${aiDecision.reasoning}`,
      };
      decisionSource = "ai";
    } else if (
      aiDecision.action !== "hold" &&
      aiDecision.confidence >= 0.92 &&
      baselineDecision.confidence < 0.60
    ) {
      decision = aiDecision;
      decisionSource = "ai";
    } else {
      decision = baselineDecision;
      decisionSource = "baseline";
    }

    if (decision.action === "sell" && (!position || position.baseTokenBalance <= 0)) {
      decision = {
        action: "hold",
        confidence: 0.2,
        reasoning: "No base asset holdings available for a sell decision.",
        riskNotes: ["Sell blocked because position is empty or unavailable."]
      };
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

    // Use MIN_CONFIDENCE_TO_EXECUTE if available, fall back to MAX for backwards compat
    const minConfidence = (config as any).MIN_CONFIDENCE_TO_EXECUTE ?? (1 - config.MAX_CONFIDENCE_TO_EXECUTE);
    if (decision.action === "buy" || decision.action === "sell") {
      if (decision.confidence < minConfidence) {
        console.log(`[bot] confidence ${decision.confidence.toFixed(2)} below minimum ${minConfidence.toFixed(2)}, preview mode`);
        return {
          ...result,
          execution: {
            mode: "preview",
            transaction: undefined
          }
        };
      }
    }

    const selectedAmount = clampAmount(
      decision.preferredAmount ?? (decision.action === "buy" ? buyAmount : sellAmount),
      decision.action === "buy" ? config.MAX_BUY_AMOUNT : config.MAX_SELL_AMOUNT
    );
    const usedAdaptiveAmount = selectedAmount !== (decision.action === "buy" ? buyAmount : sellAmount);

    if (usedAdaptiveAmount) {
      console.log(
        `[bot] adaptive sizing applied for ${decision.action}: requested=${decision.action === "buy" ? buyAmount : sellAmount} selected=${selectedAmount}`
      );
    }

    // Guard: reject execution when amount is 0, empty, or invalid
    if (!selectedAmount || selectedAmount === "0" || BigInt(selectedAmount) <= 0n) {
      console.log(`[bot] Blocked execution: selectedAmount is ${selectedAmount}. Returning hold.`);
      return { ...result, decision: { ...decision, action: "hold", reasoning: `Blocked: ${decision.action} amount was zero or invalid` } };
    }

    const executionQuote = usedAdaptiveAmount
      ? await this.okx.quoteSwap({
          chainId: request.chainId,
          fromTokenAddress: decision.action === "buy" ? request.quoteTokenAddress : request.baseTokenAddress,
          toTokenAddress: decision.action === "buy" ? request.baseTokenAddress : request.quoteTokenAddress,
          amount: selectedAmount,
          slippage
        })
      : (decision.action === "buy" ? buyQuote : sellQuote);

    if (usedAdaptiveAmount) {
      console.log(
        `[bot] requoted ${decision.action}: amountIn=${executionQuote.amountIn} amountOut=${executionQuote.amountOut}`
      );
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
    let txHash: string;
    let executionError: Error | null = null;

    try {
      txHash = await this.executor.send(swap, request);
      // Reset error counter on success
      consecutiveExecErrors = 0;
    } catch (err) {
      executionError = err instanceof Error ? err : new Error(String(err));
      consecutiveExecErrors++;
      console.error(`[bot] execution failed (consecutive #${consecutiveExecErrors}): ${executionError.message}`);
      
      // Return error result in JSON-safe format
      return {
        ...result,
        execution: {
          mode: "error",
          error: executionError.message,
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

    const receiptCheck = await verifyTxReceipt(txHash);
    if (receiptCheck.receiptStatus === "failed") {
      consecutiveExecErrors++;
      consecutiveReceiptFailures++;
      console.error(`[bot] tx mined but failed: ${txHash}`);
    } else if (receiptCheck.receiptStatus === "success") {
      consecutiveExecErrors = 0;
      consecutiveReceiptFailures = 0;
    }

    // Record trade for position tracking (only for the main base token pair)
    const isMainPair =
      request.baseTokenAddress.toLowerCase() === config.DEFAULT_BASE_TOKEN_ADDRESS.toLowerCase();
    if (isMainPair) {
      try {
        const quote = executionQuote;
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
    }

    return {
      ...result,
      execution: {
        mode: "sent",
        txHash,
        receiptStatus: receiptCheck.receiptStatus,
        receiptBlockNumber: receiptCheck.receiptBlockNumber,
        receiptGasUsed: receiptCheck.receiptGasUsed,
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