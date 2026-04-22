import type { AgentDecision, QuoteSummary, TradingRequest } from "./types.js";
import { config } from "./config.js";
import type { PositionInfo } from "./position-tracker.js";

interface QuoteMetrics {
  amountInUsd?: number;
  amountOutUsd?: number;
  tradeFeeUsd?: number;
  feeRatio?: number;
  priceImpactPercent?: number;
  slippageEstPct?: number;
  buyBlocked: boolean;
  sellBlocked: boolean;
  taxRatePercent?: number;
}

// Token decimals override — for tokens where onchainos may report wrong/missing decimals.
// Key: lowercase contract address. Value: actual on-chain decimals.
const TOKEN_DECIMALS_OVERRIDE: Record<string, number> = {
  "0xba2ae424d960c26247dd6c32edc70b295c744c43": 8  // DOGE-BSC (8 decimals, not 18)
};

function resolveDecimals(address: string, reported: number | undefined): number {
  return TOKEN_DECIMALS_OVERRIDE[address.toLowerCase()] ?? reported ?? 18;
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

function scaleAtomicAmount(amount: string, ratio: number) {
  if (!amount || ratio <= 0) {
    return undefined;
  }

  try {
    const rawAmount = BigInt(amount);
    if (rawAmount <= 0n) {
      return undefined;
    }

    const basisPoints = Math.max(1, Math.min(10_000, Math.floor(ratio * 10_000)));
    const scaled = (rawAmount * BigInt(basisPoints)) / 10_000n;
    return scaled > 0n ? scaled.toString() : undefined;
  } catch {
    return undefined;
  }
}

function getQuoteMetrics(quote: QuoteSummary): QuoteMetrics {
  const raw = asRecord(quote.raw);
  const fromToken = asRecord(raw?.fromToken);
  const toToken = asRecord(raw?.toToken);
  const amountIn = humanAmount(quote.amountIn, resolveDecimals(quote.fromTokenAddress, asNumber(fromToken?.decimal)));
  const amountOut = humanAmount(quote.amountOut, resolveDecimals(quote.toTokenAddress, asNumber(toToken?.decimal)));
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

  // Estimate effective slippage: difference between expected and actual output value
  const slippageEstPct =
    amountInUsd && amountOutUsd && amountInUsd > 0
      ? Math.max(0, ((amountInUsd - amountOutUsd) / amountInUsd) * 100 - (tradeFeeUsd ?? 0) / amountInUsd * 100)
      : undefined;

  return {
    amountInUsd,
    amountOutUsd,
    tradeFeeUsd,
    feeRatio,
    priceImpactPercent,
    slippageEstPct,
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

  // If TA metrics are provided, use them
  if (taSignals.length > 0) {
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

  // No TA metrics: use market context as fallback
  const context = (request.marketContext ?? "").toLowerCase();
  const bullishKeywords = ["bullish", "breakout", "accumulation", "uptrend", "rally", "surge", "momentum", "buy"];
  const bearishKeywords = ["bearish", "breakdown", "distribution", "downtrend", "dump", "collapse", "decline", "sell"];
  
  const hasBullish = bullishKeywords.some(kw => context.includes(kw));
  const hasBearish = bearishKeywords.some(kw => context.includes(kw));

  if (hasBullish && !hasBearish) {
    const contextStr = request.marketContext ?? "bullish context detected";
    return {
      action: "buy" as const,
      reason: `Market context suggests bullish setup: ${contextStr}`
    };
  }

  if (hasBearish && !hasBullish) {
    const contextStr = request.marketContext ?? "bearish context detected";
    return {
      action: "sell" as const,
      reason: `Market context suggests bearish setup: ${contextStr}`
    };
  }

  return {
    action: "hold" as const,
    reason: "No TA metrics supplied (RSI/MACD/EMA) and no clear market context signal."
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
  let hasBlockingRisk = false;
  let adaptivePreferredAmount: string | undefined;
  const pos = params.position;

  if (buyMetrics.buyBlocked) {
    riskNotes.push("Buy path is blocked by honeypot or excessive token tax.");
    hasBlockingRisk = true;
  }

  if (sellMetrics.sellBlocked) {
    riskNotes.push("Sell path is blocked by honeypot characteristics.");
    hasBlockingRisk = true;
  }

  // Sentiment probes use a relaxed impact threshold — small-cap tokens on BSC DEX
  // regularly exceed 0.5% impact at probe sizes ($5–$12) due to thin liquidity.
  const maxPriceImpactPct = params.request.sentimentProbe
    ? 3.0
    : config.BASELINE_MAX_PRICE_IMPACT_PCT;

  // Sentiment probes tolerate higher fee ratios — bridged BEP20 tokens (e.g. LINK)
  // can show 2–3% effective sell fee from DEX routing overhead, not actual token tax.
  // Sentiment probes accept up to 5% fee (OKX DEX routing overhead on bridged BEP20 tokens
  // like LINK can report 2–4% tradeFee due to thin-pool routing; not a token tax).
  const maxFeeRatioPct = params.request.sentimentProbe ? 0.05 : 0.02;
  if ((buyMetrics.feeRatio ?? 0) > maxFeeRatioPct || (sellMetrics.feeRatio ?? 0) > maxFeeRatioPct) {
    riskNotes.push(`Swap fee ratio too large: buy=${((buyMetrics.feeRatio ?? 0) * 100).toFixed(2)}% sell=${((sellMetrics.feeRatio ?? 0) * 100).toFixed(2)}% (max ${(maxFeeRatioPct * 100).toFixed(0)}%). Wait for lower-fee conditions.`);
    hasBlockingRisk = true;
  }

  const minNotionalUsd = params.request.sentimentProbe
    ? Math.min(config.BASELINE_MIN_NOTIONAL_USD, 2.5)
    : config.BASELINE_MIN_NOTIONAL_USD;

  // Slippage quality gate: block trades with excessive estimated slippage
  // RULE: Semakin kecil slippage = semakin menguntungkan → tighten gate to 0.5% max
  const buySlippage = buyMetrics.slippageEstPct ?? 0;
  const sellSlippage = sellMetrics.slippageEstPct ?? 0;
  const rawImpact = signal.action === "sell"
    ? sellMetrics.priceImpactPercent
    : buyMetrics.priceImpactPercent;
  // Guard: some tokens return empty priceImpactPercent (e.g. IQ); warn and rely on slippage check.
  if (signal.action !== "hold" && rawImpact === undefined) {
    riskNotes.push(`Price impact data unavailable for ${signal.action} quote; relying on slippage backstop.`);
  }
  const relevantImpactForSignal = rawImpact ?? 0;
  if (signal.action !== "hold" && relevantImpactForSignal > maxPriceImpactPct) {
    if (signal.action === "buy") {
      const targetImpact = maxPriceImpactPct * 0.7;
      const scaleRatio = Math.max(0.2, Math.min(0.9, targetImpact / relevantImpactForSignal));
      adaptivePreferredAmount = scaleAtomicAmount(params.request.buyAmount, scaleRatio);
      if (adaptivePreferredAmount && adaptivePreferredAmount !== params.request.buyAmount) {
        riskNotes.push(`Adaptive sizing on high impact: reduce buy size to ${(scaleRatio * 100).toFixed(0)}% to target <= ${targetImpact.toFixed(3)}% impact.`);
      } else {
        riskNotes.push(`Price impact too high for ${signal.action}: ${relevantImpactForSignal.toFixed(3)}% (max ${maxPriceImpactPct.toFixed(3)}%). Reduce size for better fill.`);
        hasBlockingRisk = true;
      }
    } else {
      riskNotes.push(`Price impact too high for ${signal.action}: ${relevantImpactForSignal.toFixed(3)}% (max ${maxPriceImpactPct.toFixed(3)}%). Reduce size for better fill.`);
      hasBlockingRisk = true;
    }
  }

  // Relax slippage gate: 0.5% is too strict for volatile assets. Use 1.0% as hard limit, warn at 0.5%
  const relevantSlippageForSignal = signal.action === "sell" ? sellSlippage : buySlippage;
  if (signal.action !== "hold" && relevantSlippageForSignal > 1.4) {
    riskNotes.push(`Slippage very high for ${signal.action}: ${relevantSlippageForSignal.toFixed(2)}% (max 1.4%). Try smaller size.`);
    hasBlockingRisk = true;
  } else if (signal.action !== "hold" && relevantSlippageForSignal > 0.8) {
    riskNotes.push(`⚠️ Slippage moderate for ${signal.action}: ${relevantSlippageForSignal.toFixed(2)}%. Acceptable with good position sizing.`);
  }

  // Direction-aware notional check: only flag the side relevant to the signal
  if (signal.action === "buy" && (buyMetrics.amountInUsd ?? 0) < minNotionalUsd) {
    riskNotes.push(
      `Buy notional ($${(buyMetrics.amountInUsd ?? 0).toFixed(2)}) is below baseline minimum of $${minNotionalUsd.toFixed(2)}.`
    );
    hasBlockingRisk = true;
  }
  if (signal.action === "sell" && (sellMetrics.amountInUsd ?? 0) < minNotionalUsd) {
    riskNotes.push(
      `Sell notional ($${(sellMetrics.amountInUsd ?? 0).toFixed(2)}) is below baseline minimum of $${minNotionalUsd.toFixed(2)}.`
    );
    hasBlockingRisk = true;
  }

  /* ─── TP/SL: MUST fire before any risk gate ─── */
  // These are risk management exits and must always execute regardless of quote quality.
  // Moving them BEFORE hasBlockingRisk ensures the bot never gets stuck in a position
  // because of temporary high price impact or low quote quality.
  if (pos) {
    // Multi-tier take profit for higher weekly P&L
    if (pos.costBasisUsd > 0 && pos.baseTokenValueUsd > 5) {
      // Tier 3: Full take profit at configured TP% (sell 75%)
      if (pos.unrealizedPnlPct >= config.TAKE_PROFIT_PCT) {
        return {
          action: "sell",
          confidence: 0.82,
          reasoning: `TP-3 triggered: +${pos.unrealizedPnlPct.toFixed(1)}% >= ${config.TAKE_PROFIT_PCT}%. Selling 75%. Position $${pos.baseTokenValueUsd.toFixed(2)}.`,
          riskNotes: []
        };
      }
      // Tier 2: Partial profit at 60% of TP target (sell normal portion)
      if (pos.unrealizedPnlPct >= config.TAKE_PROFIT_PCT * 0.6) {
        return {
          action: "sell",
          confidence: 0.72,
          reasoning: `TP-2 triggered: +${pos.unrealizedPnlPct.toFixed(1)}% >= ${(config.TAKE_PROFIT_PCT * 0.6).toFixed(1)}%. Locking partial profit.`,
          riskNotes: []
        };
      }
      // Tier 1: Early profit lock at 40% of TP target with low confidence
      if (pos.unrealizedPnlPct >= config.TAKE_PROFIT_PCT * 0.4) {
        return {
          action: "sell",
          confidence: 0.62,
          reasoning: `TP-1 triggered: +${pos.unrealizedPnlPct.toFixed(1)}% >= ${(config.TAKE_PROFIT_PCT * 0.4).toFixed(1)}%. Early profit lock.`,
          riskNotes: []
        };
      }
    }

    // Trailing stop: if price dropped >4% from peak P&L while still in profit
    const TRAILING_STOP_DROP_PCT = 4;
    if (pos.peakPnlPct > 3 && pos.unrealizedPnlPct > 0 && pos.baseTokenValueUsd > 5) {
      const dropFromPeak = pos.peakPnlPct - pos.unrealizedPnlPct;
      if (dropFromPeak >= TRAILING_STOP_DROP_PCT) {
        return {
          action: "sell",
          confidence: 0.76,
          reasoning: `Trailing stop triggered: peak was +${pos.peakPnlPct.toFixed(1)}%, now +${pos.unrealizedPnlPct.toFixed(1)}% (dropped ${dropFromPeak.toFixed(1)}% from peak, threshold ${TRAILING_STOP_DROP_PCT}%).`,
          riskNotes: []
        };
      }
    }

    // Dust position abandonment: if position lost >90% AND value < $5, stop trying to sell
    // This prevents infinite stop-loss loops on worthless positions
    if (pos.costBasisUsd > 0 && pos.unrealizedPnlPct <= -90 && pos.baseTokenValueUsd < 5) {
      return {
        action: "hold",
        confidence: 0.95,
        reasoning: `Dust position abandoned: lost ${Math.abs(pos.unrealizedPnlPct).toFixed(1)}% and value is only $${pos.baseTokenValueUsd.toFixed(2)}. Not worth gas to sell. Focus on new entries.`,
        riskNotes: [`Position value $${pos.baseTokenValueUsd.toFixed(2)} below $5 dust threshold. Sell gas would exceed recovery.`]
      };
    }

    // Stop loss: if position is underwater, cut losses (always fires before cooldown or risk gate)
    if (pos.costBasisUsd > 0 && pos.unrealizedPnlPct <= -config.STOP_LOSS_PCT && pos.baseTokenValueUsd > 5) {
      return {
        action: "sell",
        confidence: 0.72,
        reasoning: `Stop loss triggered: unrealized P&L ${pos.unrealizedPnlPct.toFixed(1)}% (limit -${config.STOP_LOSS_PCT}%). Cutting losses.`,
        riskNotes: []
      };
    }
  }

  if (hasBlockingRisk) {
    return {
      action: "hold",
      confidence: 0.78,
      reasoning: `Baseline strategy blocked execution. ${signal.reason}`,
      riskNotes
    };
  }

  /* ─── Position-aware overrides (non-critical: cooldown, position size) ─── */
  if (pos) {
    const cooldownMs = config.COOLDOWN_SAME_DIRECTION_MIN * 60_000;
    const timeSinceLastTrade = Date.now() - (pos.lastTradeTimestamp || 0);

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
        reasoning: `Max position reached: holding $${pos.baseTokenValueUsd.toFixed(2)} (limit $${config.MAX_POSITION_USD}). No more buys.`,
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

  // Dynamic confidence boost: lower slippage → higher confidence → more likely to execute
  // Semakin kecil slippage = semakin menguntungkan = semakin tinggi confidence
  const relevantSlippage = signal.action === "buy" ? buySlippage : sellSlippage;
  // Use maxPriceImpactPct as conservative fallback when impact is unknown (empty/missing from quote)
  const relevantImpact = rawImpact ?? maxPriceImpactPct;
  let preferredAmount: string | undefined = adaptivePreferredAmount;
  let dynamicConfidence = 0.62;
  if (relevantSlippage < 0.05 && relevantImpact < 0.02) {
    dynamicConfidence = 0.85; // Near-zero slippage → highest confidence → max P&L potential
  } else if (relevantSlippage < 0.1 && relevantImpact < 0.05) {
    dynamicConfidence = 0.80; // Excellent liquidity, very low cost
  } else if (relevantSlippage < 0.2 && relevantImpact < 0.1) {
    dynamicConfidence = 0.76; // Good liquidity
  } else if (relevantSlippage < 0.4 && relevantImpact < 0.15) {
    dynamicConfidence = 0.72; // Acceptable liquidity
  } else if (relevantSlippage < 0.6 && relevantImpact < 0.2) {
    dynamicConfidence = 0.68; // Marginal but tradeable
  }

  // Additional boost for consistently low slippage across both sides
  if (buySlippage < 0.15 && sellSlippage < 0.15) {
    dynamicConfidence = Math.min(dynamicConfidence + 0.03, 0.88);
  }

  if (!preferredAmount && signal.action === "buy" && relevantImpact > 0 && relevantImpact > maxPriceImpactPct * 0.75) {
    const targetImpact = maxPriceImpactPct * 0.7;
    const scaleRatio = Math.max(0.25, Math.min(0.9, targetImpact / relevantImpact));
    preferredAmount = scaleAtomicAmount(params.request.buyAmount, scaleRatio);
    if (preferredAmount && preferredAmount !== params.request.buyAmount) {
      riskNotes.push(`Adaptive sizing: reduce buy size to ${(scaleRatio * 100).toFixed(0)}% to target <= ${targetImpact.toFixed(3)}% impact.`);
      dynamicConfidence = Math.min(dynamicConfidence + 0.02, 0.9);
    }
  }

  return {
    action: signal.action,
    confidence: dynamicConfidence,
    reasoning: `Baseline strategy: slippage=${relevantSlippage.toFixed(3)}%, impact=${relevantImpact.toFixed(3)}% → conf=${dynamicConfidence.toFixed(2)}. Lower slippage = higher P&L. ${signal.reason}`,
    riskNotes,
    preferredAmount
  };
}