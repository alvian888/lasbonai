import { assertExecutionReady, config } from "../config.js";
import type { SwapBuildResult, TradingRequest } from "../types.js";
import type { ExecutionProvider } from "../executor.js";

interface AgenticWalletResponse {
  txHash?: string;
  data?: {
    txHash?: string;
  };
}

export class OkxAgenticWalletExecutor implements ExecutionProvider {
  readonly name = "okx-agentic-wallet" as const;

  async send(transaction: SwapBuildResult, request: TradingRequest) {
    assertExecutionReady();

    const response = await fetch(config.OKX_AGENTIC_WALLET_EXECUTE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.OKX_AGENTIC_WALLET_API_KEY}`
      },
      body: JSON.stringify({
        walletId: config.OKX_AGENTIC_WALLET_ID,
        subWalletId: config.OKX_AGENTIC_SUB_WALLET_ID || undefined,
        chainId: request.chainId,
        walletAddress: request.walletAddress,
        transaction: {
          to: transaction.to,
          data: transaction.data,
          value: transaction.value.toString(),
          gas: transaction.gas?.toString(),
          gasPrice: transaction.gasPrice?.toString()
        },
        metadata: {
          source: "okx-agentic-bot",
          baseTokenAddress: request.baseTokenAddress,
          quoteTokenAddress: request.quoteTokenAddress
        }
      })
    });

    const payload = (await response.json().catch(() => null)) as AgenticWalletResponse | null;

    if (!response.ok) {
      throw new Error(`OKX Agentic Wallet execution failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
    }

    const txHash = payload?.txHash ?? payload?.data?.txHash;
    if (!txHash) {
      throw new Error(
        "OKX Agentic Wallet response did not include txHash. Adjust src/executors/okx-agentic-wallet.ts to match your official endpoint schema."
      );
    }

    return txHash;
  }
}