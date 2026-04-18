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

function inferSignal(context?: string) {
  const text = (context ?? "").toLowerCase();

  if (!text.trim()) {
    return { action: "hold" as const, reason: "No market context was supplied." };
  }

  if (/(prioritas aman|dry-run|watch|observe|sideline|wait)/.test(text)) {
    return { action: "hold" as const, reason: "Context explicitly prioritizes safety or observation." };
  }

  if (/(bullish|oversold|breakout|uptrend|akumulasi|accumulate)/.test(text)) {
    return { action: "buy" as const, reason: "Context suggests a bullish or accumulation setup." };
  }

  if (/(bearish|overbought|breakdown|risk-off|distribusi|distribute)/.test(text)) {
    return { action: "sell" as const, reason: "Context suggests a bearish or de-risking setup." };
  }

  return { action: "hold" as const, reason: "Context does not provide a clear directional edge." };
}

export function evaluateBaselineStrategy(params: {
  request: TradingRequest;
  buyQuote: QuoteSummary;
  sellQuote: QuoteSummary;
  position?: PositionInfo;
}): AgentDecision {
  const buyMetrics = getQuoteMetrics(params.buyQuote);
  const sellMetrics = getQuoteMetrics(params.sellQuote);
  const signal = inferSignal(params.request.marketContext);
  const riskNotes: string[] = [];
  const pos = params.position;

  if (buyMetrics.buyBlocked) {
    riskNotes.push("Buy path is blocked by honeypot or excessive token tax.");
  }

  if (sellMetrics.sellBlocked) {
    riskNotes.push("Sell path is blocked by honeypot characteristics.");
  }

  if ((buyMetrics.priceImpactPercent ?? 0) > 1 || (sellMetrics.priceImpactPercent ?? 0) > 1) {
    riskNotes.push("Price impact is above the baseline risk threshold of 1%.");
  }

  if ((buyMetrics.feeRatio ?? 0) > 0.05 || (sellMetrics.feeRatio ?? 0) > 0.05) {
    riskNotes.push("Estimated swap fee is too large relative to the notional size.");
  }

  if (
    (buyMetrics.amountInUsd ?? 0) < config.BASELINE_MIN_NOTIONAL_USD ||
    (sellMetrics.amountInUsd ?? 0) < config.BASELINE_MIN_NOTIONAL_USD
  ) {
    riskNotes.push(
      `Trade notional is below baseline minimum of $${config.BASELINE_MIN_NOTIONAL_USD.toFixed(
        2
      )} for Ethereum mainnet fee conditions.`
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

    // Cooldown: don't trade too frequently (regardless of direction)
    if (pos.lastTradeAction && timeSinceLastTrade < cooldownMs) {
      return {
        action: "hold",
        confidence: 0.7,
        reasoning: `Cooldown active: last trade (${pos.lastTradeAction}) was ${Math.round(timeSinceLastTrade / 60_000)}m ago (min ${config.COOLDOWN_SAME_DIRECTION_MIN}m).`,
        riskNotes: []
      };
    }

    // Take profit: if unrealized P&L >= target, sell
    if (pos.costBasisUsd > 0 && pos.unrealizedPnlPct >= config.TAKE_PROFIT_PCT && pos.baseTokenValueUsd > 5) {
      return {
        action: "sell",
        confidence: 0.75,
        reasoning: `Take profit triggered: unrealized P&L +${pos.unrealizedPnlPct.toFixed(1)}% (target ${config.TAKE_PROFIT_PCT}%). Position $${pos.baseTokenValueUsd.toFixed(2)}.`,
        riskNotes: []
      };
    }

    // Stop loss: if position is underwater, cut losses
    if (pos.costBasisUsd > 0 && pos.unrealizedPnlPct <= -config.STOP_LOSS_PCT && pos.baseTokenValueUsd > 5) {
      return {
        action: "sell",
        confidence: 0.72,
        reasoning: `Stop loss triggered: unrealized P&L ${pos.unrealizedPnlPct.toFixed(1)}% (limit -${config.STOP_LOSS_PCT}%). Cutting losses.`,
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
      confidence: 0.7,
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