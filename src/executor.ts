import { config } from "./config.js";
import { LocalWalletExecutor } from "./executors/local-wallet.js";
import { OkxAgenticWalletExecutor } from "./executors/okx-agentic-wallet.js";
import { OnchainosExecutor } from "./executors/onchainos.js";
import type { ExecutionProviderName, SwapBuildResult, TradingRequest } from "./types.js";

export interface ExecutionProvider {
  readonly name: ExecutionProviderName;
  send(transaction: SwapBuildResult, request: TradingRequest): Promise<string>;
}

export function createExecutionProvider(): ExecutionProvider {
  if (config.EXECUTION_PROVIDER === "local-wallet") {
    return new LocalWalletExecutor();
  }

  if (config.EXECUTION_PROVIDER === "onchainos") {
    return new OnchainosExecutor();
  }

  return new OkxAgenticWalletExecutor();
}