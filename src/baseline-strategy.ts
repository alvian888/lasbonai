import type { AgentDecision, QuoteSummary, TradingRequest } from "./types.js";
import { config } from "./config.js";
import type { PositionInfo } from "./position-tracker.js";

interface QuoteMetrics {
  amountInUsd?: number;
  amountOutUsd?: number;
  tradeFeeUsd?: number;
  feeRatio?: number;
  priceImpactPercent?: number;
  buyBlocked: boolean;
  sellBlocked: boolean;
  taxRatePercent?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function humanAmount(amount: string, decimals?: number) {
  if (!decimals && decimals !== 0) {
    return undefined;
  }

  const normalized = amount.replace(/^0+/, "") || "0";
  if (decimals === 0) {
    return Number(normalized);
  }

  const padded = normalized.padStart(decimals + 1, "0");
  const integerPart = padded.slice(0, -decimals) || "0";
  const fractionPart = padded.slice(-decimals).replace(/0+$/, "");
  const value = fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getQuoteMetrics(quote: QuoteSummary): QuoteMetrics {
  const raw = asRecord(quote.raw);
  const fromToken = asRecord(raw?.fromToken);
  const toToken = asRecord(raw?.toToken);
  const amountIn = humanAmount(quote.amountIn, asNumber(fromToken?.decimal));
  const amountOut = humanAmount(quote.amountOut, asNumber(toToken?.decimal));
  const fromPrice = asNumber(fromToken?.tokenUnitPrice);
  const toPrice = asNumber(toToken?.tokenUnitPrice);
  const amountInUsd = amountIn !== undefined && fromPrice !== undefined ? amountIn * fromPrice : undefined;
  const amountOutUsd = amountOut !== undefined && toPrice !== undefined ? amountOut * toPrice : undefined;
  const tradeFeeUsd = asNumber(raw?.tradeFee);
  const feeBase = amountInUsd ?? amountOutUsd;
  const feeRatio = feeBase && tradeFeeUsd !== undefined ? tradeFeeUsd / feeBase : undefined;
  const priceImpactPercent = asNumber(raw?.priceImpactPercent);
  const fromHoneyPot = Boolean(fromToken?.isHoneyPot);
  const toHoneyPot = Boolean(toToken?.isHoneyPot);
  const fromTax = asNumber(fromToken?.taxRate);
  const toTax = asNumber(toToken?.taxRate);
  const taxRatePercent = Math.max(fromTax ?? 0, toTax ?? 0);

  return {
    amountInUsd,
    amountOutUsd,
    tradeFeeUsd,
    feeRatio,
    priceImpactPercent,
    buyBlocked: toHoneyPot || taxRatePercent > 10,
    sellBlocked: fromHoneyPot,
    taxRatePercent
  };
}

function inferSignalFromTa(request: TradingRequest) {
  const taSignals: number[] = [];
  const reasons: string[] = [];

  if (request.rsi !== undefined) {
    if (request.rsi <= 35) {
      taSignals.push(1);
      reasons.push(`RSI ${request.rsi.toFixed(1)} indicates oversold momentum`);
    } else if (request.rsi >= 65) {
      taSignals.push(-1);
      reasons.push(`RSI ${request.rsi.toFixed(1)} indicates overbought momentum`);
    } else {
      reasons.push(`RSI ${request.rsi.toFixed(1)} is neutral`);
    }
  }

  if (request.macd !== undefined && request.macdSignal !== undefined) {
    if (request.macd > request.macdSignal) {
      taSignals.push(1);
      reasons.push(`MACD (${request.macd.toFixed(4)}) is above signal (${request.macdSignal.toFixed(4)})`);
    } else if (request.macd < request.macdSignal) {
      taSignals.push(-1);
      reasons.push(`MACD (${request.macd.toFixed(4)}) is below signal (${request.macdSignal.toFixed(4)})`);
    }
  }

  if (request.emaFast !== undefined && request.emaSlow !== undefined) {
    if (request.emaFast > request.emaSlow) {
      taSignals.push(1);
      reasons.push(`EMA fast (${request.emaFast.toFixed(6)}) is above EMA slow (${request.emaSlow.toFixed(6)})`);
    } else if (request.emaFast < request.emaSlow) {
      taSignals.push(-1);
      reasons.push(`EMA fast (${request.emaFast.toFixed(6)}) is below EMA slow (${request.emaSlow.toFixed(6)})`);
    }
  }

  if (taSignals.length === 0) {
    return {
      action: "hold" as const,
      reason: "No TA metrics supplied (RSI/MACD/EMA), so no directional edge."
    };
  }

  const score = taSignals.reduce((sum, value) => sum + value, 0);

  if (score > 0) {
    return { action: "buy" as const, reason: reasons.join("; ") };
  }

  if (score < 0) {
    return { action: "sell" as const, reason: reasons.join("; ") };
  }

  return {
    action: "hold" as const,
    reason: `TA signals are mixed. ${reasons.join("; ")}`
  };
}

export function evaluateBaselineStrategy(params: {
  request: TradingRequest;
  buyQuote: QuoteSummary;
  sellQuote: QuoteSummary;
  position?: PositionInfo;
}): AgentDecision {
  const buyMetrics = getQuoteMetrics(params.buyQuote);
  const sellMetrics = getQuoteMetrics(params.sellQuote);
  const signal = inferSignalFromTa(params.request);
  const riskNotes: string[] = [];
  const pos = params.position;

  if (buyMetrics.buyBlocked) {
    riskNotes.push("Buy path is blocked by honeypot or excessive token tax.");
  }

  if (sellMetrics.sellBlocked) {
    riskNotes.push("Sell path is blocked by honeypot characteristics.");
  }

  if ((buyMetrics.priceImpactPercent ?? 0) > 2.5 || (sellMetrics.priceImpactPercent ?? 0) > 2.5) {
    riskNotes.push("Price impact is above the baseline risk threshold of 2.5%.");
  }

  if ((buyMetrics.feeRatio ?? 0) > 0.05 || (sellMetrics.feeRatio ?? 0) > 0.05) {
    riskNotes.push("Estimated swap fee is too large relative to the notional size.");
  }

  // Direction-aware notional check: only flag the side relevant to the signal
  if (signal.action === "buy" && (buyMetrics.amountInUsd ?? 0) < config.BASELINE_MIN_NOTIONAL_USD) {
    riskNotes.push(
      `Buy notional ($${(buyMetrics.amountInUsd ?? 0).toFixed(2)}) is below baseline minimum of $${config.BASELINE_MIN_NOTIONAL_USD.toFixed(2)}.`
    );
  }
  if (signal.action === "sell" && (sellMetrics.amountInUsd ?? 0) < config.BASELINE_MIN_NOTIONAL_USD) {
    riskNotes.push(
      `Sell notional ($${(sellMetrics.amountInUsd ?? 0).toFixed(2)}) is below baseline minimum of $${config.BASELINE_MIN_NOTIONAL_USD.toFixed(2)}.`
    );
  }

  if (riskNotes.length > 0) {
    return {
      action: "hold",
      confidence: 0.9,
      reasoning: `Baseline strategy blocked execution. ${signal.reason}`,
      riskNotes
    };
  }

  /* ─── Position-aware overrides ─── */
  if (pos) {
    const cooldownMs = config.COOLDOWN_SAME_DIRECTION_MIN * 60_000;
    const timeSinceLastTrade = Date.now() - (pos.lastTradeTimestamp || 0);

    // Take profit: if unrealized P&L >= target, sell (BEFORE cooldown – TP must always fire)
    if (pos.costBasisUsd > 0 && pos.unrealizedPnlPct >= config.TAKE_PROFIT_PCT && pos.baseTokenValueUsd > 5) {
      return {
        action: "sell",
        confidence: 0.75,
        reasoning: `Take profit triggered: unrealized P&L +${pos.unrealizedPnlPct.toFixed(1)}% (target ${config.TAKE_PROFIT_PCT}%). Position $${pos.baseTokenValueUsd.toFixed(2)}.`,
        riskNotes: []
      };
    }

    // Stop loss: if position is underwater, cut losses (BEFORE cooldown – SL must always fire)
    if (pos.costBasisUsd > 0 && pos.unrealizedPnlPct <= -config.STOP_LOSS_PCT && pos.baseTokenValueUsd > 5) {
      return {
        action: "sell",
        confidence: 0.72,
        reasoning: `Stop loss triggered: unrealized P&L ${pos.unrealizedPnlPct.toFixed(1)}% (limit -${config.STOP_LOSS_PCT}%). Cutting losses.`,
        riskNotes: []
      };
    }

    // Cooldown: don't trade too frequently in the same direction
    if (pos.lastTradeAction && timeSinceLastTrade < cooldownMs && pos.lastTradeAction === signal.action) {
      return {
        action: "hold",
        confidence: 0.7,
        reasoning: `Cooldown active: last trade (${pos.lastTradeAction}) was ${Math.round(timeSinceLastTrade / 60_000)}m ago (min ${config.COOLDOWN_SAME_DIRECTION_MIN}m).`,
        riskNotes: []
      };
    }

    // Max position: don't buy more if holdings already large
    if (pos.baseTokenValueUsd >= config.MAX_POSITION_USD && signal.action === "buy") {
      return {
        action: "hold",
        confidence: 0.7,
        reasoning: `Max position reached: holding $${pos.baseTokenValueUsd.toFixed(2)} XPL (limit $${config.MAX_POSITION_USD}). No more buys.`,
        riskNotes: []
      };
    }

    // Low USDT: don't buy if less than $10 USDT
    if (pos.quoteTokenBalance < 10 && signal.action === "buy") {
      return {
        action: "hold",
        confidence: 0.8,
        reasoning: `Low USDT balance: $${pos.quoteTokenBalance.toFixed(2)}. Cannot buy safely.`,
        riskNotes: []
      };
    }
  }

  if (signal.action === "hold") {
    return {
      action: "hold",
      confidence: 0.5,
      reasoning: signal.reason,
      riskNotes
    };
  }

  return {
    action: signal.action,
    confidence: 0.66,
    reasoning: `Baseline strategy found an acceptable setup. ${signal.reason}`,
    riskNotes
  };
}