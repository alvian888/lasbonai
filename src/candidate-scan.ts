import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { config, getCandidateAllowlistSet } from "./config.js";

const execFileAsync = promisify(execFile);

interface HotTokenItem {
  tokenSymbol?: string;
  tokenContractAddress?: string;
  price?: string;
  holders?: string;
  liquidity?: string;
  marketCap?: string;
}

interface CoinGeckoContractResponse {
  symbol?: string;
  market_data?: {
    fully_diluted_valuation?: { usd?: number | null };
    market_cap?: { usd?: number | null };
  };
}

export interface CandidateToken {
  rank: number;
  symbol: string;
  address: string;
  priceUsd: number;
  holders: number;
  liquidityUsd: number;
  marketCapUsdOkx: number;
  fdvUsdCoinGecko: number | null;
  marketCapUsdCoinGecko: number | null;
  symbolCoinGecko: string | null;
}

export interface CandidateScanResult {
  chain: string;
  mode: "strict" | "relaxed" | "fallback-top" | "fallback-history" | "fallback-allowlist";
  thresholds: {
    holdersMin: number;
    liquidityMinIdr: number;
    marketCapMinIdr: number;
    fdvMinIdr: number;
    liquidityMinUsd: number;
    marketCapMinUsd: number;
    fdvMinUsd: number;
    usdToIdr: number;
  };
  count: number;
  tokens: CandidateToken[];
}

interface DexScreenerPair {
  chainId?: string;
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  baseToken?: { symbol?: string };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

const FETCH_TIMEOUT_MS = 10_000;
const COINGECKO_CONCURRENCY = 4;

function asNumber(value: string | number | null | undefined) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

async function delay(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }
    return (await response.json().catch(() => null)) as T | null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUsdToIdrRate() {
  if (config.CANDIDATE_FX_USD_TO_IDR > 0) {
    return config.CANDIDATE_FX_USD_TO_IDR;
  }

  const payload = await fetchJsonWithTimeout<{ rates?: { IDR?: number } }>("https://open.er-api.com/v6/latest/USD");
  const rate = payload?.rates?.IDR;
  if (rate && Number.isFinite(rate)) {
    return rate;
  }

  return 17000;
}

async function fetchCoinGeckoContract(address: string): Promise<CoinGeckoContractResponse | null> {
  return fetchJsonWithTimeout<CoinGeckoContractResponse>(
    `https://api.coingecko.com/api/v3/coins/binance-smart-chain/contract/${address}`
  );
}

const DEXSCREENER_CONCURRENCY = 4;

async function fetchAllowlistDexCandidates(allowlist: Set<string>, limit: number): Promise<CandidateToken[]> {
  const addresses = Array.from(allowlist);
  const items: (CandidateToken | null)[] = new Array(addresses.length).fill(null);
  let nextIndex = 0;

  async function runWorker() {
    while (true) {
      const i = nextIndex++;
      if (i >= addresses.length) return;
      const address = addresses[i];
      try {
        const payload = await fetchJsonWithTimeout<DexScreenerResponse>(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
        const bscPairs = (payload?.pairs ?? []).filter((pair) => pair.chainId === "bsc");
        if (bscPairs.length === 0) continue;

        const best = bscPairs.sort((left, right) => asNumber(right.liquidity?.usd) - asNumber(left.liquidity?.usd))[0];
        const marketCap = asNumber(best.marketCap);
        const fdv = asNumber(best.fdv);
        const resolvedMarketCap = marketCap > 0 ? marketCap : fdv;

        items[i] = {
          rank: 0,
          symbol: String(best.baseToken?.symbol ?? ""),
          address,
          priceUsd: asNumber(best.priceUsd),
          holders: 0,
          liquidityUsd: asNumber(best.liquidity?.usd),
          marketCapUsdOkx: resolvedMarketCap,
          fdvUsdCoinGecko: null,
          marketCapUsdCoinGecko: null,
          symbolCoinGecko: null
        };
      } catch {
        // skip token and continue
      }
    }
  }

  const workerCount = Math.min(DEXSCREENER_CONCURRENCY, addresses.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));

  return (items.filter(Boolean) as CandidateToken[])
    .sort((left, right) => left.priceUsd - right.priceUsd)
    .slice(0, limit)
    .map((token, index) => ({
      ...token,
      rank: index + 1
    }));
}

async function loadLastKnownNonEmpty(limit: number): Promise<CandidateToken[] | null> {
  const outputDir = resolve(process.cwd(), "data");
  const historyDir = resolve(outputDir, "history");
  const candidates: string[] = [];

  candidates.push(resolve(outputDir, "bep20-candidates.latest.json"));

  try {
    const files = await readdir(historyDir);
    const ordered = files
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse()
      .map((name) => resolve(historyDir, name));
    candidates.push(...ordered);
  } catch {
    // ignore; history dir might not exist yet
  }

  for (const filePath of candidates) {
    try {
      const text = await readFile(filePath, "utf8");
      const parsed = JSON.parse(text) as CandidateScanResult;
      if (!Array.isArray(parsed.tokens) || parsed.tokens.length === 0) {
        continue;
      }

      return parsed.tokens.slice(0, limit).map((token, index) => ({
        ...token,
        rank: index + 1
      }));
    } catch {
      // try next candidate file
    }
  }

  return null;
}

export async function scanBep20Candidates(): Promise<CandidateScanResult> {
  const usdToIdr = await fetchUsdToIdrRate();
  const liquidityMinUsd = Math.ceil(config.CANDIDATE_LIQ_MIN_IDR / usdToIdr);
  const marketCapMinUsd = Math.ceil(config.CANDIDATE_MC_MIN_IDR / usdToIdr);
  const fdvMinUsd = Math.ceil(config.CANDIDATE_FDV_MIN_IDR / usdToIdr);

  const onchainosBin = config.ONCHAINOS_BIN || `${process.env.HOME}/.local/bin/onchainos`;
  async function runQuery(holdersMin: number, marketCapMinUsdForQuery: number, fdvMinUsdForQuery: number) {
    const args = [
      "token",
      "hot-tokens",
      "--ranking-type",
      "4",
      "--chain",
      config.CANDIDATE_CHAIN,
      "--rank-by",
      "1",
      "--time-frame",
      "4",
      "--risk-filter",
      config.CANDIDATE_RISK_FILTER ? "true" : "false",
      "--stable-token-filter",
      config.CANDIDATE_STABLE_FILTER ? "true" : "false",
      "--holders-min",
      String(holdersMin),
      "--liquidity-min",
      String(liquidityMinUsd),
      "--market-cap-min",
      String(marketCapMinUsdForQuery),
      "--fdv-min",
      String(fdvMinUsdForQuery)
    ];

    let payload: { data?: HotTokenItem[] } = { data: [] };
    let lastError: unknown;
    for (let attempt = 1; attempt <= config.CANDIDATE_SCAN_MAX_ATTEMPTS; attempt += 1) {
      try {
        const { stdout } = await execFileAsync(onchainosBin, args, { maxBuffer: 20 * 1024 * 1024 });
        payload = JSON.parse(stdout) as { data?: HotTokenItem[] };
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < config.CANDIDATE_SCAN_MAX_ATTEMPTS) {
          await delay(config.CANDIDATE_SCAN_RETRY_DELAY_MS);
        }
      }
    }

    return { payload, lastError };
  }

  let mode: "strict" | "relaxed" | "fallback-top" | "fallback-history" | "fallback-allowlist" = "strict";
  let activeHoldersMin = config.CANDIDATE_HOLDERS_MIN;
  let activeMarketCapMinUsd = marketCapMinUsd;
  let activeFdvMinUsd = fdvMinUsd;

  let { payload, lastError } = await runQuery(activeHoldersMin, activeMarketCapMinUsd, activeFdvMinUsd);

  const strictCount = (payload.data ?? []).length;
  if (!lastError && strictCount === 0 && config.CANDIDATE_AUTO_RELAX_ENABLED) {
    mode = "relaxed";
    activeHoldersMin = config.CANDIDATE_RELAX_HOLDERS_MIN;
    activeMarketCapMinUsd = Math.ceil(config.CANDIDATE_RELAX_MC_MIN_IDR / usdToIdr);
    activeFdvMinUsd = Math.ceil(config.CANDIDATE_RELAX_FDV_MIN_IDR / usdToIdr);
    ({ payload, lastError } = await runQuery(activeHoldersMin, activeMarketCapMinUsd, activeFdvMinUsd));
  }

  if (lastError) {
    return {
      chain: config.CANDIDATE_CHAIN,
      mode,
      thresholds: {
        holdersMin: activeHoldersMin,
        liquidityMinIdr: config.CANDIDATE_LIQ_MIN_IDR,
        marketCapMinIdr:
          mode === "relaxed" ? config.CANDIDATE_RELAX_MC_MIN_IDR : config.CANDIDATE_MC_MIN_IDR,
        fdvMinIdr: mode === "relaxed" ? config.CANDIDATE_RELAX_FDV_MIN_IDR : config.CANDIDATE_FDV_MIN_IDR,
        liquidityMinUsd,
        marketCapMinUsd: activeMarketCapMinUsd,
        fdvMinUsd: activeFdvMinUsd,
        usdToIdr
      },
      count: 0,
      tokens: []
    };
  }
  const sorted = (payload.data ?? []).sort((left, right) => asNumber(left.price) - asNumber(right.price));
  const allowlist = getCandidateAllowlistSet();

  const allowlistFiltered =
    allowlist.size === 0
      ? sorted
      : sorted.filter((token) => {
          const address = String(token.tokenContractAddress ?? "").toLowerCase();
          return allowlist.has(address);
        });

  const useFallbackTop =
    allowlist.size > 0 &&
    allowlistFiltered.length === 0 &&
    sorted.length > 0 &&
    config.CANDIDATE_ALLOWLIST_FALLBACK_TO_TOP;

  if (useFallbackTop) {
    mode = "fallback-top";
  }

  const base = (useFallbackTop ? sorted : allowlistFiltered).slice(0, config.CANDIDATE_LIMIT);

  console.log(`[candidate-scan] enriching ${base.length} token(s) with CoinGecko (concurrency=${COINGECKO_CONCURRENCY})`);

  // Worker pool: keep COINGECKO_CONCURRENCY workers busy at all times (no idle gaps between batches)
  const enriched: (CandidateToken | null)[] = new Array(base.length).fill(null);
  let nextCoinGeckoIndex = 0;

  async function runCoinGeckoWorker() {
    while (true) {
      const index = nextCoinGeckoIndex++;
      if (index >= base.length) return;
      const token = base[index];
      const address = String(token.tokenContractAddress ?? "").toLowerCase();
      const coinGecko = address ? await fetchCoinGeckoContract(address) : null;
      const fdvCoinGecko = coinGecko?.market_data?.fully_diluted_valuation?.usd ?? null;
      const marketCapCoinGecko = coinGecko?.market_data?.market_cap?.usd ?? null;

      if (config.CANDIDATE_REQUIRE_EXPLICIT_FDV && (fdvCoinGecko === null || fdvCoinGecko < fdvMinUsd)) {
        continue;
      }

      enriched[index] = {
        rank: index + 1,
        symbol: String(token.tokenSymbol ?? ""),
        address,
        priceUsd: asNumber(token.price),
        holders: asNumber(token.holders),
        liquidityUsd: asNumber(token.liquidity),
        marketCapUsdOkx: asNumber(token.marketCap),
        fdvUsdCoinGecko: fdvCoinGecko,
        marketCapUsdCoinGecko: marketCapCoinGecko,
        symbolCoinGecko: coinGecko?.symbol ?? null
      } satisfies CandidateToken;
    }
  }

  await Promise.all(Array.from({ length: Math.min(COINGECKO_CONCURRENCY, base.length) }, () => runCoinGeckoWorker()));
  const tokens = (enriched.filter(Boolean) as CandidateToken[]).map((t, i) => ({ ...t, rank: i + 1 }));

  if (tokens.length === 0) {
    const historyFallback = await loadLastKnownNonEmpty(config.CANDIDATE_LIMIT);
    if (historyFallback && historyFallback.length > 0) {
      return {
        chain: config.CANDIDATE_CHAIN,
        mode: "fallback-history",
        thresholds: {
          holdersMin: activeHoldersMin,
          liquidityMinIdr: config.CANDIDATE_LIQ_MIN_IDR,
          marketCapMinIdr:
            mode === "relaxed" ? config.CANDIDATE_RELAX_MC_MIN_IDR : config.CANDIDATE_MC_MIN_IDR,
          fdvMinIdr: mode === "relaxed" ? config.CANDIDATE_RELAX_FDV_MIN_IDR : config.CANDIDATE_FDV_MIN_IDR,
          liquidityMinUsd,
          marketCapMinUsd: activeMarketCapMinUsd,
          fdvMinUsd: activeFdvMinUsd,
          usdToIdr
        },
        count: historyFallback.length,
        tokens: historyFallback
      };
    }

    if (allowlist.size > 0) {
      const dexFallback = await fetchAllowlistDexCandidates(allowlist, config.CANDIDATE_LIMIT);
      if (dexFallback.length > 0) {
        return {
          chain: config.CANDIDATE_CHAIN,
          mode: "fallback-allowlist",
          thresholds: {
            holdersMin: activeHoldersMin,
            liquidityMinIdr: config.CANDIDATE_LIQ_MIN_IDR,
            marketCapMinIdr:
              mode === "relaxed" ? config.CANDIDATE_RELAX_MC_MIN_IDR : config.CANDIDATE_MC_MIN_IDR,
            fdvMinIdr: mode === "relaxed" ? config.CANDIDATE_RELAX_FDV_MIN_IDR : config.CANDIDATE_FDV_MIN_IDR,
            liquidityMinUsd,
            marketCapMinUsd: activeMarketCapMinUsd,
            fdvMinUsd: activeFdvMinUsd,
            usdToIdr
          },
          count: dexFallback.length,
          tokens: dexFallback
        };
      }
    }
  }

  return {
    chain: config.CANDIDATE_CHAIN,
    mode,
    thresholds: {
      holdersMin: activeHoldersMin,
      liquidityMinIdr: config.CANDIDATE_LIQ_MIN_IDR,
      marketCapMinIdr:
        mode === "relaxed" ? config.CANDIDATE_RELAX_MC_MIN_IDR : config.CANDIDATE_MC_MIN_IDR,
      fdvMinIdr: mode === "relaxed" ? config.CANDIDATE_RELAX_FDV_MIN_IDR : config.CANDIDATE_FDV_MIN_IDR,
      liquidityMinUsd,
      marketCapMinUsd: activeMarketCapMinUsd,
      fdvMinUsd: activeFdvMinUsd,
      usdToIdr
    },
    count: tokens.length,
    tokens
  };
}