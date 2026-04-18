import crypto from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { config, hasOkxCredentials } from "./config.js";
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

function resolveOnchainosBin() {
  return process.env.ONCHAINOS_BIN || `${os.homedir()}/.local/bin/onchainos`;
}

export class OkxDexClient {
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

  private async request<T>(method: "GET" | "POST", path: string, query?: string, body?: unknown): Promise<T> {
    const pathWithQuery = query ? `${path}?${query}` : path;
    const url = `${config.OKX_DEX_BASE_URL}${pathWithQuery}`;
    const bodyText = body ? JSON.stringify(body) : "";

    const response = await fetch(url, {
      method,
      headers: this.buildHeaders(method, pathWithQuery, bodyText),
      body: bodyText || undefined
    });

    const json = (await response.json().catch(() => null)) as
      | { code?: string; msg?: string; data?: unknown[] }
      | null;

    if (!response.ok) {
      throw new Error(`OKX HTTP ${response.status}: ${JSON.stringify(json)}`);
    }

    if (json && json.code && json.code !== "0") {
      throw new Error(`OKX error ${json.code}: ${json.msg ?? "unknown error"}`);
    }

    return json as T;
  }

  private async runOnchainos<T>(args: string[]): Promise<T> {
    const bin = resolveOnchainosBin();

    try {
      const { stdout } = await execFileAsync(bin, args, {
        maxBuffer: 10 * 1024 * 1024
      });

      return JSON.parse(stdout) as T;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Onchain OS CLI failed: ${message}`);
    }
  }

  async quoteSwap(params: SwapParams): Promise<QuoteSummary> {
    if (!hasOkxCredentials()) {
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
        throw new Error("Onchain OS quote response did not contain data[0]");
      }

      return {
        fromTokenAddress: params.fromTokenAddress,
        toTokenAddress: params.toTokenAddress,
        amountIn: String(item.fromTokenAmount ?? params.amount),
        amountOut: String(item.toTokenAmount ?? "0"),
        router: typeof item.router === "string" ? item.router : undefined,
        raw: item
      };
    }

    const query = encodeQuery({
      chainId: params.chainId,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amount,
      slippage: params.slippage
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

    return {
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amountIn: String(item.fromTokenAmount ?? params.amount),
      amountOut: String(item.toTokenAmount ?? "0"),
      router: typeof item.routerResult === "string" ? item.routerResult : undefined,
      raw: item
    };
  }

  async buildSwap(params: SwapParams): Promise<SwapBuildResult> {
    if (!hasOkxCredentials()) {
      if (!params.walletAddress) {
        throw new Error("walletAddress is required when building swaps via Onchain OS");
      }

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
        to: String(tx.to) as `0x${string}`,
        data: String(tx.data) as `0x${string}`,
        value: toBigIntSafe(pickTransactionField(tx, "value")) ?? 0n,
        gas: toBigIntSafe(pickTransactionField(tx, "gas", "gasLimit")),
        gasPrice: toBigIntSafe(pickTransactionField(tx, "gasPrice")),
        raw: { ...item, _swapParams: params }
      };
    }

    const query = encodeQuery({
      chainId: params.chainId,
      fromTokenAddress: params.fromTokenAddress,
      toTokenAddress: params.toTokenAddress,
      amount: params.amount,
      slippage: params.slippage,
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
      to: String(tx.to) as `0x${string}`,
      data: String(tx.data) as `0x${string}`,
      value: toBigIntSafe(pickTransactionField(tx, "value")) ?? 0n,
      gas: toBigIntSafe(pickTransactionField(tx, "gas", "gasLimit")),
      gasPrice: toBigIntSafe(pickTransactionField(tx, "gasPrice")),
      raw: item
    };
  }
}