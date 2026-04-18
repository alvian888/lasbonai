import fs from "node:fs/promises";
import path from "node:path";

type DexPair = {
  chainId?: string;
  pairCreatedAt?: number;
  baseToken?: {
    address?: string;
    symbol?: string;
  };
  priceUsd?: string;
  priceNative?: string;
  txns?: {
    h24?: {
      buys?: number;
      sells?: number;
    };
  };
  volume?: {
    h24?: number;
  };
  priceChange?: {
    h24?: number;
  };
  liquidity?: {
    usd?: number;
  };
  marketCap?: number;
  fdv?: number;
  info?: {
    imageUrl?: string;
  };
};

type TargetItem = {
  bundleHoldPercent: string;
  chainIndex: string;
  change: string;
  cursor: string;
  devHoldPercent: string;
  firstTradeTime: string;
  holders: string;
  inflowUsd: string;
  insiderHoldPercent: string;
  liquidity: string;
  marketCap: string;
  mentionsCount: string;
  price: string;
  riskLevelControl: string;
  tokenContractAddress: string;
  tokenLogoUrl: string;
  tokenSymbol: string;
  top10HoldPercent: string;
  txs: string;
  txsBuy: string;
  txsSell: string;
  uniqueTraders: string;
  vibeScore: string;
  volume: string;
};

const TARGET_KEYS: Array<keyof TargetItem> = [
  "bundleHoldPercent",
  "chainIndex",
  "change",
  "cursor",
  "devHoldPercent",
  "firstTradeTime",
  "holders",
  "inflowUsd",
  "insiderHoldPercent",
  "liquidity",
  "marketCap",
  "mentionsCount",
  "price",
  "riskLevelControl",
  "tokenContractAddress",
  "tokenLogoUrl",
  "tokenSymbol",
  "top10HoldPercent",
  "txs",
  "txsBuy",
  "txsSell",
  "uniqueTraders",
  "vibeScore",
  "volume"
];

function getArg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index !== -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function toNumericString(value: unknown): string {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? String(parsed) : "";
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }

  return "";
}

function normalizePair(pair: DexPair, index: number): TargetItem {
  const buys = pair.txns?.h24?.buys;
  const sells = pair.txns?.h24?.sells;
  const totalTxs =
    typeof buys === "number" && typeof sells === "number" ? String(buys + sells) : "";

  return {
    bundleHoldPercent: "",
    chainIndex: "",
    change: toNumericString(pair.priceChange?.h24),
    cursor: String(index),
    devHoldPercent: "",
    firstTradeTime:
      typeof pair.pairCreatedAt === "number" && Number.isFinite(pair.pairCreatedAt)
        ? String(pair.pairCreatedAt)
        : "",
    holders: "",
    inflowUsd: "",
    insiderHoldPercent: "",
    liquidity: toNumericString(pair.liquidity?.usd),
    marketCap: toNumericString(pair.marketCap ?? pair.fdv),
    mentionsCount: "",
    price: toNumericString(pair.priceUsd ?? pair.priceNative),
    riskLevelControl: "",
    tokenContractAddress: String(pair.baseToken?.address ?? ""),
    tokenLogoUrl: String(pair.info?.imageUrl ?? ""),
    tokenSymbol: String(pair.baseToken?.symbol ?? ""),
    top10HoldPercent: "",
    txs: totalTxs,
    txsBuy: typeof buys === "number" ? String(buys) : "",
    txsSell: typeof sells === "number" ? String(sells) : "",
    uniqueTraders: "",
    vibeScore: "",
    volume: toNumericString(pair.volume?.h24)
  };
}

function validateOutput(payload: { ok: boolean; data: TargetItem[] }) {
  if (payload.ok !== true) {
    throw new Error("Validation failed: top-level field ok must be true.");
  }

  if (!Array.isArray(payload.data)) {
    throw new Error("Validation failed: top-level field data must be an array.");
  }

  for (let i = 0; i < payload.data.length; i += 1) {
    const item = payload.data[i] as Record<string, unknown>;
    const itemKeys = Object.keys(item).sort();
    const expectedKeys = [...TARGET_KEYS].sort();

    if (itemKeys.length !== expectedKeys.length) {
      throw new Error(
        `Validation failed: item ${i} has ${itemKeys.length} keys, expected ${expectedKeys.length}.`
      );
    }

    for (const key of expectedKeys) {
      if (!(key in item)) {
        throw new Error(`Validation failed: item ${i} missing key ${key}.`);
      }

      if (typeof item[key] !== "string") {
        throw new Error(`Validation failed: item ${i}.${key} must be a string.`);
      }
    }
  }
}

async function fetchDexscreenerXrplPairs(): Promise<DexPair[]> {
  const url = "https://api.dexscreener.com/latest/dex/search/?q=xrpl";
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Dexscreener request failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as { pairs?: DexPair[] };
  const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
  return pairs.filter((pair) => pair.chainId === "xrpl");
}

function toTimestampFilename(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${pad(now.getDate())}${pad(now.getMonth() + 1)}${now.getFullYear()}-${pad(
    now.getHours()
  )}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-dexscreener-xrpl-top100-raw.json`;
}

async function main() {
  const limit = Number(getArg("--limit", "100"));
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error("--limit must be a positive number.");
  }

  const defaultOutput = path.join("data", "raw", "XRPL", toTimestampFilename());
  const outputPath = getArg("--out", defaultOutput);

  const xrplPairs = await fetchDexscreenerXrplPairs();

  const ranked = [...xrplPairs].sort((left, right) => {
    const leftTx = (left.txns?.h24?.buys ?? 0) + (left.txns?.h24?.sells ?? 0);
    const rightTx = (right.txns?.h24?.buys ?? 0) + (right.txns?.h24?.sells ?? 0);
    if (rightTx !== leftTx) {
      return rightTx - leftTx;
    }

    const leftVol = left.volume?.h24 ?? 0;
    const rightVol = right.volume?.h24 ?? 0;
    return rightVol - leftVol;
  });

  const selected = ranked.slice(0, limit).map(normalizePair);

  const output = {
    ok: true,
    data: selected
  };

  validateOutput(output);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");

  if (selected.length < limit) {
    console.warn(
      `Warning: requested ${limit} items but Dexscreener returned ${selected.length} XRPL pairs.`
    );
  }

  console.log(`Saved: ${outputPath}`);
  console.log(`Items: ${selected.length}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});