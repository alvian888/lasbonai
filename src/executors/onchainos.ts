import os from "node:os";
import { execFile } from "node:child_process";
import { execSync } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionProvider } from "../executor.js";
import { config } from "../config.js";
import type { SwapBuildResult, TradingRequest } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 3_000;

/** Max amount per single swap chunk (≈ $15 in BTCB at ~75k) to avoid DEX routing failures */
const MAX_CHUNK_WEI = BigInt("200000000000000"); // 200T wei = 0.0002 BTCB

/** BTCB address for chunk-sell logic (only split sells from BTCB, not buys with USDT) */
const BTCB_ADDRESS = "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c";
const USDT_BSC_ADDRESS = "0x55d398326f99059ff775485246999027b3197955";
const BTT_ADDRESS = "0x352cb5e19b12fc216548a2677bd0fce83bae434b";
const PANCAKE_V3_SMART_ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4";
const LIFI_ROUTER_ADDRESS = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const LIFI_API_URL = "https://li.quest/v1/quote";
const LIFI_API_TIMEOUT_MS = 10_000;
const BSC_CHAIN_ID = "56";
const PCS_BTT_POOL_FEE = 2500;
const MAX_APPROVAL_UINT256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const BSC_PUBLIC_RPC = "https://bsc-dataseed.bnbchain.org";
const TX_BROADCAST_VERIFY_ATTEMPTS = 12;
const TX_BROADCAST_VERIFY_DELAY_MS = 1_000;
const DIRECT_FALLBACK_MAX_ATTEMPTS = 3;
const USDT_BTT_METRIC_LOG_EVERY_EVENTS = 5;
const USDT_BTT_METRIC_LOG_INTERVAL_MS = 15 * 60 * 1000;

const usdtBttMetrics = {
  totalEvents: 0,
  normalSuccess: 0,
  normalFailure: 0,
  fallbackSuccess: 0,
  fallbackFailure: 0,
  lifiSuccess: 0,
  lifiFailure: 0,
  recoverySuccess: 0,
  recoveryFailure: 0,
  lastSummaryAt: Date.now(),
};

function resolveOnchainosBin() {
  return process.env.ONCHAINOS_BIN || `${os.homedir()}/.local/bin/onchainos`;
}

function detectRouterFlagSupport(bin: string): boolean {
  if (!REQUESTED_ROUTER || REQUESTED_ROUTER === "auto") return false;
  try {
    const help = execSync(`${bin} swap quote --help`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return help.includes("--router");
  } catch {
    return false;
  }
}

const REQUESTED_ROUTER = (config.ONCHAINOS_ROUTER_PREFERENCE || "").trim().toLowerCase();
const ONCHAINOS_BIN_PATH = resolveOnchainosBin();
const ONCHAINOS_ROUTER_FLAG_SUPPORTED = detectRouterFlagSupport(ONCHAINOS_BIN_PATH);
const ONCHAINOS_ROUTER_STRICT = Boolean(config.ONCHAINOS_ROUTER_STRICT);
const ONCHAINOS_ROUTER_EFFECTIVE_MODE =
  !REQUESTED_ROUTER || REQUESTED_ROUTER === "auto"
    ? "auto"
    : ONCHAINOS_ROUTER_FLAG_SUPPORTED
      ? `forced:${REQUESTED_ROUTER}`
      : "fallback:no-router-flag";

console.log(
  `[onchainos-executor] router preference requested=${REQUESTED_ROUTER || "auto"} ` +
    `supported=${ONCHAINOS_ROUTER_FLAG_SUPPORTED} effective=${ONCHAINOS_ROUTER_EFFECTIVE_MODE} strict=${ONCHAINOS_ROUTER_STRICT}`,
);

if (
  ONCHAINOS_ROUTER_STRICT &&
  REQUESTED_ROUTER &&
  REQUESTED_ROUTER !== "auto" &&
  !ONCHAINOS_ROUTER_FLAG_SUPPORTED
) {
  throw new Error(
    `[onchainos-executor] strict router mode enabled but --router is unsupported by onchainos binary (${ONCHAINOS_BIN_PATH})`,
  );
}

function getSwapRouterArgs(): string[] {
  if (!REQUESTED_ROUTER || REQUESTED_ROUTER === "auto") return [];
  if (!ONCHAINOS_ROUTER_FLAG_SUPPORTED) return [];
  return ["--router", REQUESTED_ROUTER];
}

function isUnsupportedRouterFlagError(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes("unexpected argument '--router'") ||
    lower.includes("unknown option '--router'") ||
    lower.includes("unknown option \"--router\"") ||
    lower.includes("unknown flag: --router") ||
    lower.includes("flag provided but not defined: -router");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function stripHexPrefix(value: string): string {
  return value.startsWith("0x") ? value.slice(2) : value;
}

function padHex(value: string, bytes = 32): string {
  return stripHexPrefix(value).toLowerCase().padStart(bytes * 2, "0");
}

function encodeApproveCalldata(spender: string, amountHex: string): string {
  // approve(address,uint256)
  return `0x095ea7b3${padHex(spender)}${padHex(amountHex)}`;
}

function encodeExactInputSingleCalldata(
  tokenIn: string,
  tokenOut: string,
  fee: number,
  recipient: string,
  amountIn: bigint,
  amountOutMinimum: bigint,
): string {
  // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  const selector = "04e45aaf";
  const encoded = [
    padHex(tokenIn),
    padHex(tokenOut),
    padHex(`0x${fee.toString(16)}`),
    padHex(recipient),
    padHex(`0x${amountIn.toString(16)}`),
    padHex(`0x${amountOutMinimum.toString(16)}`),
    padHex("0x0"), // sqrtPriceLimitX96
  ].join("");

  return `0x${selector}${encoded}`;
}

function toSlippageBps(slippagePctRaw: string | undefined): bigint {
  const parsed = Number.parseFloat(slippagePctRaw || "");
  const pct = Number.isFinite(parsed) && parsed > 0 ? parsed : 0.5;
  return BigInt(Math.max(0, Math.round(pct * 100)));
}

function applySlippageFloor(amountOutQuote: bigint, slippageBps: bigint): bigint {
  const BPS_DENOM = 10_000n;
  const safeBps = slippageBps >= BPS_DENOM ? BPS_DENOM - 1n : slippageBps;
  return (amountOutQuote * (BPS_DENOM - safeBps)) / BPS_DENOM;
}

function isUsdtToBttPair(fromTokenAddress: string, toTokenAddress: string, chainId: string): boolean {
  return (
    chainId === BSC_CHAIN_ID &&
    fromTokenAddress.toLowerCase() === USDT_BSC_ADDRESS &&
    toTokenAddress.toLowerCase() === BTT_ADDRESS
  );
}

function resolveRpcUrlForChain(chainId: string): string | null {
  if (chainId === BSC_CHAIN_ID) {
    return process.env.EVM_RPC_URL || BSC_PUBLIC_RPC;
  }
  return null;
}

async function isTxBroadcasted(rpcUrl: string, txHash: string): Promise<boolean> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getTransactionByHash",
      params: [txHash],
    }),
  });

  if (!response.ok) {
    return false;
  }

  const payload = (await response.json()) as { result?: unknown };
  return !!payload.result;
}

async function assertTxBroadcasted(chainId: string, txHash: string, label: string): Promise<void> {
  const rpcUrl = resolveRpcUrlForChain(chainId);
  if (!rpcUrl) {
    return;
  }

  for (let i = 0; i < TX_BROADCAST_VERIFY_ATTEMPTS; i++) {
    try {
      if (await isTxBroadcasted(rpcUrl, txHash)) {
        return;
      }
    } catch {
      // Ignore transient RPC errors during verification window.
    }
    await sleep(TX_BROADCAST_VERIFY_DELAY_MS);
  }

  throw new Error(`${label} returned tx hash not found on RPC after verification window: ${txHash}`);
}

function shouldFallbackOnExecutionError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes("insufficient liquidity") ||
    lower.includes("no route") ||
    lower.includes("simulation failed")
  );
}

function logUsdtBttRoute(stage: string, details: string): void {
  console.log(`[onchainos-executor][usdt-btt][${stage}] ${details}`);
}

function bumpUsdtBttMetric(
  key:
    | "normalSuccess"
    | "normalFailure"
    | "fallbackSuccess"
    | "fallbackFailure"
    | "lifiSuccess"
    | "lifiFailure"
    | "recoverySuccess"
    | "recoveryFailure",
): void {
  usdtBttMetrics.totalEvents += 1;
  usdtBttMetrics[key] += 1;

  const now = Date.now();
  const shouldLogByCount = usdtBttMetrics.totalEvents % USDT_BTT_METRIC_LOG_EVERY_EVENTS === 0;
  const shouldLogByTime = now - usdtBttMetrics.lastSummaryAt >= USDT_BTT_METRIC_LOG_INTERVAL_MS;
  if (!shouldLogByCount && !shouldLogByTime) {
    return;
  }

  usdtBttMetrics.lastSummaryAt = now;
  console.log(
    `[onchainos-executor][usdt-btt][summary] total=${usdtBttMetrics.totalEvents}` +
      ` normal_ok=${usdtBttMetrics.normalSuccess}` +
      ` normal_fail=${usdtBttMetrics.normalFailure}` +
      ` fallback_ok=${usdtBttMetrics.fallbackSuccess}` +
      ` fallback_fail=${usdtBttMetrics.fallbackFailure}` +
      ` lifi_ok=${usdtBttMetrics.lifiSuccess}` +
      ` lifi_fail=${usdtBttMetrics.lifiFailure}` +
      ` recovery_ok=${usdtBttMetrics.recoverySuccess}` +
      ` recovery_fail=${usdtBttMetrics.recoveryFailure}`,
  );
}

/** Check if the error message indicates a transient/retryable failure */
function isRetryable(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  
  // Do NOT retry true balance/allowance errors - they won't fix themselves
  const nonRetryablePatterns = [
    "insufficient",
    "exceeds balance",
    "transfer amount exceeds",
    "exceeds the single transaction limit",
  ];
  if (nonRetryablePatterns.some((p) => lower.includes(p.toLowerCase()))) {
    return false;
  }

  // DEX routing simulation failures are transient — aggregator picks different routes
  const retryablePatterns = [
    "timeout",
    "ECONNRESET",
    "ETIMEDOUT",
    "network error",
    "nonce too low",
    "safeerc20",
    "low-level call failed",
    "execution reverted",
    "simulation failed",
    "allowance",
    "min return",
  ];
  return retryablePatterns.some((p) => lower.includes(p.toLowerCase()));
}

/** Slippage tiers for retry escalation (percentage values for onchainos CLI) */
const SLIPPAGE_TIERS = [0.5, 1, 1.5];

/** Move to the next higher slippage tier */
function escalateSlippage(current: number): number {
  const idx = SLIPPAGE_TIERS.findIndex((t) => t > current);
  return idx >= 0 ? SLIPPAGE_TIERS[idx] : SLIPPAGE_TIERS[SLIPPAGE_TIERS.length - 1];
}

/**
 * Run onchainos CLI, handling non-zero exit codes by parsing JSON from
 * stdout/stderr instead of just throwing "Command failed".
 */
async function runOnchainos(
  bin: string,
  args: string[],
): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync(bin, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    });
    return JSON.parse(stdout);
  } catch (err: unknown) {
    // execFileAsync rejects on non-zero exit; stdout/stderr live on the error
    const execErr = err as { stdout?: string; stderr?: string; message?: string };
    const raw = execErr.stdout || execErr.stderr || "";
    // Try to extract JSON from the output
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch { /* fall through */ }
    }
    throw new Error(
      `onchainos CLI failed: ${execErr.message || "unknown error"}${raw ? ` | output: ${raw.slice(0, 500)}` : ""}`,
    );
  }
}

export class OnchainosExecutor implements ExecutionProvider {
  readonly name = "onchainos" as const;

  async send(transaction: SwapBuildResult, _request: TradingRequest): Promise<string> {
    const swapParams = (transaction.raw as Record<string, unknown> | null)?._swapParams as
      | { fromTokenAddress: string; toTokenAddress: string; amount: string; chainId: string; slippage: string; walletAddress?: string }
      | undefined;

    if (!swapParams) {
      throw new Error("Missing _swapParams in swap build result — onchainos executor requires swap params from buildSwap");
    }

    const wallet = swapParams.walletAddress || _request.walletAddress;
    if (!wallet) {
      throw new Error("onchainos executor requires a wallet address");
    }

    const totalAmount = BigInt(swapParams.amount);
    const bin = resolveOnchainosBin();

    // OpenOcean occasionally returns broken inAmount scaling for USDT->BTT (1e36 instead of 1e18).
    // If detected, use direct Pancake V3 route via exactInputSingle as fallback.
    const isUsdtToBtt = isUsdtToBttPair(
      swapParams.fromTokenAddress,
      swapParams.toTokenAddress,
      swapParams.chainId,
    );

    if (await this.shouldUseDirectPancakeFallback(bin, swapParams, totalAmount)) {
      logUsdtBttRoute("preflight", "amount anomaly detected; selecting direct fallback");
      try {
        return await this.executeDirectPancakeBttSwap(bin, wallet, totalAmount, swapParams.slippage);
      } catch (fallbackErr) {
        logUsdtBttRoute("fallback", `direct route failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
        if (isUsdtToBtt) {
          return this.recoverUsdtBttViaOnchainosExecute(
            bin,
            swapParams,
            wallet,
            `direct fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
          );
        }
        throw fallbackErr;
      }
    }

    // Split large BTCB sells into chunks to avoid DEX aggregator routing failures
    // Only chunk when selling BTCB (small wei amounts), NOT when buying with USDT (large wei amounts)
    const isSellingBtcb = swapParams.fromTokenAddress.toLowerCase() === BTCB_ADDRESS;
    if (isSellingBtcb && totalAmount > MAX_CHUNK_WEI) {
      return this.executeChunked(bin, swapParams, wallet, totalAmount);
    }

    try {
      const normalTx = await this.executeSingle(
        bin,
        swapParams,
        wallet,
        swapParams.amount,
        isUsdtToBtt ? "normal" : "default",
      );
      if (isUsdtToBtt) {
        bumpUsdtBttMetric("normalSuccess");
      }
      return normalTx;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isUsdtToBtt && shouldFallbackOnExecutionError(msg)) {
        bumpUsdtBttMetric("normalFailure");
        logUsdtBttRoute("normal", `failed: ${msg}`);
        console.warn(`[onchainos-executor] execute failed for USDT->BTT (${msg}); forcing direct Pancake V3 fallback`);
        try {
          return await this.executeDirectPancakeBttSwap(bin, wallet, totalAmount, swapParams.slippage);
        } catch (fallbackErr) {
          logUsdtBttRoute("fallback", `failed after normal error: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
          return this.recoverUsdtBttViaOnchainosExecute(
            bin,
            swapParams,
            wallet,
            `direct fallback failed after execute error: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
          );
        }
      }
      throw err;
    }
  }

  private async recoverUsdtBttViaOnchainosExecute(
    bin: string,
    swapParams: { fromTokenAddress: string; toTokenAddress: string; amount: string; chainId: string; slippage: string },
    wallet: string,
    trigger: string,
  ): Promise<string> {
    const configured = Number.parseFloat(swapParams.slippage || "0.5");
    const candidates = [configured, ...SLIPPAGE_TIERS.filter((tier) => tier > configured)]
      .filter((val, idx, arr) => Number.isFinite(val) && arr.indexOf(val) === idx);

    let lastError: Error | null = null;
    console.warn(`[onchainos-executor] USDT->BTT recovery trigger: ${trigger}`);
    logUsdtBttRoute("recovery", `triggered: ${trigger}`);

    for (const slippage of candidates) {
      try {
        const recoveredTx = await this.executeSingle(
          bin,
          { ...swapParams, slippage: String(slippage) },
          wallet,
          swapParams.amount,
          `recovery@${slippage}`,
        );
        console.warn(`[onchainos-executor] USDT->BTT recovery succeeded via onchainos execute at slippage=${slippage}% tx=${recoveredTx}`);
        logUsdtBttRoute("recovery", `success at slippage=${slippage}% tx=${recoveredTx}`);
        bumpUsdtBttMetric("recoverySuccess");
        return recoveredTx;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[onchainos-executor] USDT->BTT recovery attempt failed at slippage=${slippage}%: ${lastError.message}`);
        logUsdtBttRoute("recovery", `failed at slippage=${slippage}% reason=${lastError.message}`);
      }
    }

    // All onchainos slippage tiers failed — attempt Li.FI as final alternative routing path
    logUsdtBttRoute("lifi", "all onchainos recovery tiers failed; attempting Li.FI fallback");
    try {
      const lifiTx = await this.executeLifiFallbackSwap(bin, wallet, BigInt(swapParams.amount), swapParams.slippage);
      return lifiTx;
    } catch (lifiErr) {
      const lifiMsg = lifiErr instanceof Error ? lifiErr.message : String(lifiErr);
      logUsdtBttRoute("lifi", `failed: ${lifiMsg}`);
      bumpUsdtBttMetric("lifiFailure");
    }

    bumpUsdtBttMetric("recoveryFailure");

    throw new Error(
      `USDT->BTT recovery failed after fallback, slippage-tier retries, and Li.FI: ${lastError?.message || "unknown error"}`,
    );
  }

  /**
   * Fetch a pre-encoded USDT→BTT swap transaction from the Li.FI routing API
   * (router 0x1231DEB6…) and submit it via onchainos wallet contract-call.
   * Used as a last-resort alternative after Pancake V3 direct and onchainos
   * slippage-tier recovery have both failed.
   */
  private async executeLifiFallbackSwap(
    bin: string,
    wallet: string,
    amountIn: bigint,
    slippagePct: string | undefined,
  ): Promise<string> {
    const slippageFraction = (Number.parseFloat(slippagePct || "0.5") / 100).toFixed(4);
    const url =
      `${LIFI_API_URL}?fromChain=${BSC_CHAIN_ID}&toChain=${BSC_CHAIN_ID}` +
      `&fromToken=${USDT_BSC_ADDRESS}&toToken=${BTT_ADDRESS}` +
      `&fromAmount=${amountIn.toString()}&fromAddress=${wallet}` +
      `&slippage=${slippageFraction}`;

    logUsdtBttRoute("lifi", `fetching quote fromAmount=${amountIn} slippage=${slippageFraction}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LIFI_API_TIMEOUT_MS);

    let txCalldata: string;
    let gasLimit: string;
    let toAmountMin: string;

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`Li.FI API HTTP ${response.status}`);
      }
      const quote = (await response.json()) as {
        transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string };
        estimate?: { toAmountMin?: string };
      };
      const tx = quote.transactionRequest;
      if (!tx?.data || !tx?.to) {
        throw new Error(`Li.FI API returned invalid transactionRequest: ${JSON.stringify(quote).slice(0, 200)}`);
      }
      if (tx.to.toLowerCase() !== LIFI_ROUTER_ADDRESS.toLowerCase()) {
        throw new Error(`Li.FI quote returned unexpected router: ${tx.to}`);
      }
      txCalldata = tx.data;
      gasLimit = tx.gasLimit ? String(parseInt(tx.gasLimit, 16)) : "600000";
      toAmountMin = quote.estimate?.toAmountMin || "0";
    } catch (err) {
      clearTimeout(timeoutId);
      throw new Error(`Li.FI API fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Approve Li.FI diamond to spend USDT (idempotent, max allowance)
    const approveData = encodeApproveCalldata(LIFI_ROUTER_ADDRESS, MAX_APPROVAL_UINT256);
    await runOnchainos(bin, [
      "wallet", "contract-call",
      "--to", USDT_BSC_ADDRESS,
      "--chain", BSC_CHAIN_ID,
      "--input-data", approveData,
      "--gas-limit", "50000",
      "--force",
    ]);

    // Submit pre-encoded Li.FI calldata
    const swapResult = await runOnchainos(bin, [
      "wallet", "contract-call",
      "--to", LIFI_ROUTER_ADDRESS,
      "--chain", BSC_CHAIN_ID,
      "--input-data", txCalldata,
      "--gas-limit", gasLimit,
      "--force",
    ]);

    const data = (
      typeof swapResult.data === "object" && swapResult.data !== null ? swapResult.data : swapResult
    ) as Record<string, unknown>;
    const txHash = String(data.swapTxHash || data.txHash || swapResult.swapTxHash || swapResult.txHash || "");
    if (!txHash || txHash === "null" || txHash === "undefined") {
      throw new Error(`Li.FI fallback returned no tx hash: ${JSON.stringify(swapResult).slice(0, 300)}`);
    }

    await assertTxBroadcasted(BSC_CHAIN_ID, txHash, "Li.FI fallback");

    console.log(`[onchainos-executor] Li.FI fallback tx=${txHash} toAmountMin=${toAmountMin}`);
    logUsdtBttRoute("lifi", `success tx=${txHash} toAmountMin=${toAmountMin}`);
    bumpUsdtBttMetric("lifiSuccess");
    return txHash;
  }

  /**
   * Generic Li.FI swap for any ERC-20→ERC-20 pair on BSC.
   * Approves `fromToken` for the Li.FI router (idempotent max allowance) then
   * executes the pre-encoded calldata via onchainos wallet contract-call.
   */
  async executeLifiSwap(
    fromToken: string,
    toToken: string,
    amountIn: bigint,
    wallet: string,
    slippagePct?: string,
  ): Promise<string> {
    const bin = resolveOnchainosBin();
    const slippageFraction = (Number.parseFloat(slippagePct || "0.5") / 100).toFixed(4);
    const url =
      `${LIFI_API_URL}?fromChain=${BSC_CHAIN_ID}&toChain=${BSC_CHAIN_ID}` +
      `&fromToken=${fromToken}&toToken=${toToken}` +
      `&fromAmount=${amountIn.toString()}&fromAddress=${wallet}` +
      `&slippage=${slippageFraction}`;

    console.log(`[onchainos-executor] Li.FI swap fetching quote fromToken=${fromToken} toToken=${toToken} amountIn=${amountIn}`);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LIFI_API_TIMEOUT_MS);

    let txCalldata: string;
    let gasLimit: string;
    let toAmountMin: string;

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        throw new Error(`Li.FI API HTTP ${response.status}: ${errBody.slice(0, 200)}`);
      }
      const quote = (await response.json()) as {
        transactionRequest?: { to?: string; data?: string; value?: string; gasLimit?: string };
        estimate?: { toAmountMin?: string };
      };
      const tx = quote.transactionRequest;
      if (!tx?.data || !tx?.to) {
        throw new Error(`Li.FI API returned invalid transactionRequest: ${JSON.stringify(quote).slice(0, 200)}`);
      }
      if (tx.to.toLowerCase() !== LIFI_ROUTER_ADDRESS.toLowerCase()) {
        throw new Error(`Li.FI quote returned unexpected router: ${tx.to}`);
      }
      txCalldata = tx.data;
      gasLimit = tx.gasLimit ? String(parseInt(tx.gasLimit, 16) + 50_000) : "650000";
      toAmountMin = quote.estimate?.toAmountMin || "0";
    } catch (err) {
      clearTimeout(timeoutId);
      throw new Error(`Li.FI API fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Approve Li.FI router to spend fromToken (idempotent max allowance)
    const approveData = encodeApproveCalldata(LIFI_ROUTER_ADDRESS, MAX_APPROVAL_UINT256);
    await runOnchainos(bin, [
      "wallet", "contract-call",
      "--to", fromToken,
      "--chain", BSC_CHAIN_ID,
      "--input-data", approveData,
      "--gas-limit", "50000",
      "--force",
    ]);

    // Submit pre-encoded Li.FI calldata
    const swapResult = await runOnchainos(bin, [
      "wallet", "contract-call",
      "--to", LIFI_ROUTER_ADDRESS,
      "--chain", BSC_CHAIN_ID,
      "--input-data", txCalldata,
      "--gas-limit", gasLimit,
      "--force",
    ]);

    const data = (
      typeof swapResult.data === "object" && swapResult.data !== null ? swapResult.data : swapResult
    ) as Record<string, unknown>;
    const txHash = String(data.swapTxHash || data.txHash || swapResult.swapTxHash || swapResult.txHash || "");
    if (!txHash || txHash === "null" || txHash === "undefined") {
      throw new Error(`Li.FI swap returned no tx hash: ${JSON.stringify(swapResult).slice(0, 300)}`);
    }

    // Soft broadcast check — don't throw if tx not yet indexed on RPC; caller polls receipt
    try {
      await assertTxBroadcasted(BSC_CHAIN_ID, txHash, "Li.FI generic swap");
    } catch {
      console.warn(`[onchainos-executor] Li.FI swap tx=${txHash} not yet indexed on RPC (caller will poll receipt)`);
    }
    console.log(`[onchainos-executor] Li.FI swap tx=${txHash} toAmountMin=${toAmountMin}`);
    return txHash;
  }

  private async shouldUseDirectPancakeFallback(
    bin: string,
    swapParams: { fromTokenAddress: string; toTokenAddress: string; amount: string; chainId: string },
    requestedAmount: bigint,
  ): Promise<boolean> {
    const isUsdtToBtt = isUsdtToBttPair(
      swapParams.fromTokenAddress,
      swapParams.toTokenAddress,
      swapParams.chainId,
    );

    if (!isUsdtToBtt) {
      return false;
    }

    try {
      const quote = await runOnchainos(bin, [
        "swap",
        "quote",
        "--from",
        swapParams.fromTokenAddress,
        "--to",
        swapParams.toTokenAddress,
        "--amount",
        swapParams.amount,
        "--chain",
        swapParams.chainId,
        ...getSwapRouterArgs(),
      ]);

      const quoteItem = Array.isArray(quote.data) ? (quote.data[0] as Record<string, unknown> | undefined) : undefined;
      const quoteIn = BigInt(String(quoteItem?.fromTokenAmount ?? swapParams.amount));

      // If quoted in amount is 10x larger than requested, treat as broken scaling.
      const isAnomalous = quoteIn > (requestedAmount * 10n);
      if (isAnomalous) {
        console.warn(
          `[onchainos-executor] detected amount anomaly for USDT->BTT: requested=${requestedAmount} quoteIn=${quoteIn}; using direct Pancake V3 fallback`,
        );
      }
      return isAnomalous;
    } catch (err) {
      // If quote preflight fails, do not block normal execution path.
      console.warn(`[onchainos-executor] quote preflight failed, skipping fallback detection: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private async executeDirectPancakeBttSwap(
    bin: string,
    wallet: string,
    amountIn: bigint,
    slippagePct: string | undefined,
  ): Promise<string> {
    const quote = await runOnchainos(bin, [
      "swap",
      "quote",
      "--from",
      USDT_BSC_ADDRESS,
      "--to",
      BTT_ADDRESS,
      "--amount",
      amountIn.toString(),
      "--chain",
      BSC_CHAIN_ID,
      ...getSwapRouterArgs(),
    ]);
    const quoteItem = Array.isArray(quote.data) ? (quote.data[0] as Record<string, unknown> | undefined) : undefined;
    const quotedOut = BigInt(String(quoteItem?.toTokenAmount ?? "0"));
    if (quotedOut <= 0n) {
      throw new Error(`direct Pancake V3 fallback quote returned invalid output amount: ${JSON.stringify(quoteItem || quote)}`);
    }

    const slippageBps = toSlippageBps(slippagePct);
    const amountOutMinimum = applySlippageFloor(quotedOut, slippageBps);

    const approveData = encodeApproveCalldata(PANCAKE_V3_SMART_ROUTER, MAX_APPROVAL_UINT256);
    const swapData = encodeExactInputSingleCalldata(
      USDT_BSC_ADDRESS,
      BTT_ADDRESS,
      PCS_BTT_POOL_FEE,
      wallet,
      amountIn,
      amountOutMinimum,
    );

    // Keep approval idempotent: repeated approve(max) is safe.
    await runOnchainos(bin, [
      "wallet",
      "contract-call",
      "--to",
      USDT_BSC_ADDRESS,
      "--chain",
      BSC_CHAIN_ID,
      "--input-data",
      approveData,
      "--gas-limit",
      "50000",
      "--force",
    ]);

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= DIRECT_FALLBACK_MAX_ATTEMPTS; attempt++) {
      try {
        const swapResult = await runOnchainos(bin, [
          "wallet",
          "contract-call",
          "--to",
          PANCAKE_V3_SMART_ROUTER,
          "--chain",
          BSC_CHAIN_ID,
          "--input-data",
          swapData,
          "--gas-limit",
          "300000",
          "--force",
        ]);

        const data = (typeof swapResult.data === "object" && swapResult.data !== null ? swapResult.data : swapResult) as Record<string, unknown>;
        const txHash = String(data.swapTxHash || data.txHash || swapResult.swapTxHash || swapResult.txHash || "");
        if (!txHash || txHash === "null" || txHash === "undefined") {
          throw new Error(`direct Pancake V3 fallback returned no tx hash: ${JSON.stringify(swapResult)}`);
        }

        await assertTxBroadcasted(BSC_CHAIN_ID, txHash, "direct Pancake V3 fallback");

        console.log(
          `[onchainos-executor] direct Pancake V3 fallback tx=${txHash} quoteOut=${quotedOut} minOut=${amountOutMinimum} slippageBps=${slippageBps} attempt=${attempt}/${DIRECT_FALLBACK_MAX_ATTEMPTS}`,
        );
        logUsdtBttRoute(
          "fallback",
          `success tx=${txHash} minOut=${amountOutMinimum} attempt=${attempt}/${DIRECT_FALLBACK_MAX_ATTEMPTS}`,
        );
        bumpUsdtBttMetric("fallbackSuccess");
        return txHash;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < DIRECT_FALLBACK_MAX_ATTEMPTS) {
          console.warn(
            `[onchainos-executor] direct fallback attempt ${attempt}/${DIRECT_FALLBACK_MAX_ATTEMPTS} failed: ${lastError.message}; retrying...`,
          );
          logUsdtBttRoute("fallback", `attempt ${attempt}/${DIRECT_FALLBACK_MAX_ATTEMPTS} failed: ${lastError.message}`);
          await sleep(1_500);
          continue;
        }
      }
    }

    bumpUsdtBttMetric("fallbackFailure");

    throw lastError || new Error("direct Pancake V3 fallback failed after retries");
  }

  private async executeChunked(
    bin: string,
    swapParams: { fromTokenAddress: string; toTokenAddress: string; chainId: string; slippage: string },
    wallet: string,
    totalAmount: bigint,
  ): Promise<string> {
    const chunks: bigint[] = [];
    let remaining = totalAmount;
    while (remaining > 0n) {
      const chunk = remaining > MAX_CHUNK_WEI ? MAX_CHUNK_WEI : remaining;
      chunks.push(chunk);
      remaining -= chunk;
    }

    console.log(`[onchainos-executor] chunked sell: ${chunks.length} chunks for total ${totalAmount} wei`);

    let lastTxHash = "";
    for (let i = 0; i < chunks.length; i++) {
      const chunkStr = chunks[i].toString();
      console.log(`[onchainos-executor] chunk ${i + 1}/${chunks.length}: ${chunkStr} wei`);
      lastTxHash = await this.executeSingle(bin, swapParams, wallet, chunkStr);
      // Brief pause between chunks to let the chain settle
      if (i < chunks.length - 1) {
        await sleep(2_000);
      }
    }

    return lastTxHash;
  }

  private async executeSingle(
    bin: string,
    swapParams: { fromTokenAddress: string; toTokenAddress: string; chainId: string; slippage: string },
    wallet: string,
    amount: string,
    routeTag = "default",
  ): Promise<string> {
    // Resolve initial slippage: use configured value, then find starting tier index
    const configuredSlippage = parseFloat(swapParams.slippage) || SLIPPAGE_TIERS[0];
    let currentSlippage = configuredSlippage;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_RETRY_DELAY_MS * (2 ** (attempt - 1)); // exponential backoff
        console.log(`[onchainos-executor] retry ${attempt}/${MAX_RETRIES} after ${delay}ms (slippage=${currentSlippage}%)`);
        await sleep(delay);
      }

      const args = [
        "swap", "execute",
        "--from", swapParams.fromTokenAddress,
        "--to", swapParams.toTokenAddress,
        "--amount", amount,
        "--chain", swapParams.chainId,
        "--wallet", wallet,
        "--slippage", String(currentSlippage),
        "--gas-level", "fast",
      ];

      const argsWithRouter = [...args, ...getSwapRouterArgs()];

      console.log(`[onchainos-executor][route=${routeTag}] ${bin} ${argsWithRouter.join(" ")}`);

      let result: Record<string, unknown>;
      try {
        result = await runOnchainos(bin, argsWithRouter);
      } catch (err) {
        lastError = err as Error;
        if (getSwapRouterArgs().length > 0 && isUnsupportedRouterFlagError(lastError.message)) {
          console.warn("[onchainos-executor] --router flag unsupported by onchainos binary, retrying without router flag");
          result = await runOnchainos(bin, args);
        } else {
          if (isRetryable(lastError.message) && attempt < MAX_RETRIES) {
            // Escalate slippage on "min return" errors
            if (lastError.message.toLowerCase().includes("min return")) {
              currentSlippage = escalateSlippage(currentSlippage);
            }
            continue;
          }
          throw lastError;
        }
      }

      // Check for API-level error in the parsed JSON
      const errorMsg = String(result.error || "");
      if (errorMsg) {
        lastError = new Error(`onchainos execute error: ${errorMsg}`);
        if (isRetryable(errorMsg) && attempt < MAX_RETRIES) {
          // Escalate slippage on "min return" errors
          if (errorMsg.toLowerCase().includes("min return")) {
            currentSlippage = escalateSlippage(currentSlippage);
          }
          continue;
        }
        throw lastError;
      }

      // Extract tx hash — onchainos nests under result.data
      const data = (typeof result.data === "object" && result.data !== null ? result.data : result) as Record<string, unknown>;
      const txHash = String(data.swapTxHash || data.txHash || result.swapTxHash || result.txHash || "");
      const approveTxHash = String(data.approveTxHash || result.approveTxHash || "");

      if (!txHash || txHash === "null" || txHash === "undefined") {
        throw new Error(`onchainos execute returned no tx hash: ${JSON.stringify(result)}`);
      }

      console.log(`[onchainos-executor][route=${routeTag}] tx=${txHash} approve=${approveTxHash || "none"}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`);
      return txHash;
    }

    throw lastError || new Error("onchainos execute failed after retries");
  }
}
