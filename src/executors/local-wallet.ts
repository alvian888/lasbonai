import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertExecutionReady, config } from "../config.js";
import type { SwapBuildResult, TradingRequest } from "../types.js";
import type { ExecutionProvider } from "../executor.js";

export class LocalWalletExecutor implements ExecutionProvider {
  readonly name = "local-wallet" as const;

  async send(transaction: SwapBuildResult, _request: TradingRequest) {
    assertExecutionReady();

    const account = privateKeyToAccount(config.EXECUTION_WALLET_PRIVATE_KEY as `0x${string}`);
    const transport = http(config.EVM_RPC_URL);
    const walletClient = createWalletClient({ account, transport });
    const publicClient = createPublicClient({ transport });
    const feeData = await publicClient.estimateFeesPerGas().catch(() => ({}));
    const gasPrice =
      transaction.gasPrice ?? ("gasPrice" in feeData ? feeData.gasPrice : undefined);

    return walletClient.sendTransaction({
      chain: undefined,
      account,
      to: transaction.to,
      data: transaction.data,
      value: transaction.value,
      gas: transaction.gas,
      gasPrice
    });
  }
}