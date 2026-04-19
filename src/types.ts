export type TradeAction = "buy" | "sell" | "hold";

export interface TradingRequest {
  chainId: string;
  walletAddress: string;
  baseTokenAddress: string;
  quoteTokenAddress: string;
  buyAmount: string;
  sellAmount: string;
  slippage?: string;
  marketContext?: string;
  rsi?: number;
  macd?: number;
  macdSignal?: number;
  emaFast?: number;
  emaSlow?: number;
}

export interface QuoteSummary {
  fromTokenAddress: string;
  toTokenAddress: string;
  amountIn: string;
  amountOut: string;
  router?: string;
  raw: unknown;
}

export interface SwapBuildResult {
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gas?: bigint;
  gasPrice?: bigint;
  raw: unknown;
}

export type ExecutionProviderName = "local-wallet" | "okx-agentic-wallet" | "onchainos";

export interface AgentDecision {
  action: TradeAction;
  confidence: number;
  reasoning: string;
  riskNotes: string[];
  preferredAmount?: string;
}

export interface PositionSnapshot {
  baseTokenBalance: number;
  baseTokenValueUsd: number;
  quoteTokenBalance: number;
  costBasisUsd: number;
  unrealizedPnlPct: number;
}

export interface BotRunResult {
  dryRun: boolean;
  request: TradingRequest;
  buyQuote: QuoteSummary;
  sellQuote: QuoteSummary;
  position?: PositionSnapshot;
  baselineDecision?: AgentDecision;
  decision: AgentDecision;
  decisionSource?: "baseline" | "ai";
  executionProvider?: ExecutionProviderName;
  execution?: {
    mode: "preview" | "sent";
    txHash?: string;
    transaction?: Omit<SwapBuildResult, "raw">;
  };
}