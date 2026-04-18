import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface HotToken {
  tokenSymbol: string;
  tokenContractAddress: string;
  price: string;
  marketCap: string;
  fdv?: string;
  liquidity: string;
  holders: string;
  volume?: string;
  change?: string;
  uniqueTraders?: string;
  txs?: string;
}

function getArg(flag: string, fallback: string) {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function asNumber(value: string | undefined) {
  const parsed = Number(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number) {
  if (value >= 1_000_000_000) {
    return `$${(value / 1_000_000_000).toFixed(2)}B`;
  }

  if (value >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }

  if (value >= 1_000) {
    return `$${(value / 1_000).toFixed(2)}K`;
  }

  return `$${value.toFixed(2)}`;
}

function formatPrice(value: number) {
  if (value >= 1) {
    return value.toFixed(4);
  }

  if (value >= 0.01) {
    return value.toFixed(6);
  }

  return value.toFixed(10);
}

async function main() {
  const onchainos = process.env.ONCHAINOS_BIN || `${os.homedir()}/.local/bin/onchainos`;
  const chain = getArg("--chain", "bnb");
  const holdersMin = getArg("--holders-min", "10000");
  const liquidityMin = getArg("--liquidity-min", "1000000");
  const marketCapMin = getArg("--market-cap-min", "50000000");
  const fdvMin = getArg("--fdv-min", "0");
  const limit = Number(getArg("--limit", "100"));

  const args = [
    "token",
    "hot-tokens",
    "--ranking-type",
    "4",
    "--chain",
    chain,
    "--rank-by",
    "1",
    "--time-frame",
    "4",
    "--risk-filter",
    "true",
    "--stable-token-filter",
    "true",
    "--holders-min",
    holdersMin,
    "--liquidity-min",
    liquidityMin,
    "--market-cap-min",
    marketCapMin,
    "--fdv-min",
    fdvMin
  ];

  const { stdout } = await execFileAsync(onchainos, args, { maxBuffer: 20 * 1024 * 1024 });
  const payload = JSON.parse(stdout) as { data?: HotToken[] };
  const tokens = (payload.data ?? [])
    .sort((left, right) => asNumber(left.price) - asNumber(right.price))
    .slice(0, limit)
    .map((token, index) => ({
      rank: index + 1,
      symbol: token.tokenSymbol,
      address: token.tokenContractAddress,
      price: formatPrice(asNumber(token.price)),
      marketCap: formatUsd(asNumber(token.marketCap)),
      fdv: formatUsd(asNumber(token.fdv)),
      liquidity: formatUsd(asNumber(token.liquidity)),
      holders: Math.trunc(asNumber(token.holders)).toLocaleString("en-US"),
      volume24h: formatUsd(asNumber(token.volume)),
      change24h: `${asNumber(token.change).toFixed(2)}%`
    }));

  console.log(
    JSON.stringify(
      {
        chain,
        filters: {
          holdersMin: Number(holdersMin),
          liquidityMin: Number(liquidityMin),
          marketCapMin: Number(marketCapMin),
          fdvMin: Number(fdvMin),
          sortedBy: "lowest price first",
          riskFilter: true,
          stableTokenFilter: true
        },
        count: tokens.length,
        tokens
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});