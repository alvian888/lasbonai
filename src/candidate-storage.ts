import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "./config.js";
import type { CandidateScanResult } from "./candidate-scan.js";

function toCsv(rows: Array<Record<string, string | number | null>>) {
  if (rows.length === 0) {
    return "";
  }

  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  for (const row of rows) {
    const line = headers
      .map((header) => {
        const raw = row[header];
        const text = raw === null || raw === undefined ? "" : String(raw);
        return `"${text.replaceAll('"', '""')}"`;
      })
      .join(",");
    lines.push(line);
  }

  return lines.join("\n");
}

function toRows(result: CandidateScanResult) {
  return result.tokens.map((token) => ({
    rank: token.rank,
    symbol: token.symbol,
    address: token.address,
    price_usd: token.priceUsd,
    holders: token.holders,
    liquidity_usd: token.liquidityUsd,
    market_cap_usd_okx: token.marketCapUsdOkx,
    fdv_usd_coingecko: token.fdvUsdCoinGecko,
    market_cap_usd_coingecko: token.marketCapUsdCoinGecko,
    symbol_coingecko: token.symbolCoinGecko
  }));
}

function timestampLabel() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function pruneHistory(historyDir: string) {
  if (!config.CANDIDATE_HISTORY_ENABLED) {
    return;
  }

  const entries = await readdir(historyDir);
  const byAge = entries
    .filter((name) => name.endsWith(".json") || name.endsWith(".csv"))
    .sort();

  const keep = Math.max(10, config.CANDIDATE_HISTORY_KEEP) * 2;
  const excess = Math.max(0, byAge.length - keep);
  for (const name of byAge.slice(0, excess)) {
    await rm(resolve(historyDir, name), { force: true });
  }
}

export async function persistCandidateArtifacts(result: CandidateScanResult) {
  const outputDir = resolve(process.cwd(), "data");
  const historyDir = resolve(outputDir, "history");
  await mkdir(outputDir, { recursive: true });
  await mkdir(historyDir, { recursive: true });

  const rows = toRows(result);
  const jsonText = JSON.stringify(result, null, 2);
  const csvText = toCsv(rows);

  const latestJsonPath = resolve(outputDir, "bep20-candidates.latest.json");
  const latestCsvPath = resolve(outputDir, "bep20-candidates.latest.csv");
  await writeFile(latestJsonPath, jsonText);
  await writeFile(latestCsvPath, csvText);

  let historyJsonPath: string | null = null;
  let historyCsvPath: string | null = null;

  if (config.CANDIDATE_HISTORY_ENABLED) {
    const stamp = timestampLabel();
    historyJsonPath = resolve(historyDir, `bep20-candidates.${stamp}.json`);
    historyCsvPath = resolve(historyDir, `bep20-candidates.${stamp}.csv`);
    await writeFile(historyJsonPath, jsonText);
    await writeFile(historyCsvPath, csvText);
    await pruneHistory(historyDir);
  }

  return {
    latestJsonPath,
    latestCsvPath,
    historyJsonPath,
    historyCsvPath
  };
}