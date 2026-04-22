export interface NetworkConfig {
  key: string;
  label: string;
  okxAggregatorSupported: boolean;
  okxChainId?: string;
  onchainosChain?: string;
  fallbackUrl?: string;
}

import { readAnodosSessionStatus } from "./anodos-session-bridge.js";

export interface AnodosPortfolioHints {
  source: string;
  reachable: boolean;
  blocked: boolean;
  containsXrpl: boolean;
  matchedTokens: string[];
  note?: string;
}

const ANODOS_PORTFOLIO_URL = "https://dex.anodos.finance/portfolio";

const NETWORKS: Record<string, NetworkConfig> = {
  ethereum: {
    key: "ethereum",
    label: "Ethereum",
    okxAggregatorSupported: true,
    okxChainId: "1",
    onchainosChain: "ethereum",
  },
  bsc: {
    key: "bsc",
    label: "BNB Smart Chain",
    okxAggregatorSupported: true,
    okxChainId: "56",
    onchainosChain: "bsc",
  },
  base: {
    key: "base",
    label: "Base",
    okxAggregatorSupported: true,
    okxChainId: "8453",
    onchainosChain: "base",
  },
  polygon: {
    key: "polygon",
    label: "Polygon",
    okxAggregatorSupported: true,
    okxChainId: "137",
    onchainosChain: "polygon",
  },
  arbitrum: {
    key: "arbitrum",
    label: "Arbitrum",
    okxAggregatorSupported: true,
    okxChainId: "42161",
    onchainosChain: "arbitrum",
  },
  optimism: {
    key: "optimism",
    label: "Optimism",
    okxAggregatorSupported: true,
    okxChainId: "10",
    onchainosChain: "optimism",
  },
  avalanche: {
    key: "avalanche",
    label: "Avalanche",
    okxAggregatorSupported: true,
    okxChainId: "43114",
    onchainosChain: "avalanche",
  },
  xrpl: {
    key: "xrpl",
    label: "XRPL (Ripple)",
    okxAggregatorSupported: false,
    onchainosChain: "xrpl",
    fallbackUrl: ANODOS_PORTFOLIO_URL,
  },
};

const ALIASES: Record<string, string> = {
  "1": "ethereum",
  ethereum: "ethereum",
  eth: "ethereum",
  "56": "bsc",
  bnb: "bsc",
  bsc: "bsc",
  "8453": "base",
  base: "base",
  "137": "polygon",
  polygon: "polygon",
  matic: "polygon",
  "42161": "arbitrum",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  "10": "optimism",
  optimism: "optimism",
  op: "optimism",
  "43114": "avalanche",
  avalanche: "avalanche",
  avax: "avalanche",
  xrpl: "xrpl",
  ripple: "xrpl",
  xrp: "xrpl",
};

export function resolveNetworkConfig(raw: string): NetworkConfig {
  const normalized = (raw || "").trim().toLowerCase();
  const key = ALIASES[normalized];

  if (key && NETWORKS[key]) {
    return NETWORKS[key];
  }

  if (/^\d+$/.test(normalized)) {
    return {
      key: `evm-${normalized}`,
      label: `EVM Chain ${normalized}`,
      okxAggregatorSupported: true,
      okxChainId: normalized,
      onchainosChain: normalized,
    };
  }

  return {
    key: normalized || "unknown",
    label: raw || "Unknown network",
    okxAggregatorSupported: false,
    fallbackUrl: ANODOS_PORTFOLIO_URL,
  };
}

export function getAllNetworkConfigs(): NetworkConfig[] {
  return Object.values(NETWORKS);
}

export async function grepAnodosPortfolioHints(): Promise<AnodosPortfolioHints> {
  const bridged = await readAnodosSessionStatus();
  if (bridged) {
    return {
      source: bridged.source,
      reachable: bridged.reachable,
      blocked: bridged.blocked,
      containsXrpl: bridged.hasXrplHint,
      matchedTokens: bridged.hasXrplHint ? ["xrpl", "xrp", "ripple"] : [],
      note: "Using interactive browser-session bridge snapshot.",
    };
  }

  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(ANODOS_PORTFOLIO_URL, {
      signal: controller.signal,
      headers: { "User-Agent": "okx-agentic-bot/1.0" },
    });
    clearTimeout(timerId);

    const body = await response.text().catch(() => "");
    const lowered = body.toLowerCase();
    const blocked = lowered.includes("vercel security checkpoint");

    const tokens = new Set<string>();
    for (const re of [/xrpl/gi, /ripple/gi, /xrp/gi, /chainid/gi, /network/gi, /ledger/gi]) {
      const matches = body.match(re) || [];
      for (const m of matches) tokens.add(m.toLowerCase());
    }

    return {
      source: ANODOS_PORTFOLIO_URL,
      reachable: response.ok,
      blocked,
      containsXrpl: lowered.includes("xrpl") || lowered.includes("ripple") || lowered.includes("xrp"),
      matchedTokens: Array.from(tokens).slice(0, 20),
      note: blocked
        ? "Source reachable but protected by Vercel Security Checkpoint; use URL as manual fallback reference."
        : undefined,
    };
  } catch (error) {
    clearTimeout(timerId);
    return {
      source: ANODOS_PORTFOLIO_URL,
      reachable: false,
      blocked: false,
      containsXrpl: false,
      matchedTokens: [],
      note: error instanceof Error ? error.message : String(error),
    };
  }
}
