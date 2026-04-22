import { AgenticTradingBot } from "./bot.js";
import { config, getScheduledRequest } from "./config.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createPublicClient, createWalletClient, http } from "viem";
import { bsc } from "viem/chains";
import { mnemonicToAccount } from "viem/accounts";
import { scanBep20Candidates } from "./candidate-scan.js";
import { persistCandidateArtifacts } from "./candidate-storage.js";
import { getPositionInfo } from "./position-tracker.js";
import { formatCandidateTelegramMessage, formatTelegramMessage, sendTelegramMessage } from "./telegram.js";
import { runSentimentCycle } from "./sentiment-trader.js";
import { runParallelTokens } from "./parallel-executor.js";
import { analyzeWalletPatterns, getWalletPatternSignal } from "./wallet-pattern-analyzer.js";
import { resolveTokenAddress } from "./token-resolver.js";
import { OkxDexClient } from "./okx-client.js";
import { createExecutionProvider } from "./executor.js";

let timer: NodeJS.Timeout | undefined;
let running = false;
let cycleAbortController: AbortController | undefined;
let walletPatternCycleCount = 0;
let receiptFailedStreak = 0;
let receiptAlertSent = false;
let lastCycleStartedAt = 0;
let lastCycleFinishedAt = 0;
let lastCycleDurationMs = 0;
let lastCycleError: string | undefined;
let lastDecisionAction: string | undefined;
let lastDecisionConfidence: number | undefined;
let lastExecutionMode: string | undefined;
let lastReceiptStatus: string | undefined;
let lastIdrxTopupAt = 0;

const execFileAsync = promisify(execFile);
const IDRX_MIN_BALANCE = 100_000;
const IDRX_TOPUP_COOLDOWN_MS = 30 * 60 * 1000;
const IDRX_TOPUP_FAIL_COOLDOWN_MS = 10 * 60 * 1000;

const CYCLE_REPORT_WINDOW = 5;
let reportWindowCycles = 0;
let reportWindowHold = 0;
let reportWindowBuy = 0;
let reportWindowSell = 0;
let reportWindowSent = 0;
let reportWindowErrors = 0;
let reportWindowDurationMs = 0;

async function executeLifiSwapDirect(
  fromToken: string,
  toToken: string,
  amountIn: bigint,
  walletAddress: string,
  slippagePct: string,
): Promise<string> {
  const walletJson = JSON.parse(
    await readFile("secrets/metamask-wallet.json", "utf-8")
  ) as { seedPhrase: string };
  const expected = walletAddress.toLowerCase();
  let account = mnemonicToAccount(walletJson.seedPhrase.trim());
  if (account.address.toLowerCase() !== expected) {
    let matched = false;
    for (let accountIndex = 0; accountIndex <= 3 && !matched; accountIndex += 1) {
      for (let addressIndex = 0; addressIndex <= 30; addressIndex += 1) {
        const candidate = mnemonicToAccount(walletJson.seedPhrase.trim(), {
          accountIndex,
          addressIndex,
        });
        if (candidate.address.toLowerCase() === expected) {
          account = candidate;
          matched = true;
          console.log(
            `[lifi-direct] matched wallet derivation accountIndex=${accountIndex} addressIndex=${addressIndex}`
          );
          break;
        }
      }
    }
    if (!matched) {
      throw new Error(`[lifi-direct] no derived address matches expected ${walletAddress}`);
    }
  }

  const slippage = Number(slippagePct) / 100;
  const quoteUrl =
    `https://li.quest/v1/quote?fromChain=56&toChain=56` +
    `&fromToken=${fromToken}&toToken=${toToken}` +
    `&fromAmount=${amountIn.toString()}` +
    `&fromAddress=${walletAddress}` +
    `&slippage=${slippage}`;

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 20_000);
  let txCalldata: `0x${string}`;
  let txTo: `0x${string}`;
  let txValue: bigint;
  let gasLimit: bigint;
  let toAmountMin: string;
  try {
    const resp = await fetch(quoteUrl, { signal: ac.signal, headers: { "User-Agent": "Mozilla/5.0" } });
    clearTimeout(tid);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`Li.FI quote HTTP ${resp.status}: ${body.slice(0, 200)}`);
    }
    const quote = await resp.json() as {
      transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string };
      estimate?: { toAmountMin?: string };
    };
    const txReq = quote.transactionRequest;
    if (!txReq?.data || !txReq?.to) {
      throw new Error(`Li.FI quote invalid: ${JSON.stringify(quote).slice(0, 200)}`);
    }
    txCalldata = txReq.data as `0x${string}`;
    txTo = txReq.to as `0x${string}`;
    txValue = txReq.value ? BigInt(txReq.value) : 0n;
    gasLimit = txReq.gasLimit ? BigInt(parseInt(txReq.gasLimit, 16) + 50_000) : 700_000n;
    toAmountMin = quote.estimate?.toAmountMin ?? "0";
  } catch (err) {
    clearTimeout(tid);
    throw new Error(`Li.FI quote failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`[lifi-direct] quote ok toAmountMin=${toAmountMin} gasLimit=${gasLimit} to=${txTo}`);

  const transport = http(config.EVM_RPC_URL, { timeout: 30_000 });
  const walletClient = createWalletClient({ account, chain: bsc, transport });
  const publicClient = createPublicClient({ chain: bsc, transport });
  const feeData = await publicClient.estimateFeesPerGas().catch(() => null);
  const gasPrice = feeData?.gasPrice;

  const txHash = await walletClient.sendTransaction({
    to: txTo,
    data: txCalldata,
    value: txValue,
    gas: gasLimit,
    gasPrice,
  });

  console.log(`[lifi-direct] tx broadcast txHash=${txHash} toAmountMin=${toAmountMin}`);
  return txHash;
}


async function readRealizedPnlUsd(): Promise<number | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile("data/trade-state.json", "utf-8");
    const parsed = JSON.parse(raw) as { realizedPnlUsd?: unknown };
    const value = parsed.realizedPnlUsd;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function pushCycleWindowReport() {
  const decided = reportWindowHold + reportWindowBuy + reportWindowSell;
  const holdRatio = decided > 0 ? (reportWindowHold / decided) * 100 : 0;
  const realized = await readRealizedPnlUsd();

  const lines = [
    "<b>OKX Bot 5-Cycle Report</b>",
    `Cycles: ${reportWindowCycles}`,
    `Decision: HOLD=${reportWindowHold} BUY=${reportWindowBuy} SELL=${reportWindowSell}`,
    `Hold ratio: ${holdRatio.toFixed(1)}% (target <= 45%)`,
    `Execution sent: ${reportWindowSent}`,
    `Cycle errors: ${reportWindowErrors}`,
    `Avg cycle time: ${(reportWindowDurationMs / Math.max(reportWindowCycles, 1) / 1000).toFixed(1)}s`,
    realized === null ? "Realized PnL: n/a" : `Realized PnL: $${realized.toFixed(4)}`
  ];

  if (holdRatio > 45) {
    lines.push("Note: Hold ratio still above target. Continue anti-overhold tuning.");
  } else {
    lines.push("Note: Hold ratio on target. Keep monitoring execution quality.");
  }

  await sendTelegramMessage(lines.join("\n"));

  reportWindowCycles = 0;
  reportWindowHold = 0;
  reportWindowBuy = 0;
  reportWindowSell = 0;
  reportWindowSent = 0;
  reportWindowErrors = 0;
  reportWindowDurationMs = 0;
}

async function recordCycleMetrics(result: Awaited<ReturnType<AgenticTradingBot["run"]>>, cycleDurationMs: number) {
  reportWindowCycles += 1;
  reportWindowDurationMs += cycleDurationMs;

  if (result.decision.action === "hold") reportWindowHold += 1;
  if (result.decision.action === "buy") reportWindowBuy += 1;
  if (result.decision.action === "sell") reportWindowSell += 1;

  if (result.execution?.mode === "sent") reportWindowSent += 1;
  if (result.execution?.mode === "error" || result.execution?.receiptStatus === "failed") reportWindowErrors += 1;

  if (reportWindowCycles >= CYCLE_REPORT_WINDOW) {
    await pushCycleWindowReport();
  }

  // Trigger wallet pattern analysis in background every N cycles
  if (config.WALLET_PATTERN_ENABLED) {
    walletPatternCycleCount += 1;
    if (walletPatternCycleCount >= config.WALLET_PATTERN_SCAN_CYCLES) {
      walletPatternCycleCount = 0;
      const baseToken = process.env["DEFAULT_BASE_TOKEN_ADDRESS"] ?? "";
      if (baseToken) {
        // Non-blocking: run in background, do not await
        analyzeWalletPatterns(
          baseToken,
          config.WALLET_PATTERN_MIN_PNL_PCT,
          config.WALLET_PATTERN_LOOKBACK_BLOCKS
        ).catch((err: unknown) => {
          console.error(`[scheduler] wallet_pattern background scan failed: ${err instanceof Error ? err.message : err}`);
        });
        console.log(`[scheduler] wallet_pattern background scan triggered (cycle=${walletPatternCycleCount + config.WALLET_PATTERN_SCAN_CYCLES})`);
      }
    }
  }
}

/** Max time for a single cycle before force-kill and restart (10 minutes) */
const CYCLE_TIMEOUT_MS = 10 * 60 * 1000;
/** Consecutive stuck cycles before extending timeout */
let consecutiveTimeouts = 0;

async function runSentimentIfEnabled(bot: AgenticTradingBot) {
  if (!config.SENTIMENT_ENABLED) {
    return;
  }

  const sentimentStartedAt = Date.now();
  try {
    await runSentimentCycle(bot);
  } catch (sentimentErr) {
    console.error(`[scheduler] sentiment cycle failed: ${sentimentErr instanceof Error ? sentimentErr.message : sentimentErr}`);
  } finally {
    console.log(`[scheduler] sentiment duration_ms=${Date.now() - sentimentStartedAt}`);
  }
}

async function runCandidateFlowIfEnabled() {
  if (!config.CANDIDATE_SCAN_ENABLED) {
    return false;
  }

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

  return true;
}

async function readIdrxBalance(chainId: string, tokenAddress: string): Promise<number | null> {
  const bin = config.ONCHAINOS_BIN || `${process.env.HOME}/.local/bin/onchainos`;
  try {
    const { stdout } = await execFileAsync(bin, [
      "wallet",
      "balance",
      "--chain",
      chainId,
      "--token-address",
      tokenAddress,
      "--force"
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 30_000 });

    const payload = JSON.parse(stdout) as {
      data?: { details?: Array<{ tokenAssets?: Array<{ balance?: number | string }> }> };
    };
    const balance = payload.data?.details?.[0]?.tokenAssets?.[0]?.balance;
    const parsed = typeof balance === "number" ? balance : Number(balance);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function pickTopPnlTokensFromLatestDailyReport(): Promise<Array<{ symbol: string; pnlEnd: number }>> {
  const dailyDir = path.join(process.cwd(), "token portfolio", "BSC", "REPORT", "daily");
  try {
    const files = (await readdir(dailyDir))
      .filter((f) => f.endsWith("_daily_analysis.json"))
      .sort((a, b) => a.localeCompare(b));
    const latest = files.at(-1);
    if (!latest) return [];

    const raw = await readFile(path.join(dailyDir, latest), "utf-8");
    const parsed = JSON.parse(raw) as {
      tokenTrends?: Array<{ symbol?: string; pnlEnd?: number }>;
    };

    return (parsed.tokenTrends ?? [])
      .filter((t) => typeof t.symbol === "string" && typeof t.pnlEnd === "number")
      .map((t) => ({ symbol: t.symbol as string, pnlEnd: t.pnlEnd as number }))
      .sort((a, b) => b.pnlEnd - a.pnlEnd);
  } catch {
    return [];
  }
}

async function pollTxReceipt(txHash: string, timeoutMs = 60_000): Promise<"success" | "failed" | "pending"> {
  if (!config.EVM_RPC_URL || !txHash.startsWith("0x")) {
    return "pending";
  }
  try {
    const client = createPublicClient({
      chain: bsc,
      transport: http(config.EVM_RPC_URL, { timeout: 10_000 })
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` }).catch(() => undefined);
      if (receipt) {
        return receipt.status === "success" ? "success" : "failed";
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    return "pending";
  } catch {
    return "pending";
  }
}

async function enforceIdrxMinimumBalance() {
  const now = Date.now();
  if (now - lastIdrxTopupAt < IDRX_TOPUP_COOLDOWN_MS) {
    return;
  }

  const chainId = config.DEFAULT_CHAIN_ID;
  const walletAddress = config.EXECUTION_WALLET_ADDRESS;
  const idrxAddress = resolveTokenAddress("idrx");
  const usdtAddress = resolveTokenAddress("usdt");
  if (!chainId || !walletAddress || !idrxAddress || !usdtAddress) {
    return;
  }

  const idrxBalance = await readIdrxBalance(chainId, idrxAddress);
  if (idrxBalance === null) {
    console.warn("[scheduler] IDRX guard skipped: could not read IDRX balance.");
    return;
  }

  if (idrxBalance >= IDRX_MIN_BALANCE) {
    return;
  }

  console.log(`[scheduler] IDRX guard triggered: balance=${idrxBalance.toFixed(2)} < ${IDRX_MIN_BALANCE}`);

  const topPnlTokens = await pickTopPnlTokensFromLatestDailyReport();
  if (topPnlTokens.length === 0) {
    console.warn("[scheduler] IDRX guard: no valid top-PnL token found for top-up.");
    return;
  }

  const okx = new OkxDexClient();
  const executor = createExecutionProvider();
  const sellPortion = BigInt(Math.max(10, Math.min(config.SELL_PORTION_PCT, 70)));

  // ── Phase 1: Try direct route  fromToken → IDRX ──────────────────────────
  for (const candidate of topPnlTokens) {
    if (candidate.symbol.toLowerCase() === "idrx") continue;

    const resolved = resolveTokenAddress(candidate.symbol);
    if (!resolved || resolved.toLowerCase() === idrxAddress.toLowerCase()) continue;

    const position = await getPositionInfo(chainId, resolved, idrxAddress);
    if (position.baseTokenRawBalance <= 0n) continue;

    const sellAmount = (position.baseTokenRawBalance * sellPortion) / 100n;
    if (sellAmount <= 0n) continue;

    try {
      const quote = await okx.quoteSwap({
        chainId,
        fromTokenAddress: resolved,
        toTokenAddress: idrxAddress,
        amount: sellAmount.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
      });
      if (BigInt(quote.amountOut || "0") <= 0n) continue;

      const swap = await okx.buildSwap({
        chainId,
        fromTokenAddress: resolved,
        toTokenAddress: idrxAddress,
        amount: sellAmount.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
        walletAddress,
      });

      const txHash = await executor.send(swap, {
        chainId,
        walletAddress,
        baseTokenAddress: resolved,
        quoteTokenAddress: idrxAddress,
        buyAmount: config.DEFAULT_BUY_AMOUNT,
        sellAmount: sellAmount.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
        marketContext: `IDRX top-up (direct): balance ${idrxBalance.toFixed(2)} < ${IDRX_MIN_BALANCE}.`,
      });

      lastIdrxTopupAt = now;
      console.log(`[scheduler] IDRX top-up (direct): ${candidate.symbol}→IDRX tx=${txHash}`);
      await sendTelegramMessage(
        `<b>IDRX Top-up (direct)</b>\n` +
        `IDRX before: ${idrxBalance.toFixed(2)}\n` +
        `Source: ${candidate.symbol}\n` +
        `Tx: ${txHash}`
      );
      return;
    } catch {
      // direct route failed for this candidate, try next
      continue;
    }
  }

  // ── Phase 2: 2-step fallback  fromToken → USDT → IDRX ───────────────────
  console.log("[scheduler] IDRX guard: direct route unavailable, trying 2-step fallback (token→USDT→IDRX)");

  for (const candidate of topPnlTokens) {
    if (candidate.symbol.toLowerCase() === "idrx") continue;
    if (candidate.symbol.toLowerCase() === "usdt") continue;

    const resolved = resolveTokenAddress(candidate.symbol);
    if (!resolved || resolved.toLowerCase() === idrxAddress.toLowerCase()) continue;
    if (resolved.toLowerCase() === usdtAddress.toLowerCase()) continue;

    const position = await getPositionInfo(chainId, resolved, usdtAddress);
    if (position.baseTokenRawBalance <= 0n) continue;

    const sellAmount = (position.baseTokenRawBalance * sellPortion) / 100n;
    if (sellAmount <= 0n) continue;

    // Quote step A: token → USDT
    let stepAOut: bigint;
    try {
      const quoteA = await okx.quoteSwap({
        chainId,
        fromTokenAddress: resolved,
        toTokenAddress: usdtAddress,
        amount: sellAmount.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
      });
      stepAOut = BigInt(quoteA.amountOut || "0");
    } catch {
      continue;
    }
    if (stepAOut <= 0n) continue;

    // Quote step B: USDT → IDRX (use estimated stepAOut as amount)
    try {
      const quoteB = await okx.quoteSwap({
        chainId,
        fromTokenAddress: usdtAddress,
        toTokenAddress: idrxAddress,
        amount: stepAOut.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
      });
      if (BigInt(quoteB.amountOut || "0") <= 0n) continue;
    } catch {
      continue;
    }

    // Execute Step A: token → USDT
    let txHashA: string;
    try {
      const swapA = await okx.buildSwap({
        chainId,
        fromTokenAddress: resolved,
        toTokenAddress: usdtAddress,
        amount: sellAmount.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
        walletAddress,
      });
      txHashA = await executor.send(swapA, {
        chainId,
        walletAddress,
        baseTokenAddress: resolved,
        quoteTokenAddress: usdtAddress,
        buyAmount: config.DEFAULT_BUY_AMOUNT,
        sellAmount: sellAmount.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
        marketContext: `IDRX top-up step-A: ${candidate.symbol}→USDT`,
      });
    } catch (err) {
      console.error(`[scheduler] IDRX top-up step-A failed (${candidate.symbol}→USDT): ${err instanceof Error ? err.message : err}`);
      continue;
    }

    console.log(`[scheduler] IDRX top-up step-A submitted: ${candidate.symbol}→USDT tx=${txHashA}`);
    await sendTelegramMessage(
      `<b>IDRX Top-up Step 1/2</b>\n` +
      `${candidate.symbol}→USDT tx: ${txHashA}\nWaiting for confirmation…`
    );

    // Poll for step A receipt
    const receiptA = await pollTxReceipt(txHashA, 60_000);
    if (receiptA !== "success") {
      console.warn(`[scheduler] IDRX top-up step-A receipt=${receiptA} for ${candidate.symbol}→USDT, aborting.`);
      lastIdrxTopupAt = now - IDRX_TOPUP_COOLDOWN_MS + IDRX_TOPUP_FAIL_COOLDOWN_MS;
      await sendTelegramMessage(`<b>IDRX Top-up Step 1 ${receiptA === "failed" ? "FAILED" : "PENDING"}</b>\nTx: ${txHashA}`);
      return;
    }

    // Read new USDT balance for step B
    const usdtPositionAfter = await getPositionInfo(chainId, usdtAddress, idrxAddress);
    const usdtAvailable = usdtPositionAfter.baseTokenRawBalance;
    if (usdtAvailable <= 0n) {
      console.warn("[scheduler] IDRX top-up: USDT balance 0 after step-A, cannot proceed to step-B.");
      lastIdrxTopupAt = now - IDRX_TOPUP_COOLDOWN_MS + IDRX_TOPUP_FAIL_COOLDOWN_MS;
      return;
    }

    // Use up to SELL_PORTION_PCT of available USDT for step B
    const usdtSellAmount = (usdtAvailable * sellPortion) / 100n;

    // Execute Step B: USDT → IDRX
    let txHashB: string;
    try {
      const swapB = await okx.buildSwap({
        chainId,
        fromTokenAddress: usdtAddress,
        toTokenAddress: idrxAddress,
        amount: usdtSellAmount.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
        walletAddress,
      });
      txHashB = await executor.send(swapB, {
        chainId,
        walletAddress,
        baseTokenAddress: usdtAddress,
        quoteTokenAddress: idrxAddress,
        buyAmount: config.DEFAULT_BUY_AMOUNT,
        sellAmount: usdtSellAmount.toString(),
        slippage: config.DEFAULT_SLIPPAGE,
        marketContext: `IDRX top-up step-B: USDT→IDRX`,
      });
    } catch (err) {
      console.error(`[scheduler] IDRX top-up step-B failed (USDT→IDRX): ${err instanceof Error ? err.message : err}`);
      lastIdrxTopupAt = now - IDRX_TOPUP_COOLDOWN_MS + IDRX_TOPUP_FAIL_COOLDOWN_MS;
      await sendTelegramMessage(`<b>IDRX Top-up Step 2 FAILED</b>\nUSDT→IDRX error. Step-A already done (tx: ${txHashA}).`);
      return;
    }

    // Poll for step B receipt
    const receiptB = await pollTxReceipt(txHashB, 60_000);
    lastIdrxTopupAt = now;
    console.log(`[scheduler] IDRX top-up 2-step complete: ${candidate.symbol}→USDT→IDRX stepB_tx=${txHashB} receipt=${receiptB}`);
    await sendTelegramMessage(
      `<b>IDRX Top-up Complete (2-step)</b>\n` +
      `IDRX before: ${idrxBalance.toFixed(2)}\n` +
      `Path: ${candidate.symbol}→USDT→IDRX\n` +
      `Step-A tx: ${txHashA}\n` +
      `Step-B tx: ${txHashB}\n` +
      `Receipt: ${receiptB}`
    );
    return;
  }

  // ── Phase 3: LI.FI USDT → IDRX directly ────────────────────────────────
  console.log("[scheduler] IDRX guard: trying Phase 3 (LI.FI USDT→IDRX directly)");
  try {
    const usdtPos = await getPositionInfo(chainId, usdtAddress, idrxAddress);
    const usdtBalance = usdtPos.baseTokenRawBalance;
    if (usdtBalance > 0n) {
      const usdtSellAmount = (usdtBalance * sellPortion) / 100n;
      if (usdtSellAmount > 0n) {
        // Use direct viem submission for Li.FI swap to avoid stale/cached tx hash from onchainos.
        const txHash = await executeLifiSwapDirect(usdtAddress, idrxAddress, usdtSellAmount, walletAddress, "5");
        lastIdrxTopupAt = now;
        console.log(`[scheduler] IDRX top-up Phase 3 (LI.FI USDT→IDRX) tx=${txHash}`);
        const receiptStatus = await pollTxReceipt(txHash, 90_000);
        await sendTelegramMessage(
          `<b>IDRX Top-up (LI.FI: USDT→IDRX)</b>\n` +
          `IDRX before: ${idrxBalance.toFixed(2)}\n` +
          `Tx: ${txHash}\nReceipt: ${receiptStatus}`
        );
        return;
      }
    }
    console.warn("[scheduler] IDRX guard Phase 3: no USDT balance or sell amount too small.");
  } catch (lifiErr) {
    console.error(`[scheduler] IDRX guard Phase 3 (LI.FI) failed: ${lifiErr instanceof Error ? lifiErr.message : lifiErr}`);
  }

  // All routes exhausted
  lastIdrxTopupAt = now - IDRX_TOPUP_COOLDOWN_MS + IDRX_TOPUP_FAIL_COOLDOWN_MS;
  console.warn("[scheduler] IDRX guard: all routes (direct + 2-step + LI.FI) failed. Will retry in cooldown.");
}

async function getPositionForScheduledRequest(chainId: string, baseTokenAddress: string, quoteTokenAddress: string) {
  try {
    const positionStartedAt = Date.now();
    const position = await getPositionInfo(chainId, baseTokenAddress, quoteTokenAddress);
    console.log(
      `[scheduler] position: BTCB=${position.baseTokenBalance.toFixed(6)} ($${position.baseTokenValueUsd.toFixed(2)}) USDT=$${position.quoteTokenBalance.toFixed(2)} pnl=${position.unrealizedPnlPct.toFixed(1)}%`
    );
    console.log(`[scheduler] position_fetch duration_ms=${Date.now() - positionStartedAt}`);
    return position;
  } catch (posErr) {
    console.error(`[scheduler] position check failed: ${posErr instanceof Error ? posErr.message : posErr}`);
    return undefined;
  }
}

async function runTradingFlow(bot: AgenticTradingBot, prefetchedPosition?: Promise<Awaited<ReturnType<typeof getPositionForScheduledRequest>>>) {
  const cycleMetricStart = Date.now();
  const request = getScheduledRequest();

  // Inject on-chain wallet pattern signal into market context (non-blocking cache read)
  if (config.WALLET_PATTERN_ENABLED) {
    try {
      const patternSignal = await getWalletPatternSignal();
      if (patternSignal?.contextSummary) {
        request.marketContext = `${request.marketContext ?? ""}\n${patternSignal.contextSummary}`.trim();
        console.log(`[scheduler] wallet_pattern injected: bias=${patternSignal.marketBias} profitable=${patternSignal.profitableWallets} swaps=${patternSignal.totalSwaps}`);
      }
    } catch {
      // non-critical — skip injection on error
    }
  }

  const position = await (prefetchedPosition ?? getPositionForScheduledRequest(request.chainId, request.baseTokenAddress, request.quoteTokenAddress));

  const botRunStartedAt = Date.now();
  const result = await bot.run(request, position);
  console.log(`[scheduler] bot_run duration_ms=${Date.now() - botRunStartedAt}`);
  console.log(`[scheduler] decision=${result.decision.action} confidence=${result.decision.confidence.toFixed(2)} source=${result.decisionSource}`);
  lastDecisionAction = result.decision.action;
  lastDecisionConfidence = result.decision.confidence;
  if (result.decision.reasoning) console.log(`[scheduler] reasoning: ${result.decision.reasoning}`);
  if (result.decision.riskNotes?.length) console.log(`[scheduler] riskNotes: ${result.decision.riskNotes.join("; ")}`);
  if (result.decision.preferredAmount) console.log(`[scheduler] preferredAmount=${result.decision.preferredAmount}`);
  if (result.execution?.mode) {
    lastExecutionMode = result.execution.mode;
    console.log(`[scheduler] execution_mode=${result.execution.mode}`);
    if (result.execution.txHash) console.log(`[scheduler] execution_tx=${result.execution.txHash}`);
    if (result.execution.error) console.log(`[scheduler] execution_error=${result.execution.error}`);
    if (result.execution.receiptStatus) {
      lastReceiptStatus = result.execution.receiptStatus;
      console.log(
        `[scheduler] execution_receipt=${result.execution.receiptStatus}` +
          (result.execution.receiptBlockNumber !== undefined ? ` block=${result.execution.receiptBlockNumber}` : "") +
          (result.execution.receiptGasUsed ? ` gas=${result.execution.receiptGasUsed}` : "")
      );
    }
  }

  if (result.execution?.mode === "sent") {
    if (result.execution.receiptStatus === "failed") {
      receiptFailedStreak += 1;
    } else if (result.execution.receiptStatus === "success") {
      receiptFailedStreak = 0;
      receiptAlertSent = false;
    }

    if (receiptFailedStreak >= 2 && !receiptAlertSent) {
      const alertLines = [
        "<b>OKX Agentic Bot ALERT</b>",
        `Consecutive failed receipts: ${receiptFailedStreak}`,
        `Last tx: ${result.execution.txHash ?? "n/a"}`,
        `Action: ${result.decision.action.toUpperCase()} (${result.decision.confidence.toFixed(2)})`,
        `Reason: ${escapeTelegramHtml(result.decision.reasoning.slice(0, 300))}`
      ];
      await sendTelegramMessage(alertLines.join("\n"));
      receiptAlertSent = true;
    }
  }

  const telegramStartedAt = Date.now();
  await sendTelegramMessage(formatTelegramMessage(result));
  console.log(`[scheduler] decision_telegram duration_ms=${Date.now() - telegramStartedAt}`);

  await recordCycleMetrics(result, Date.now() - cycleMetricStart);

  // Multi-token parallel evaluation: run candidates concurrently if any were found
  if (config.CANDIDATE_SCAN_ENABLED) {
    try {
      const { readFile } = await import("node:fs/promises");
      const candidatesRaw = await readFile("data/bep20-candidates.latest.json", "utf-8").catch(() => "null");
      const candidates = JSON.parse(candidatesRaw);
      if (candidates?.tokens?.length > 0) {
        const tokens = candidates.tokens
          .filter((t: { address: string }) => t.address.toLowerCase() !== request.baseTokenAddress.toLowerCase())
          .slice(0, 5)
          .map((t: { address: string; symbol?: string }) => ({
            baseTokenAddress: t.address,
            label: t.symbol ?? t.address.slice(0, 10),
          }));
        if (tokens.length > 0) {
          console.log(`[scheduler] parallel_eval starting for ${tokens.length} candidate tokens`);
          const parallelStart = Date.now();
          const parallelResults = await runParallelTokens(bot, tokens, {
            chainId: request.chainId,
            walletAddress: request.walletAddress,
            quoteTokenAddress: request.quoteTokenAddress,
            buyAmount: request.buyAmount,
            sellAmount: request.sellAmount,
            slippage: request.slippage,
            marketContext: request.marketContext,
          });
          console.log(`[scheduler] parallel_eval duration_ms=${Date.now() - parallelStart} tokens=${parallelResults.length}`);
          for (const pr of parallelResults) {
            if (pr.result) {
              console.log(`[scheduler]   ${pr.token}: ${pr.result.decision.action} conf=${pr.result.decision.confidence.toFixed(2)} (${pr.durationMs}ms)`);
            } else if (pr.error) {
              console.log(`[scheduler]   ${pr.token}: ERROR ${pr.error}`);
            }
          }
        }
      }
    } catch (parallelErr) {
      console.error(`[scheduler] parallel candidate eval failed: ${parallelErr instanceof Error ? parallelErr.message : parallelErr}`);
    }
  }
}

function escapeTelegramHtml(text: string) {
  return text.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function runScheduledCycle(bot: AgenticTradingBot) {
  if (running) {
    console.log("Scheduled cycle skipped because a previous run is still active.");
    return;
  }

  const cycleStartedAt = Date.now();
  lastCycleStartedAt = cycleStartedAt;
  lastCycleError = undefined;
  running = true;
  cycleAbortController = new AbortController();
  console.log("[scheduler] cycle started");

  // Stuck process recovery: 10-minute timeout kills the cycle and loops back
  const timeoutHandle = setTimeout(() => {
    console.error(`[scheduler] STUCK DETECTED: cycle exceeded ${CYCLE_TIMEOUT_MS / 60000}min timeout. Force-aborting.`);
    cycleAbortController?.abort();
  }, CYCLE_TIMEOUT_MS);

  try {
    // Wrap the entire cycle in an abort-aware promise
    await Promise.race([
      (async () => {
        await enforceIdrxMinimumBalance();

        // Kick off position prefetch immediately so it overlaps with sentiment/candidate scan
        const request = getScheduledRequest();
        const prefetchedPosition = getPositionForScheduledRequest(request.chainId, request.baseTokenAddress, request.quoteTokenAddress);

        // Run sentiment and candidate scan in parallel (independent of each other)
        const [, candidateResult] = await Promise.allSettled([
          runSentimentIfEnabled(bot),
          runCandidateFlowIfEnabled(),
        ]);

        const handledCandidateFlow = candidateResult.status === "fulfilled" && candidateResult.value;
        if (handledCandidateFlow) {
          return;
        }

        await runTradingFlow(bot, prefetchedPosition);
      })(),
      new Promise<never>((_, reject) => {
        cycleAbortController!.signal.addEventListener("abort", () => {
          reject(new Error("CYCLE_TIMEOUT: stuck process killed after 10 minutes"));
        });
      }),
    ]);
    consecutiveTimeouts = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lastCycleError = message;
    const isTimeout = message.includes("CYCLE_TIMEOUT");
    if (isTimeout) {
      consecutiveTimeouts++;
      console.error(`[scheduler] Timeout #${consecutiveTimeouts}. Will restart cycle from beginning.`);
    } else {
      console.error(`[scheduler] ${message}`);
    }
    try {
      const prefix = isTimeout ? "⏰ STUCK TIMEOUT" : "❌ Error";
      await sendTelegramMessage(`<b>OKX Agentic Bot ${prefix}</b>\n${escapeTelegramHtml(message.slice(0, 500))}`);
    } catch (telegramError) {
      console.error(telegramError instanceof Error ? telegramError.message : telegramError);
    }
  } finally {
    clearTimeout(timeoutHandle);
    cycleAbortController = undefined;
    running = false;
    lastCycleFinishedAt = Date.now();
    lastCycleDurationMs = lastCycleFinishedAt - cycleStartedAt;
    console.log(`[scheduler] cycle finished duration_ms=${lastCycleDurationMs}`);
  }
}

export function getSchedulerHealthSnapshot() {
  return {
    scheduleEnabled: config.SCHEDULE_ENABLED,
    running,
    intervalMinutes: config.SCHEDULE_INTERVAL_MINUTES,
    lastCycleStartedAt: lastCycleStartedAt || null,
    lastCycleFinishedAt: lastCycleFinishedAt || null,
    lastCycleDurationMs: lastCycleDurationMs || null,
    lastCycleError: lastCycleError ?? null,
    lastDecisionAction: lastDecisionAction ?? null,
    lastDecisionConfidence: lastDecisionConfidence ?? null,
    lastExecutionMode: lastExecutionMode ?? null,
    lastReceiptStatus: lastReceiptStatus ?? null,
    receiptFailedStreak,
    receiptAlertSent
  };
}

export function startScheduler(bot: AgenticTradingBot) {
  if (!config.SCHEDULE_ENABLED) {
    console.log("Scheduler disabled by configuration.");
    return;
  }

  const intervalMs = Math.max(1, config.SCHEDULE_INTERVAL_MINUTES) * 60_000;
  console.log(`[scheduler] enabled, interval=${config.SCHEDULE_INTERVAL_MINUTES} minute(s)`);

  // Kick off initial wallet pattern scan on startup so cache is warm for first cycle
  if (config.WALLET_PATTERN_ENABLED) {
    const baseToken = process.env["DEFAULT_BASE_TOKEN_ADDRESS"] ?? "";
    if (baseToken) {
      analyzeWalletPatterns(
        baseToken,
        config.WALLET_PATTERN_MIN_PNL_PCT,
        config.WALLET_PATTERN_LOOKBACK_BLOCKS
      ).catch((err: unknown) => {
        console.error(`[scheduler] wallet_pattern startup scan failed: ${err instanceof Error ? err.message : err}`);
      });
      console.log(`[scheduler] wallet_pattern startup scan queued`);
    }
  }

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
