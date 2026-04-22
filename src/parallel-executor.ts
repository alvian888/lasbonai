/**
 * Parallel multi-token execution pool.
 * Runs trading bot evaluation for multiple tokens concurrently.
 */
import { AgenticTradingBot } from "./bot.js";
import { config } from "./config.js";
import { getPositionInfo } from "./position-tracker.js";
import type { TradingRequest, BotRunResult } from "./types.js";

/** Maximum concurrent trading evaluations — server has 16 cores + 93GB RAM, use up to 12 for trading (leave 4 for OS/other) */
const MAX_CONCURRENCY = Math.min(Number(config.BOT_UV_THREADPOOL_SIZE) || 16, 12);

export interface ParallelTokenResult {
  token: string;
  result?: BotRunResult;
  error?: string;
  durationMs: number;
}

/**
 * Run trading evaluation for multiple tokens in parallel.
 * Uses Promise.allSettled with concurrency limiting.
 */
export async function runParallelTokens(
  bot: AgenticTradingBot,
  tokens: Array<{ baseTokenAddress: string; label?: string }>,
  baseRequest: Omit<TradingRequest, "baseTokenAddress">
): Promise<ParallelTokenResult[]> {
  if (tokens.length === 0) return [];

  // Worker-pool queue keeps all workers busy and avoids idle gaps between fixed-size batches.
  const workerCount = Math.max(1, Math.min(MAX_CONCURRENCY, tokens.length));
  const results: ParallelTokenResult[] = new Array(tokens.length);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= tokens.length) {
        return;
      }

      const token = tokens[currentIndex];
      const start = Date.now();
      const tokenLabel = token.label ?? token.baseTokenAddress;

      try {
        const request: TradingRequest = {
          ...baseRequest,
          baseTokenAddress: token.baseTokenAddress,
        };

        const position = await getPositionInfo(
          request.chainId,
          request.baseTokenAddress,
          request.quoteTokenAddress
        ).catch(() => undefined);

        const result = await bot.run(request, position);
        results[currentIndex] = {
          token: tokenLabel,
          result,
          durationMs: Date.now() - start,
        };
      } catch (error) {
        results[currentIndex] = {
          token: tokenLabel,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - start,
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}
