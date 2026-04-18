import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecutionProvider } from "../executor.js";
import type { SwapBuildResult, TradingRequest } from "../types.js";

const execFileAsync = promisify(execFile);

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5_000;

function resolveOnchainosBin() {
  return process.env.ONCHAINOS_BIN || `${os.homedir()}/.local/bin/onchainos`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Check if the error message indicates a transient/retryable failure */
function isRetryable(errorMsg: string): boolean {
  const retryablePatterns = [
    "simulation failed",
    "estimateGas error",
    "low-level call failed",
    "timeout",
    "ECONNRESET",
    "ETIMEDOUT",
    "network error",
  ];
  const lower = errorMsg.toLowerCase();
  return retryablePatterns.some((p) => lower.includes(p.toLowerCase()));
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

    const bin = resolveOnchainosBin();
    const args = [
      "swap", "execute",
      "--from", swapParams.fromTokenAddress,
      "--to", swapParams.toTokenAddress,
      "--amount", swapParams.amount,
      "--chain", swapParams.chainId,
      "--wallet", wallet,
      "--slippage", swapParams.slippage || "1",
      "--gas-level", "fast",
    ];

    console.log(`[onchainos-executor] ${bin} ${args.join(" ")}`);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        console.log(`[onchainos-executor] retry ${attempt}/${MAX_RETRIES} after ${RETRY_DELAY_MS}ms`);
        await sleep(RETRY_DELAY_MS);
      }

      let result: Record<string, unknown>;
      try {
        result = await runOnchainos(bin, args);
      } catch (err) {
        lastError = err as Error;
        if (isRetryable(lastError.message) && attempt < MAX_RETRIES) continue;
        throw lastError;
      }

      // Check for API-level error in the parsed JSON
      const errorMsg = String(result.error || "");
      if (errorMsg) {
        lastError = new Error(`onchainos execute error: ${errorMsg}`);
        if (isRetryable(errorMsg) && attempt < MAX_RETRIES) continue;
        throw lastError;
      }

      // Extract tx hash — onchainos nests under result.data
      const data = (typeof result.data === "object" && result.data !== null ? result.data : result) as Record<string, unknown>;
      const txHash = String(data.swapTxHash || data.txHash || result.swapTxHash || result.txHash || "");
      const approveTxHash = String(data.approveTxHash || result.approveTxHash || "");

      if (!txHash || txHash === "null" || txHash === "undefined") {
        throw new Error(`onchainos execute returned no tx hash: ${JSON.stringify(result)}`);
      }

      console.log(`[onchainos-executor] tx=${txHash} approve=${approveTxHash || "none"}${attempt > 0 ? ` (attempt ${attempt + 1})` : ""}`);
      return txHash;
    }

    throw lastError || new Error("onchainos execute failed after retries");
  }
}
