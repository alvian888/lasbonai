import * as fs from "node:fs";
import * as path from "node:path";

const CANDIDATES_PATH = path.resolve("data/bep20-candidates.latest.json");

/** Well-known BSC wrapped/pegged token addresses */
const WELL_KNOWN_BSC: Record<string, string> = {
  btc: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",   // BTCB
  btcb: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
  eth: "0x2170ed0880ac9a755fd29b2688956bd959f933f8",    // Binance-pegged ETH
  weth: "0x2170ed0880ac9a755fd29b2688956bd959f933f8",
  bnb: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",   // WBNB
  wbnb: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  usdt: "0x55d398326f99059ff775485246999027b3197955",
  usdc: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d",
  busd: "0xe9e7cea3dedca5984780bafc599bd69add087d56",
  cake: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82",
  xrp: "0x1d2f0da169ceb9fc7b3144628db156f3f6c60dbe",
  ada: "0x3ee2200efb3400fabb9aacf31297cbdd1d435d47",
  doge: "0xba2ae424d960c26247dd6c32edc70b295c744c43",
  sol: "0x570a5d26f7765ecb712c0924e4de545b89fd43df",
  dot: "0x7083609fce4d1d8dc0c979aab8c869ea2c873402",
  matic: "0xcc42724c6683b7e57334c4e856f4c9965ed682bd",
  link: "0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd",
  avax: "0x1ce0c2827e2ef14d5c4f29a091d735a204794041",
  uni: "0xbf5140a22578168fd562dccf235e5d43a02ce9b1",
  idrx: "0x649a2da7b28e0d54c13d5eff95d3a660652742cc",
};

/**
 * Resolve a token symbol to its BSC contract address.
 * Checks:  1) well-known BSC tokens  2) bep20-candidates.latest.json
 */
export function resolveTokenAddress(symbol: string): string | undefined {
  const key = symbol.toLowerCase().trim();

  // 1. Well-known tokens
  if (WELL_KNOWN_BSC[key]) return WELL_KNOWN_BSC[key];

  // 2. Candidates file (dynamic, refreshed by scanner)
  try {
    if (fs.existsSync(CANDIDATES_PATH)) {
      const data = JSON.parse(fs.readFileSync(CANDIDATES_PATH, "utf-8"));
      const match = (data.tokens ?? []).find(
        (t: { symbol: string; address: string }) =>
          t.symbol.toLowerCase() === key
      );
      if (match?.address) return match.address.toLowerCase();
    }
  } catch {
    // ignore read errors
  }

  return undefined;
}
