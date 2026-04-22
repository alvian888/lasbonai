import crypto from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { config, hasOkxCredentials } from "./config.js";
import { resolveNetworkConfig } from "./network-registry.js";
import type { QuoteSummary, SwapBuildResult } from "./types.js";

const execFileAsync = promisify(execFile);

interface SwapParams {
  chainId: string;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: string;
  slippage: string;
  walletAddress?: string;
}

interface CachedQuoteEntry {
  quote: QuoteSummary;
  expiresAt: number;
}

function encodeQuery(params: Record<string, string | undefined>) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value) {
      search.set(key, value);
    }
  }

  return search.toString();
}

function toBigIntSafe(value: string | number | bigint | undefined | null) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    return BigInt(Math.trunc(value));
  }

  if (String(value).startsWith("0x")) {
    return BigInt(String(value));
  }

  return BigInt(String(value));
}

function pickTransactionField(
  record: Record<string, unknown>,
  ...keys: string[]
): string | number | bigint | undefined | null {
  for (const key of keys) {
    const value = record[key];

    if (
      value === undefined ||
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint"
    ) {
      if (value !== undefined) {
        return value;
      }
    }
  }

  return undefined;
}

function asStringOr(value: unknown, fallback: string): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function resolveOnchainosBin() {
  return process.env.ONCHAINOS_BIN || `${os.homedir()}/.local/bin/onchainos`;
}

export class OkxDexClient {
  private readonly quoteCache = new Map<string, CachedQuoteEntry>();
  private static readonly QUOTE_CACHE_TTL_MS = 30_000;

  private getQuoteCacheKey(params: SwapParams) {
    return [
      params.chainId,
      params.fromTokenAddress.toLowerCase(),
      params.toTokenAddress.toLowerCase(),
      params.amount,
      params.slippage
    ].join("|");
  }

  private getCachedQuote(params: SwapParams): QuoteSummary | undefined {
    const key = this.getQuoteCacheKey(params);
    const cached = this.quoteCache.get(key);
    if (!cached) {
      return undefined;
    }
    if (Date.now() >= cached.expiresAt) {
      this.quoteCache.delete(key);
      return undefined;
    }
    return cached.quote;
  }

  private setCachedQuote(params: SwapParams, quote: QuoteSummary) {
    const key = this.getQuoteCacheKey(params);
    this.quoteCache.set(key, {
      quote,
      expiresAt: Date.now() + OkxDexClient.QUOTE_CACHE_TTL_MS
    });
    // Prune expired entries when cache grows to avoid unbounded memory use
    if (this.quoteCache.size > 50) {
      const now = Date.now();
      for (const [k, v] of this.quoteCache) {
        if (now >= v.expiresAt) this.quoteCache.delete(k);
      }
    }
  }

  private sign(timestamp: string, method: string, pathWithQuery: string, body = "") {
    const payload = `${timestamp}${method}${pathWithQuery}${body}`;

    return crypto
      .createHmac("sha256", config.OKX_SECRET_KEY)
      .update(payload)
      .digest("base64");
  }

  private buildHeaders(method: string, pathWithQuery: string, body = "") {
    const timestamp = new Date().toISOString();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "OK-ACCESS-KEY": config.OKX_ACCESS_KEY,
      "OK-ACCESS-PASSPHRASE": config.OKX_PASSPHRASE,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-SIGN": this.sign(timestamp, method, pathWithQuery, body)
    };

    if (config.OKX_PROJECT_ID) {
      headers["OK-ACCESS-PROJECT"] = config.OKX_PROJECT_ID;
    }

    return headers;
  }

  /* Circuit breaker: skip direct OKX API after consecutive failures (DNS hijacking) */
  private directApiFailures = 0;
  private static readonly DIRECT_API_CIRCUIT_THRESHOLD = 2;
  private directApiCircuitResetAt = 0;

  private isDirectApiCircuitOpen(): boolean {
    if (this.directApiFailures >= OkxDexClient.DIRECT_API_CIRCUIT_THRESHOLD) {
      // Reset circuit after 5 minutes to retry
      if (Date.now() > this.directApiCircuitResetAt) {
        this.directApiFailures = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  private async request<T>(method: "GET" | "POST", path: string, query?: string, body?: unknown): Promise<T> {
    if (this.isDirectApiCircuitOpen()) {
      throw new Error("[okx-client] Direct API circuit open — skipping to onchainos fallback");
    }

    const pathWithQuery = query ? `${path}?${query}` : path;
    const url = `${config.OKX_DEX_BASE_URL}${pathWithQuery}`;
    const bodyText = body ? JSON.stringify(body) : "";
    const maxRetries = 1; // Reduced from 3: fail fast, let onchainos handle it

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const response = await fetch(url, {
          method,
          headers: this.buildHeaders(method, pathWithQuery, bodyText),
          body: bodyText || undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const json = (await response.json().catch(() => null)) as
          | { code?: string; msg?: string; data?: unknown[] }
          | null;

        if (!response.ok) {
          throw new Error(`OKX HTTP ${response.status}: ${JSON.stringify(json)}`);
        }

        if (json?.code && json.code !== "0") {
          throw new Error(`OKX error ${json.code}: ${json.msg ?? "unknown error"}`);
        }

        // Success — reset circuit breaker
        this.directApiFailures = 0;
        return json as T;
      } catch (error) {
        this.directApiFailures++;
        this.directApiCircuitResetAt = Date.now() + 5 * 60_000;
        if (attempt >= maxRetries) throw error;
        console.log(`[okx-client] Request attempt ${attempt} failed, retrying in 1000ms...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    throw new Error("unreachable");
  }

  private async runOnchainos<T>(args: string[]): Promise<T> {
    const bin = resolveOnchainosBin();

    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60_000
      });

      if (stderr?.trim()) {
        console.warn(`[okx-client] onchainos stderr: ${stderr.slice(0, 200)}`);
      }

      return JSON.parse(stdout) as T;
    } catch (error: unknown) {
      const execErr = error as { stdout?: string; stderr?: string; message?: string; code?: number };
      const stdout = execErr.stdout || "";
      const stderr = execErr.stderr || "";
      
      // Try to parse JSON from stdout even if exit code is non-zero (onchainos may return 1 but still output valid JSON)
      if (stdout.trim()) {
        try {
          return JSON.parse(stdout) as T;
        } catch {
          // Fall through to error handling below
        }
      }

      // If no valid JSON in stdout, check stderr for error message
      if (stderr.trim()) {
        throw new Error(`Onchain OS CLI failed: ${stderr.slice(0, 500)}`);
      }

      const message = execErr.message || "unknown error";
      throw new Error(`Onchain OS CLI failed: ${message}`);
    }
  }

  private assertNetworkSupported(chainId: string) {
    const network = resolveNetworkConfig(chainId);
    if (network.key === "xrpl" || !network.okxAggregatorSupported) {
      throw new Error(
        `[okx-client] Network ${network.label} belum didukung oleh jalur OKX onchain aggregator bot ini. ` +
          `Gunakan fallback konfigurasi dari ${network.fallbackUrl || "https://dex.anodos.finance/portfolio"} ` +
          `atau eksekusi native anodos melalui POST /api/xrpl/swap.`
      );
    }
  }

  async quoteSwap(params: SwapParams): Promise<QuoteSummary> {
    this.assertNetworkSupported(params.chainId);

    // Skip actual quote if amount is zero — return a no-op summary
    if (!params.amount || params.amount === "0") {
      return {
        fromTokenAddress: params.fromTokenAddress,
        toTokenAddress: params.toTokenAddress,
        amountIn: "0",
        amountOut: "0",
        raw: {}
      };
    }

    const cachedQuote = this.getCachedQuote(params);
    if (cachedQuote) {
      return cachedQuote;
    }

    // Try OKX API first if credentials available, but fall back to onchainos on failure
    if (hasOkxCredentials() && !config.OKX_DISABLE_DIRECT_API) {
      try {
        // OKX API expects slippage as decimal (0.005 = 0.5%), config uses percentage (0.5 = 0.5%)
        const apiSlippage = String(Number.parseFloat(params.slippage) / 100);
        const query = encodeQuery({
          chainId: params.chainId,
          fromTokenAddress: params.fromTokenAddress,
          toTokenAddress: params.toTokenAddress,
          amount: params.amount,
          slippage: apiSlippage
        });

        const result = await this.request<{ data?: Array<Record<string, unknown>> }>(
          "GET",
          "/api/v5/dex/aggregator/quote",
          query
        );

        const item = result.data?.[0];
        if (!item) {
          throw new Error("OKX quote response did not contain data[0]");
        }

        const quote = {
          fromTokenAddress: params.fromTokenAddress,
          toTokenAddress: params.toTokenAddress,
          amountIn: asStringOr(item.fromTokenAmount, params.amount),
          amountOut: asStringOr(item.toTokenAmount, "0"),
          router: typeof item.routerResult === "string" ? item.routerResult : undefined,
          raw: item
        };
        this.setCachedQuote(params, quote);
        return quote;
      } catch (okxErr) {
        // Silently fall back to onchainos on OKX API errors (expected when passphrase is incorrect)
        console.warn(`[okx-client] quote API fallback to onchainos: ${okxErr instanceof Error ? okxErr.message : String(okxErr)}`);
      }
    }

    // Use onchainos as fallback or primary method
    const result = await this.runOnchainos<{ data?: Array<Record<string, unknown>> }>([
      "swap",
      "quote",
      "--from",
      params.fromTokenAddress,
      "--to",
      params.toTokenAddress,
      "--amount",
      params.amount,
      "--chain",
      params.chainId
    ]);

    const item = result.data?.[0];
    if (!item) {
      console.warn(`[okx-client] onchainos quote response did not contain data[0], full response: ${JSON.stringify(result).slice(0, 200)}`);
      throw new Error(`Onchain OS quote response did not contain data[0]. Response: ${JSON.stringify(result)}`);
    }

    const quote = {
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amountIn: asStringOr(item.fromTokenAmount, params.amount),
      amountOut: asStringOr(item.toTokenAmount, "0"),
      router: typeof item.router === "string" ? item.router : undefined,
      raw: item
    };
    this.setCachedQuote(params, quote);
    return quote;
  }

  async buildSwap(params: SwapParams): Promise<SwapBuildResult> {
    this.assertNetworkSupported(params.chainId);

    // Guard: reject zero/empty amount to prevent wasted gas
    if (!params.amount || params.amount === "0") {
      throw new Error(`buildSwap rejected: amount is ${params.amount}`);
    }

    if (!params.walletAddress) {
      throw new Error("walletAddress is required when building swaps");
    }

    // Try OKX API first if credentials available, but fall back to onchainos on failure
    if (hasOkxCredentials() && !config.OKX_DISABLE_DIRECT_API) {
      try {
        // OKX API expects slippage as decimal (0.005 = 0.5%), config uses percentage (0.5 = 0.5%)
        const apiSlippage = String(Number.parseFloat(params.slippage) / 100);
        const query = encodeQuery({
          chainId: params.chainId,
          fromTokenAddress: params.fromTokenAddress,
          toTokenAddress: params.toTokenAddress,
          amount: params.amount,
          slippage: apiSlippage,
          userWalletAddress: params.walletAddress
        });

        const result = await this.request<{ data?: Array<Record<string, unknown>> }>(
          "GET",
          "/api/v5/dex/aggregator/swap",
          query
        );

        const item = result.data?.[0];
        const tx = (item?.tx as Record<string, unknown> | undefined) ?? item;

        if (!tx?.to || !tx?.data) {
          throw new Error(`OKX swap response missing tx payload: ${JSON.stringify(item)}`);
        }

        return {
          to: asStringOr(tx.to, "") as `0x${string}`,
          data: asStringOr(tx.data, "") as `0x${string}`,
          value: toBigIntSafe(pickTransactionField(tx, "value")) ?? 0n,
          gas: toBigIntSafe(pickTransactionField(tx, "gas", "gasLimit")),
          gasPrice: toBigIntSafe(pickTransactionField(tx, "gasPrice")),
          raw: item
        };
      } catch (okxErr) {
        // Silently fall back to onchainos on OKX API errors (expected when passphrase is incorrect)
        console.warn(`[okx-client] swap API fallback to onchainos: ${okxErr instanceof Error ? okxErr.message : String(okxErr)}`);
      }
    }

    // Use onchainos as fallback or primary method
    const result = await this.runOnchainos<{ data?: Array<Record<string, unknown>> }>([
      "swap",
      "swap",
      "--from",
      params.fromTokenAddress,
      "--to",
      params.toTokenAddress,
      "--amount",
      params.amount,
      "--chain",
      params.chainId,
      "--wallet",
      params.walletAddress,
      "--slippage",
      params.slippage
    ]);

    const item = result.data?.[0];
    const tx = (item?.tx as Record<string, unknown> | undefined) ?? item;

    if (!tx?.to || !tx?.data) {
      throw new Error(`Onchain OS swap response missing tx payload: ${JSON.stringify(item)}`);
    }

    return {
      to: asStringOr(tx.to, "") as `0x${string}`,
      data: asStringOr(tx.data, "") as `0x${string}`,
      value: toBigIntSafe(pickTransactionField(tx, "value")) ?? 0n,
      gas: toBigIntSafe(pickTransactionField(tx, "gas", "gasLimit")),
      gasPrice: toBigIntSafe(pickTransactionField(tx, "gasPrice")),
      raw: { ...item, _swapParams: params }
    };
  }
}